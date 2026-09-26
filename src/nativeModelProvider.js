const vscode = require('vscode');

const VENDOR = 'g4b3r-llamacpp';

class LlamaLanguageModelProvider {
  constructor(client) {
    this.client = client;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  }

  dispose() { this.changeEmitter.dispose(); }
  refresh() { this.changeEmitter.fire(); }

  async provideLanguageModelChatInformation(options, token) {
    try {
      const models = await this.client.listModels(toAbortSignal(token));
      return modelInfos(models);
    } catch (error) {
      if (!options?.silent) this.client.logError('native model discovery', error);
      const configured = String(require('./config').getConfig().api.model || '').trim();
      return configured ? modelInfos([configured]) : [];
    }
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const converted = messages.map(convertMessage).filter(Boolean);
      await this.client.chatStream(
        converted,
        controller.signal,
        delta => {
          if (delta) progress.report(new vscode.LanguageModelTextPart(delta));
        },
        { model: model.id }
      );
    } finally {
      subscription.dispose();
    }
  }

  async provideTokenCount(model, input) {
    const text = typeof input === 'string' ? input : extractMessageText(input);
    return Math.max(1, Math.ceil(String(text || '').length / 4));
  }
}

function modelInfos(models) {
  const unique = [...new Set((models || []).map(String).map(x => x.trim()).filter(Boolean))];
  return unique.map(id => ({
    id,
    name: id,
    family: inferFamily(id),
    version: '1',
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    detail: 'llama.cpp',
    tooltip: `Model served by llama.cpp: ${id}`,
    capabilities: { imageInput: false, toolCalling: false }
  }));
}

function inferFamily(id) {
  const value = String(id).toLowerCase();
  if (value.includes('qwen')) return 'qwen';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('mistral') || value.includes('mixtral')) return 'mistral';
  if (value.includes('gemma')) return 'gemma';
  if (value.includes('phi')) return 'phi';
  return 'llama';
}

function convertMessage(message) {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
  const content = extractMessageText(message);
  return content ? { role, content } : undefined;
}

function extractMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.value === 'string') return part.value;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
}

function toAbortSignal(token) {
  const controller = new AbortController();
  if (token?.isCancellationRequested) controller.abort();
  else token?.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

module.exports = { LlamaLanguageModelProvider, VENDOR };
