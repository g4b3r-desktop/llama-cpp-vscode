function toResponsesInput(messages) {
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || ''), output: String(message.content || '') });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const text = normalizeContent(message.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const call of message.tool_calls) {
        const fn = call?.function || {};
        const callId = String(call?.id || call?.call_id || '');
        const name = String(fn.name || call?.name || '');
        if (!callId || !name) continue;
        input.push({ type: 'function_call', call_id: callId, name, arguments: stringifyArguments(fn.arguments ?? call?.arguments) });
      }
      continue;
    }
    const role = message.role === 'system' ? 'developer' : (message.role || 'user');
    const content = normalizeContent(message.content);
    if (content) input.push({ role, content });
  }
  return input;
}

function toResponsesTools(tools) {
  return (tools || []).map(tool => {
    const fn = tool?.function || tool || {};
    if (!fn.name) return undefined;
    return {
      type: 'function',
      name: String(fn.name),
      description: String(fn.description || ''),
      parameters: fn.parameters || { type: 'object', properties: {}, additionalProperties: false },
      strict: false
    };
  }).filter(Boolean);
}

function extractResponseText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const pieces = [];
  for (const item of data.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') pieces.push(part.text);
      else if (typeof part?.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('');
}

function extractFunctionCalls(data) {
  return (data?.output || []).filter(item => item?.type === 'function_call' && item?.name).map(item => ({
    id: String(item.call_id || item.id || ''),
    name: String(item.name),
    arguments: parseArguments(item.arguments)
  })).filter(call => call.id && call.name);
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return JSON.parse(value); } catch { return { _raw: value }; }
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || part?.value || '')).join('');
  return '';
}

function stringifyArguments(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value || {}); } catch { return '{}'; }
}

module.exports = { toResponsesInput, toResponsesTools, extractResponseText, extractFunctionCalls, parseArguments, normalizeContent };
