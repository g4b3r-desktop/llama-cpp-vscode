const MODES = new Set(['ask', 'agent', 'research', 'fresh']);

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'ask';
}

function includeHistoryForMode(mode, configured = true) {
  return normalizeMode(mode) === 'ask' && Boolean(configured);
}

function buildAgentPrompt(mode, text, contextText = '') {
  const selected = normalizeMode(mode);
  const researchInstruction = selected === 'research'
    ? 'Perform detailed web research before answering. Use research_web or web_search + fetch_url, corroborate important claims when practical, and include the source URLs in the final answer.'
    : '';
  return [researchInstruction, String(text || '').trim(), String(contextText || '').trim()].filter(Boolean).join('\n\n');
}

function modeLabel(mode) {
  return ({ ask: 'Ask', agent: 'Agent', research: 'Research', fresh: 'Fresh' })[normalizeMode(mode)];
}

module.exports = { normalizeMode, includeHistoryForMode, buildAgentPrompt, modeLabel };
