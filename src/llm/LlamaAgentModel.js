const crypto = require('crypto');
const { AgentModel } = require('./AgentModel');
const { getConfig, openAiEndpoint } = require('../config');
const { requestJson } = require('../http');

class LlamaAgentModel extends AgentModel {
  constructor(client) { super(); this.client = client; }
  async next({ messages, tools = [], signal, model }) {
    await this.client.ensureReady();
    const config = getConfig();
    const prepared = await this.client.prepareContext(messages, { mode: 'agent', tools, maxOutputTokens: config.agent.maxTokensPerStep, model }, signal);
    const startedAt = Date.now();
    const body = {
      messages: prepared.messages,
      max_tokens: prepared.maxOutputTokens,
      temperature: config.agent.temperature,
      stream: false
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }
    if (config.mode === 'local') body.cache_prompt = true;
    const selectedModel = String(model || config.api.model || '').trim();
    if (selectedModel) body.model = selectedModel;
    const data = await requestJson(openAiEndpoint('/v1/chat/completions', config), { method: 'POST', headers: await this.client.headers(), body: JSON.stringify(body) }, config.request.timeoutMs, signal);
    this.client.emitMetrics(tools.length ? 'agent' : 'agent-plan', startedAt, Date.now(), data);
    const message = data?.choices?.[0]?.message || {};
    const content = normalizeContent(message.content ?? data?.content).trim();
    const nativeCalls = normalizeToolCalls(message.tool_calls || data?.tool_calls || []);
    if (nativeCalls.length) return { content, toolCalls: nativeCalls, assistantMessage: normalizeAssistantMessage(message, nativeCalls) };
    const fallback = tools.length ? parseFallbackToolCall(content) : undefined;
    if (fallback) return { content: '', toolCalls: [fallback], assistantMessage: { role: 'assistant', content: '', tool_calls: [toWireToolCall(fallback)] } };
    return { content, toolCalls: [], assistantMessage: { role: 'assistant', content } };
  }
}
function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls.map(call => { const fn = call?.function || {}; return { id: String(call?.id || `call_${crypto.randomBytes(6).toString('hex')}`), name: String(fn.name || call?.name || ''), arguments: parseArguments(fn.arguments ?? call?.arguments) }; }).filter(call => call.name);
}
function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return JSON.parse(value); } catch { return { _raw: value }; }
}
function parseFallbackToolCall(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  if (!text.startsWith('{')) return undefined;
  try { const parsed = JSON.parse(text); const name = parsed.tool || parsed.name; const args = parsed.arguments || parsed.args; if (!name || !args || typeof args !== 'object') return undefined; return { id: `call_${crypto.randomBytes(6).toString('hex')}`, name: String(name), arguments: args }; } catch { return undefined; }
}
function normalizeAssistantMessage(message, calls) { return { role: 'assistant', content: normalizeContent(message.content), tool_calls: calls.map(toWireToolCall) }; }
function toWireToolCall(call) { return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } }; }
function normalizeContent(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join(''); return ''; }
module.exports = { LlamaAgentModel, normalizeToolCalls, parseArguments, parseFallbackToolCall };
