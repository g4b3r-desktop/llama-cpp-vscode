function trimHistory(history, maxMessages = 12) {
  const list = Array.isArray(history) ? history : [];
  const max = Math.max(0, Number(maxMessages || 0));
  return list.length <= max ? list.slice() : list.slice(list.length - max);
}

function removeLatestHistoryExchange(history, userText) {
  const list = Array.isArray(history) ? history.slice() : [];
  const text = String(userText || '').trim();
  if (list.length < 2) return list;
  const user = list[list.length - 2];
  const assistant = list[list.length - 1];
  if (user?.role === 'user' && assistant?.role === 'assistant' && String(user.content || '').trim() === text) {
    return list.slice(0, -2);
  }
  return list;
}

function removeLatestTranscriptExchange(transcript, userText) {
  const list = Array.isArray(transcript) ? transcript.slice() : [];
  const text = String(userText || '').trim();
  if (list.length < 2) return list;
  const user = list[list.length - 2];
  const assistant = list[list.length - 1];
  if (user?.role === 'user' && assistant?.role === 'assistant' && String(user.text || '').trim() === text) {
    return list.slice(0, -2);
  }
  return list;
}

function providerPresentation(config = {}) {
  if (config.provider === 'openai') {
    return { provider: 'openai', label: `OpenAI · ${config.openai?.model || 'modelo padrão'}` };
  }
  const model = config.api?.model ? ` · ${config.api.model}` : '';
  const mode = config.mode === 'local' ? 'local' : 'API';
  return { provider: 'llamacpp', label: `llama.cpp · ${mode}${model}` };
}

module.exports = { trimHistory, removeLatestHistoryExchange, removeLatestTranscriptExchange, providerPresentation };
