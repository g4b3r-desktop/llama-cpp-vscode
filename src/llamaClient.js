const vscode = require('vscode');
const { getConfig, configuredBaseUrl, endpointFromBase, llamaCppEndpoint, openAiEndpoint } = require('./config');
const { requestJson, requestSse } = require('./http');
const { OpenAIClient } = require('./openai/OpenAIClient');
const { ContextBudgetManager, extractLlamaContextWindow, parseContextSizeArgs } = require('./context/ContextBudgetManager');

class LlamaClient {
  constructor(secrets, localServer, output) {
    this.secrets = secrets;
    this.localServer = localServer;
    this.output = output;
    this.apiKeySecret = 'llamaCpp.apiKey';
    this.ragApiKeySecret = 'llamaCpp.ragApiKey';
    this.metricsEmitter = new vscode.EventEmitter();
    this.onMetrics = this.metricsEmitter.event;
    this.lastMetrics = undefined;
    this.lastContextBudget = undefined;
    this.contextWindowCache = undefined;
    this.inputTokenCounterUnavailable = new Set();
    this.openai = new OpenAIClient(secrets, output, this);
  }

  dispose() { this.metricsEmitter.dispose(); }
  async setApiKey() { await this.setSecret(this.apiKeySecret, 'llama.cpp Assistant API Key', 'llama.cpp/API-compatible key saved.'); }
  async clearApiKey() { await this.secrets.delete(this.apiKeySecret); vscode.window.showInformationMessage('llama.cpp Assistant: llama.cpp/API-compatible key cleared.'); }
  async setOpenAIApiKey() { await this.openai.setApiKey(); }
  async clearOpenAIApiKey() { await this.openai.clearApiKey(); }
  async setRagApiKey() { await this.setSecret(this.ragApiKeySecret, 'llama.cpp RAG API Key', 'RAG API key saved. It is used for custom embedding/reranker servers.'); }
  async clearRagApiKey() { await this.secrets.delete(this.ragApiKeySecret); vscode.window.showInformationMessage('llama.cpp Assistant: RAG API key cleared.'); }

  async setSecret(key, title, success) {
    const value = await vscode.window.showInputBox({ title, prompt: 'Stored securely in VS Code SecretStorage.', password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.secrets.store(key, value.trim());
    vscode.window.showInformationMessage(`llama.cpp Assistant: ${success}`);
  }

  async listModels(signal) {
    const config = getConfig();
    if (config.provider === 'openai') return this.openai.listModels(signal);
    await this.ensureReady();
    const data = await requestJson(openAiEndpoint('/v1/models', config), { method: 'GET', headers: await this.headers() }, config.request.timeoutMs, signal);
    const discovered = (data?.data || []).map(x => x?.id).filter(Boolean);
    const configured = String(config.api.model || '').trim();
    return [...new Set([configured, ...discovered].filter(Boolean))];
  }

  async testConnection() { return this.listModels(); }

  async getContextWindowInfo(signal) {
    const config = getConfig();
    const override = Math.floor(Number(config.context.windowTokens || 0));
    if (override > 0) return { tokens: override, source: 'settings' };

    if (config.provider === 'openai') {
      return { tokens: Math.max(256, Math.floor(Number(config.context.openAIContextWindowTokens || 128000))), source: 'OpenAI fallback' };
    }

    await this.ensureReady();
    const key = configuredBaseUrl(config);
    if (this.contextWindowCache?.key === key && this.contextWindowCache.expiresAt > Date.now()) return this.contextWindowCache.value;

    try {
      const props = await requestJson(llamaCppEndpoint('/props', config), { method: 'GET', headers: await this.headers() }, Math.min(config.request.timeoutMs, 5000), signal);
      const detected = extractLlamaContextWindow(props);
      if (detected) {
        const value = { tokens: detected, source: 'llama.cpp /props' };
        this.contextWindowCache = { key, value, expiresAt: Date.now() + 60000 };
        return value;
      }
    } catch (error) {
      this.output.appendLine(`[context] /props unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const fromArgs = config.mode === 'local' ? parseContextSizeArgs(config.local.args) : undefined;
    const fallback = Math.max(256, Math.floor(Number(config.context.llamaCppFallbackTokens || 4096)));
    const value = { tokens: fromArgs || fallback, source: fromArgs ? 'local --ctx-size' : 'llama.cpp fallback' };
    this.contextWindowCache = { key, value, expiresAt: Date.now() + 30000 };
    return value;
  }

  async countChatInputTokens(messages, tools = [], options = {}, signal) {
    const config = getConfig();
    if (config.provider === 'openai') return undefined;
    await this.ensureReady();
    const key = configuredBaseUrl(config);
    if (this.inputTokenCounterUnavailable.has(key)) return undefined;
    const body = { messages };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }
    const selectedModel = String(options.model || config.api.model || '').trim();
    if (selectedModel) body.model = selectedModel;
    try {
      const data = await requestJson(llamaCppEndpoint('/v1/chat/completions/input_tokens', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, Math.min(config.request.timeoutMs, 10000), signal);
      const value = Number(data?.input_tokens);
      return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
    } catch (error) {
      this.inputTokenCounterUnavailable.add(key);
      this.output.appendLine(`[context] exact input-token count unavailable; using conservative estimate: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async prepareContext(messages, options = {}, signal) {
    const config = getConfig();
    const mode = options.mode === 'agent' ? 'agent' : 'chat';
    const requestedOutputTokens = Math.max(1, Math.floor(Number(options.maxOutputTokens || (mode === 'agent' ? config.agent.maxTokensPerStep : config.chat.maxTokens))));
    if (config.context.enabled === false) {
      const stats = { disabled: true, trimmed: false, maxOutputTokens: requestedOutputTokens };
      this.lastContextBudget = stats;
      return { messages, maxOutputTokens: requestedOutputTokens, stats };
    }

    const info = await this.getContextWindowInfo(signal);
    const tools = Array.isArray(options.tools) ? options.tools : [];
    const manager = new ContextBudgetManager(config.context);
    const result = await manager.fit({
      messages,
      tools,
      contextWindowTokens: info.tokens,
      requestedOutputTokens,
      mode,
      countTokens: config.provider === 'openai' ? undefined : candidate => this.countChatInputTokens(candidate, tools, options, signal)
    });
    result.stats.source = info.source;
    this.lastContextBudget = result.stats;
    this.output.appendLine(`[context:${mode}] n_ctx=${result.stats.contextWindowTokens} input=${result.stats.inputTokens}/${result.stats.inputBudgetTokens} output=${result.maxOutputTokens} source=${info.source} trimmed=${result.stats.trimmed}`);
    return result;
  }

  async complete(prefix, suffix, languageId, signal, extraFiles = [], options = {}) {
    const config = getConfig();
    if (config.provider === 'openai') return this.openai.complete(prefix, suffix, languageId, signal, extraFiles, options);
    await this.ensureReady();
    const startedAt = Date.now();
    const backend = config.autocomplete.backend === 'auto' ? (config.mode === 'local' ? 'fim' : 'openai') : config.autocomplete.backend;
    const maxTokens = Math.max(1, Number(options.maxTokens || config.autocomplete.maxTokens));
    const maxPredictMs = Math.max(0, Number(options.maxPredictMs ?? config.autocomplete.maxPredictMs));
    let data;

    if (backend === 'fim') {
      const body = {
        input_prefix: prefix,
        input_suffix: suffix,
        input_extra: extraFiles,
        prompt: `Continue the ${languageId} code at the cursor. Return only code to insert.`,
        n_predict: maxTokens,
        temperature: config.autocomplete.temperature,
        stream: false,
        cache_prompt: true,
        timings_per_token: true
      };
      if (maxPredictMs > 0) body.t_max_predict_ms = maxPredictMs;
      const selectedModel = String(options.model || config.api.model || '').trim();
      if (selectedModel) body.model = selectedModel;
      data = await requestJson(llamaCppEndpoint('/infill', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
      this.emitMetrics('autocomplete', startedAt, Date.now(), data);
      return cleanCompletion(data?.content || data?.choices?.[0]?.text || '');
    }

    const repositoryContext = extraFiles.length ? ['Repository context:', ...extraFiles.map(file => `\n--- ${file.filename} ---\n${file.text}`), '\nEnd repository context.\n'] : [];
    const prompt = [`You are a code completion engine for ${languageId}.`, 'Return only the exact code that should be inserted at <CURSOR>.', 'Do not use Markdown fences and do not explain.', ...repositoryContext, '', prefix, '<CURSOR>', suffix].join('\n');
    const body = { prompt, max_tokens: maxTokens, temperature: config.autocomplete.temperature, stream: false, stop: ['<CURSOR>', '\n\n\n'] };
    if (config.mode === 'local') body.cache_prompt = true;
    const selectedModel = String(options.model || config.api.model || '').trim();
    if (selectedModel) body.model = selectedModel;
    data = await requestJson(openAiEndpoint('/v1/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    this.emitMetrics('autocomplete', startedAt, Date.now(), data);
    return cleanCompletion(data?.choices?.[0]?.text || data?.content || '');
  }

  async chat(messages, signal, options = {}) {
    const config = getConfig();
    const prepared = await this.prepareContext(messages, { ...options, mode: 'chat', maxOutputTokens: options.maxTokens || config.chat.maxTokens }, signal);
    const finalOptions = { ...options, maxTokens: prepared.maxOutputTokens };
    if (config.provider === 'openai') return this.openai.chat(prepared.messages, signal, finalOptions);
    await this.ensureReady();
    const startedAt = Date.now();
    const body = this.chatBody(prepared.messages, false, config, finalOptions);
    const data = await requestJson(openAiEndpoint('/v1/chat/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    this.emitMetrics('chat', startedAt, Date.now(), data);
    return extractFullChatContent(data);
  }

  async chatStream(messages, signal, onDelta, options = {}) {
    const config = getConfig();
    const prepared = await this.prepareContext(messages, { ...options, mode: 'chat', maxOutputTokens: options.maxTokens || config.chat.maxTokens }, signal);
    const finalOptions = { ...options, maxTokens: prepared.maxOutputTokens };
    if (config.provider === 'openai') return this.openai.chatStream(prepared.messages, signal, onDelta, finalOptions);
    await this.ensureReady();
    const body = this.chatBody(prepared.messages, true, config, finalOptions);
    const startedAt = Date.now();
    let firstTokenAt;
    let full = '';
    let statsEvent;
    await requestSse(openAiEndpoint('/v1/chat/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal, async event => {
      if (event && typeof event === 'object' && (event.timings || event.usage)) statsEvent = mergeStatsEvents(statsEvent, event);
      const delta = extractStreamDelta(event);
      if (delta) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        full += delta;
        await onDelta(delta);
        return;
      }
      if (!full && event && typeof event === 'object') {
        const fallback = extractFullChatContent(event);
        if (fallback) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          full += fallback;
          await onDelta(fallback);
        }
      }
    });
    this.emitMetrics('chat', startedAt, firstTokenAt || Date.now(), statsEvent, { generatedText: full });
    return full.trim();
  }

  chatBody(messages, stream, config, options = {}) {
    const body = { messages, max_tokens: options.maxTokens || config.chat.maxTokens, temperature: options.temperature ?? config.chat.temperature, stream };
    if (stream) body.stream_options = { include_usage: true };
    if (config.mode === 'local') body.cache_prompt = true;
    const selectedModel = String(options.model || config.api.model || '').trim();
    if (selectedModel) body.model = selectedModel;
    return body;
  }

  emitMetrics(kind, startedAt, firstTokenAt, payload, fallback = {}) {
    const timings = payload?.timings || {};
    const usage = payload?.usage || {};
    const promptTokens = finiteOrUndefined(timings.prompt_n, usage.prompt_tokens);
    const predictedTokens = finiteOrUndefined(timings.predicted_n, usage.completion_tokens, estimateGeneratedTokens(fallback.generatedText));
    const cacheTokens = finiteOrUndefined(timings.cache_n, usage?.prompt_tokens_details?.cached_tokens);
    const cacheKnown = Number.isFinite(cacheTokens);
    const metrics = {
      kind,
      timestamp: Date.now(),
      ttftMs: Math.max(0, firstTokenAt - startedAt),
      totalMs: Math.max(0, Date.now() - startedAt),
      promptTps: finiteOrUndefined(timings.prompt_per_second, rateFromMs(promptTokens, timings.prompt_ms)),
      generationTps: finiteOrUndefined(timings.predicted_per_second, rateFromMs(predictedTokens, timings.predicted_ms)),
      promptTokens,
      predictedTokens,
      cacheTokens,
      cacheHit: cacheKnown ? cacheTokens > 0 : undefined
    };
    this.lastMetrics = metrics;
    this.metricsEmitter.fire(metrics);
    const cache = metrics.cacheHit === true ? `hit:${metrics.cacheTokens}` : metrics.cacheHit === false ? 'miss' : 'unknown';
    this.output.appendLine(`[perf:${kind}] ttft=${Math.round(metrics.ttftMs)}ms total=${Math.round(metrics.totalMs)}ms prompt_tps=${fmt(metrics.promptTps)} gen_tps=${fmt(metrics.generationTps)} cache=${cache}`);
  }

  async embed(inputs, signal) {
    const config = getConfig();
    if (!config.rag.embedding.enabled) throw new Error('Vector embeddings are disabled in settings.');
    const values = Array.isArray(inputs) ? inputs.map(String) : [String(inputs)];
    if (!values.length) return [];
    const customBase = String(config.rag.embedding.baseUrl || '').trim();
    if (!customBase && config.provider === 'openai') {
      if (!config.openai.useForEmbeddings) throw new Error('OpenAI embeddings are disabled. Enable llamaCpp.openai.useForEmbeddings or configure a separate RAG embedding endpoint.');
      return this.openai.embed(values, signal);
    }
    if (!customBase) await this.ensureReady();
    const base = customBase || configuredBaseUrl(config);
    const body = { input: values };
    const model = String(config.rag.embedding.model || '').trim();
    if (model) body.model = model;
    const data = await requestJson(endpointFromBase(base, '/v1/embeddings'), { method: 'POST', headers: await this.ragHeaders(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    const items = Array.isArray(data?.data) ? [...data.data] : [];
    items.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    const vectors = items.map(item => normalizeVector(item?.embedding));
    if (vectors.length !== values.length || vectors.some(v => !v.length)) throw new Error(`Embeddings endpoint returned ${vectors.length} vectors for ${values.length} inputs.`);
    return vectors;
  }

  async rerank(query, documents, signal) {
    const config = getConfig();
    if (!config.rag.rerank.enabled || !documents.length) return undefined;
    const customBase = String(config.rag.rerank.baseUrl || '').trim();
    if (!customBase && config.provider === 'openai') return undefined;
    if (!customBase) await this.ensureReady();
    const base = customBase || configuredBaseUrl(config);
    const body = { query: String(query), documents: documents.map(String), top_n: Math.min(documents.length, Math.max(1, config.rag.rerank.candidates)) };
    const model = String(config.rag.rerank.model || '').trim();
    if (model) body.model = model;
    const data = await requestJson(endpointFromBase(base, '/v1/rerank'), { method: 'POST', headers: await this.ragHeaders(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    const rows = Array.isArray(data) ? data : (data?.results || data?.data || data?.rankings || []);
    const normalized = rows.map((row, order) => ({ index: Number.isInteger(row?.index) ? row.index : (Number.isInteger(row?.document_index) ? row.document_index : order), score: numberOr(row?.relevance_score, row?.score, row?.similarity, 0) })).filter(row => row.index >= 0 && row.index < documents.length);
    return normalized.length ? normalized : undefined;
  }

  async ensureReady() { const config = getConfig(); if (config.provider !== 'openai' && config.mode === 'local') await this.localServer.ensureReady(); }
  async headers() { const apiKey = await this.secrets.get(this.apiKeySecret); return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}; }
  async ragHeaders() { const ragKey = await this.secrets.get(this.ragApiKeySecret); if (ragKey) return { Authorization: `Bearer ${ragKey}` }; return getConfig().provider === 'openai' ? {} : this.headers(); }
  logError(prefix, error) { const message = error instanceof Error ? (error.stack || error.message) : String(error); this.output.appendLine(`[${prefix}] ${message}`); }
}

function mergeStatsEvents(previous, event) {
  if (!previous) return event;
  return {
    ...previous,
    ...event,
    timings: { ...(previous.timings || {}), ...(event.timings || {}) },
    usage: { ...(previous.usage || {}), ...(event.usage || {}), prompt_tokens_details: { ...(previous.usage?.prompt_tokens_details || {}), ...(event.usage?.prompt_tokens_details || {}) } }
  };
}
function rateFromMs(tokens, ms) { return Number.isFinite(tokens) && Number.isFinite(Number(ms)) && Number(ms) > 0 ? tokens * 1000 / Number(ms) : undefined; }
function finiteOrUndefined(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return undefined; }
function estimateGeneratedTokens(text) { if (!text) return undefined; return Math.max(1, Math.round(String(text).length / 4)); }
function fmt(value) { return Number.isFinite(value) ? value.toFixed(2) : 'n/a'; }
function extractStreamDelta(data) { if (!data || typeof data !== 'object') return ''; const choice = data.choices?.[0]; return normalizeContent(choice?.delta?.content ?? choice?.text ?? data.content); }
function extractFullChatContent(data) { return normalizeContent(data?.choices?.[0]?.message?.content ?? data?.content).trim(); }
function normalizeContent(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join(''); return ''; }
function normalizeVector(vector) { if (!Array.isArray(vector)) return []; const numbers = vector.map(Number).filter(Number.isFinite); if (!numbers.length) return []; const norm = Math.sqrt(numbers.reduce((sum, value) => sum + value * value, 0)); return norm ? numbers.map(value => value / norm) : numbers; }
function numberOr(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return 0; }
function cleanCompletion(text) { return String(text).replace(/^```[\w+-]*\s*/i, '').replace(/```\s*$/i, '').replace(/^<CURSOR>/, ''); }

module.exports = { LlamaClient, extractStreamDelta, normalizeVector };
