const vscode = require('vscode');
const { getConfig } = require('./config');

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
    const config = getConfig();
    try {
      const models = await this.client.listModels(toAbortSignal(token));
      return modelInfos(models, config.provider);
    } catch (error) {
      if (!options?.silent) this.client.logError('native model discovery', error);
      const configured = String(config.provider === 'openai' ? config.openai.model : config.api.model || '').trim();
      return configured ? modelInfos([configured], config.provider) : [];
    }
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const converted = messages.map(convertMessage).filter(Boolean);
      await this.client.chatStream(converted, controller.signal, delta => { if (delta) progress.report(new vscode.LanguageModelTextPart(delta)); }, { model: model.id });
    } finally { subscription.dispose(); }
  }

  async provideTokenCount(model, input) {
    const text = typeof input === 'string' ? input : extractMessageText(input);
    return Math.max(1, Math.ceil(String(text || '').length / 4));
  }
}

function modelInfos(models, provider = 'llamacpp') {
  const unique = [...new Set((models || []).map(String).map(x => x.trim()).filter(Boolean))];
  const isOpenAI = provider === 'openai';
  return unique.map(id => ({
    id,
    name: id,
    family: isOpenAI ? inferOpenAIFamily(id) : inferFamily(id),
    version: '1',
    maxInputTokens: isOpenAI ? 1000000 : 32768,
    maxOutputTokens: isOpenAI ? 128000 : 8192,
    detail: isOpenAI ? 'OpenAI API' : 'llama.cpp',
    tooltip: isOpenAI ? `Model via OpenAI Responses API: ${id}` : `Model served by llama.cpp: ${id}`,
    capabilities: { imageInput: false, toolCalling: false }
  }));
}

function inferOpenAIFamily(id) { const value=String(id).toLowerCase(); if(value.includes('gpt-5.6'))return'gpt-5.6'; if(value.startsWith('gpt-'))return'gpt'; if(value.startsWith('o'))return'o-series'; return'openai'; }
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
function extractMessageText(message) { const content=Array.isArray(message?.content)?message.content:[];return content.map(part=>{if(typeof part==='string')return part;if(typeof part?.value==='string')return part.value;if(typeof part?.text==='string')return part.text;return'';}).join(''); }
function toAbortSignal(token) { const controller=new AbortController();if(token?.isCancellationRequested)controller.abort();else token?.onCancellationRequested(()=>controller.abort());return controller.signal; }
module.exports = { LlamaLanguageModelProvider, VENDOR, modelInfos };
