const vscode = require('vscode');
const { getConfig, endpointFromBase } = require('../config');
const { requestJson, requestSse } = require('../http');
const { toResponsesInput, extractResponseText } = require('./responseUtils');

class OpenAIClient {
  constructor(secrets, output, metricsSink) {
    this.secrets = secrets;
    this.output = output;
    this.metricsSink = metricsSink;
    this.apiKeySecret = 'llamaCpp.openaiApiKey';
  }

  async setApiKey() {
    const value = await vscode.window.showInputBox({ title: 'OpenAI API Key', prompt: 'Stored securely in VS Code SecretStorage.', password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.secrets.store(this.apiKeySecret, value.trim());
    vscode.window.showInformationMessage('llama.cpp Assistant: OpenAI API key saved.');
  }

  async clearApiKey() {
    await this.secrets.delete(this.apiKeySecret);
    vscode.window.showInformationMessage('llama.cpp Assistant: OpenAI API key cleared.');
  }

  async headers() {
    const apiKey = await this.secrets.get(this.apiKeySecret);
    if (!apiKey) throw new Error('OpenAI API key is not configured. Run "Llama.cpp: Set OpenAI API Key".');
    return { Authorization: `Bearer ${apiKey}` };
  }

  endpoint(path) {
    const config = getConfig();
    return endpointFromBase(config.openai.baseUrl, path.startsWith('/v1/') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`);
  }

  async listModels(signal) {
    const config = getConfig();
    const data = await requestJson(this.endpoint('/models'), { method: 'GET', headers: await this.headers() }, config.request.timeoutMs, signal);
    const discovered = (data?.data || []).map(item => item?.id).filter(isUsefulModel);
    const configured = String(config.openai.model || '').trim();
    const preferred = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    return [...new Set([configured, ...preferred, ...discovered].filter(Boolean))];
  }

  async chat(messages, signal, options = {}) {
    const config = getConfig();
    const startedAt = Date.now();
    const data = await requestJson(this.endpoint('/responses'), { method: 'POST', headers: await this.headers(), body: JSON.stringify(this.responseBody(messages, false, options)) }, config.request.timeoutMs, signal);
    this.metricsSink?.emitMetrics('chat', startedAt, Date.now(), normalizeUsagePayload(data));
    return extractResponseText(data).trim();
  }

  async chatStream(messages, signal, onDelta, options = {}) {
    const config = getConfig();
    const startedAt = Date.now();
    let firstTokenAt;
    let full = '';
    let completed;
    await requestSse(this.endpoint('/responses'), { method: 'POST', headers: await this.headers(), body: JSON.stringify(this.responseBody(messages, true, options)) }, config.request.timeoutMs, signal, async event => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        if (!firstTokenAt) firstTokenAt = Date.now();
        full += event.delta;
        await onDelta(event.delta);
      } else if (event.type === 'response.completed' && event.response) {
        completed = event.response;
      } else if (event.type === 'error') {
        throw new Error(event.message || 'OpenAI streaming error.');
      }
    });
    this.metricsSink?.emitMetrics('chat', startedAt, firstTokenAt || Date.now(), normalizeUsagePayload(completed), { generatedText: full });
    return full.trim();
  }

  responseBody(messages, stream, options = {}) {
    const config = getConfig();
    const body = {
      model: String(options.model || config.openai.model || 'gpt-5.6-luna').trim(),
      input: toResponsesInput(messages),
      max_output_tokens: Math.max(1, Number(options.maxTokens || config.chat.maxTokens)),
      stream,
      store: Boolean(config.openai.store)
    };
    const effort = String(options.reasoningEffort ?? config.openai.reasoningEffort ?? '').trim();
    if (effort) body.reasoning = { effort };
    return body;
  }

  async complete(prefix, suffix, languageId, signal, extraFiles = [], options = {}) {
    const config = getConfig();
    if (!config.openai.useForAutocomplete) return '';
    const repositoryContext = extraFiles.length ? ['Repository context:', ...extraFiles.map(file => `\n--- ${file.filename} ---\n${file.text}`), '\nEnd repository context.\n'] : [];
    const prompt = [`You are a code completion engine for ${languageId}.`, 'Return only the exact code that should be inserted at <CURSOR>.', 'Do not use Markdown fences and do not explain.', ...repositoryContext, '', prefix, '<CURSOR>', suffix].join('\n');
    const startedAt = Date.now();
    const body = {
      model: String(options.model || config.openai.model || 'gpt-5.6-luna').trim(),
      input: [{ role: 'developer', content: 'Return only code to insert at the cursor.' }, { role: 'user', content: prompt }],
      max_output_tokens: Math.max(1, Number(options.maxTokens || config.autocomplete.maxTokens)),
      reasoning: { effort: 'none' },
      store: false
    };
    const data = await requestJson(this.endpoint('/responses'), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    this.metricsSink?.emitMetrics('autocomplete', startedAt, Date.now(), normalizeUsagePayload(data));
    return cleanCompletion(extractResponseText(data));
  }

  async embed(inputs, signal) {
    const config = getConfig();
    const values = Array.isArray(inputs) ? inputs.map(String) : [String(inputs)];
    if (!values.length) return [];
    const body = { model: String(config.openai.embeddingModel || 'text-embedding-3-small'), input: values };
    const data = await requestJson(this.endpoint('/embeddings'), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    const items = Array.isArray(data?.data) ? [...data.data].sort((a,b)=>(a?.index??0)-(b?.index??0)) : [];
    const vectors = items.map(item => normalizeVector(item?.embedding));
    if (vectors.length !== values.length || vectors.some(vector => !vector.length)) throw new Error(`OpenAI embeddings returned ${vectors.length} vectors for ${values.length} inputs.`);
    return vectors;
  }
}

function normalizeUsagePayload(data) {
  if (!data) return undefined;
  const usage = data.usage || {};
  return {
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens }
    }
  };
}

function isUsefulModel(id) {
  const value = String(id || '').toLowerCase();
  return /^(gpt-|o\d|chat-)/.test(value) && !/(realtime|audio|transcribe|tts|image|embedding)/.test(value);
}

function normalizeVector(vector) {
  if (!Array.isArray(vector)) return [];
  const numbers = vector.map(Number).filter(Number.isFinite);
  if (!numbers.length) return [];
  const norm = Math.sqrt(numbers.reduce((sum, value) => sum + value * value, 0));
  return norm ? numbers.map(value => value / norm) : numbers;
}

function cleanCompletion(text) { return String(text || '').replace(/^```[\w+-]*\s*/i, '').replace(/```\s*$/i, '').replace(/^<CURSOR>/, ''); }

module.exports = { OpenAIClient, normalizeUsagePayload, isUsefulModel };
