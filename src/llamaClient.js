const vscode = require('vscode');
const { getConfig, configuredBaseUrl, endpointFromBase, llamaCppEndpoint, openAiEndpoint } = require('./config');
const { requestJson, requestSse } = require('./http');

class LlamaClient {
  constructor(secrets, localServer, output) {
    this.secrets = secrets;
    this.localServer = localServer;
    this.output = output;
    this.apiKeySecret = 'llamaCpp.apiKey';
    this.ragApiKeySecret = 'llamaCpp.ragApiKey';
  }

  async setApiKey() { await this.setSecret(this.apiKeySecret, 'llama.cpp Assistant API Key', 'API key saved.'); }
  async clearApiKey() { await this.secrets.delete(this.apiKeySecret); vscode.window.showInformationMessage('llama.cpp Assistant: API key cleared.'); }
  async setRagApiKey() { await this.setSecret(this.ragApiKeySecret, 'llama.cpp RAG API Key', 'RAG API key saved. It is used for custom embedding/reranker servers.'); }
  async clearRagApiKey() { await this.secrets.delete(this.ragApiKeySecret); vscode.window.showInformationMessage('llama.cpp Assistant: RAG API key cleared.'); }

  async setSecret(key, title, success) {
    const value = await vscode.window.showInputBox({ title, prompt: 'Stored securely in VS Code SecretStorage.', password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.secrets.store(key, value.trim());
    vscode.window.showInformationMessage(`llama.cpp Assistant: ${success}`);
  }

  async testConnection() {
    await this.ensureReady();
    const config = getConfig();
    const data = await requestJson(openAiEndpoint('/v1/models', config), { method: 'GET', headers: await this.headers() }, config.request.timeoutMs);
    return (data?.data || []).map(x => x.id).filter(Boolean);
  }

  async complete(prefix, suffix, languageId, signal, extraFiles = []) {
    await this.ensureReady();
    const config = getConfig();
    const backend = config.autocomplete.backend === 'auto' ? (config.mode === 'local' ? 'fim' : 'openai') : config.autocomplete.backend;
    if (backend === 'fim') {
      const body = { input_prefix: prefix, input_suffix: suffix, input_extra: extraFiles, prompt: `Continue the ${languageId} code at the cursor. Return only code to insert.`, n_predict: config.autocomplete.maxTokens, temperature: config.autocomplete.temperature, stream: false, cache_prompt: true };
      if (String(config.api.model).trim()) body.model = String(config.api.model).trim();
      const data = await requestJson(llamaCppEndpoint('/infill', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
      return cleanCompletion(data?.content || data?.choices?.[0]?.text || '');
    }
    const repositoryContext = extraFiles.length ? ['Repository context:', ...extraFiles.map(file => `\n--- ${file.filename} ---\n${file.text}`), '\nEnd repository context.\n'] : [];
    const prompt = [`You are a code completion engine for ${languageId}.`, 'Return only the exact code that should be inserted at <CURSOR>.', 'Do not use Markdown fences and do not explain.', ...repositoryContext, '', prefix, '<CURSOR>', suffix].join('\n');
    const body = { prompt, max_tokens: config.autocomplete.maxTokens, temperature: config.autocomplete.temperature, stream: false, stop: ['<CURSOR>', '\n\n\n'] };
    if (String(config.api.model).trim()) body.model = String(config.api.model).trim();
    const data = await requestJson(openAiEndpoint('/v1/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    return cleanCompletion(data?.choices?.[0]?.text || data?.content || '');
  }

  async chat(messages, signal) {
    await this.ensureReady();
    const config = getConfig();
    const body = this.chatBody(messages, false, config);
    const data = await requestJson(openAiEndpoint('/v1/chat/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    return extractFullChatContent(data);
  }

  async chatStream(messages, signal, onDelta) {
    await this.ensureReady();
    const config = getConfig();
    const body = this.chatBody(messages, true, config);
    let full = '';
    await requestSse(openAiEndpoint('/v1/chat/completions', config), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal, async event => {
      const delta = extractStreamDelta(event);
      if (delta) { full += delta; await onDelta(delta); return; }
      if (!full && event && typeof event === 'object') {
        const fallback = extractFullChatContent(event);
        if (fallback) { full += fallback; await onDelta(fallback); }
      }
    });
    return full.trim();
  }

  chatBody(messages, stream, config) {
    const body = { messages, max_tokens: config.chat.maxTokens, temperature: config.chat.temperature, stream };
    if (String(config.api.model).trim()) body.model = String(config.api.model).trim();
    return body;
  }

  async embed(inputs, signal) {
    const config = getConfig();
    if (!config.rag.embedding.enabled) throw new Error('Vector embeddings are disabled in settings.');
    const values = Array.isArray(inputs) ? inputs.map(String) : [String(inputs)];
    if (!values.length) return [];
    const customBase = String(config.rag.embedding.baseUrl || '').trim();
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

  async ensureReady() { if (getConfig().mode === 'local') await this.localServer.ensureReady(); }
  async headers() { const apiKey = await this.secrets.get(this.apiKeySecret); return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}; }
  async ragHeaders() { const ragKey = await this.secrets.get(this.ragApiKeySecret); return ragKey ? { Authorization: `Bearer ${ragKey}` } : this.headers(); }
  logError(prefix, error) { const message = error instanceof Error ? (error.stack || error.message) : String(error); this.output.appendLine(`[${prefix}] ${message}`); }
}

function extractStreamDelta(data) { if (!data || typeof data !== 'object') return ''; const choice = data.choices?.[0]; return normalizeContent(choice?.delta?.content ?? choice?.text ?? data.content); }
function extractFullChatContent(data) { return normalizeContent(data?.choices?.[0]?.message?.content ?? data?.content).trim(); }
function normalizeContent(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join(''); return ''; }
function normalizeVector(vector) { if (!Array.isArray(vector)) return []; const numbers = vector.map(Number).filter(Number.isFinite); if (!numbers.length) return []; const norm = Math.sqrt(numbers.reduce((sum, value) => sum + value * value, 0)); return norm ? numbers.map(value => value / norm) : numbers; }
function numberOr(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return 0; }
function cleanCompletion(text) { return String(text).replace(/^```[\w+-]*\s*/i, '').replace(/```\s*$/i, '').replace(/^<CURSOR>/, ''); }

module.exports = { LlamaClient, extractStreamDelta, normalizeVector };
