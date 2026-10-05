const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMode, includeHistoryForMode, buildAgentPrompt, modeLabel } = require('../src/sidebar/requestMode');

test('normalizes supported assistant sidebar modes', () => {
  assert.equal(normalizeMode('AGENT'), 'agent');
  assert.equal(normalizeMode('research'), 'research');
  assert.equal(normalizeMode('unknown'), 'ask');
});

test('only Ask mode can include previous conversation history', () => {
  assert.equal(includeHistoryForMode('ask', true), true);
  assert.equal(includeHistoryForMode('ask', false), false);
  assert.equal(includeHistoryForMode('fresh', true), false);
  assert.equal(includeHistoryForMode('agent', true), false);
  assert.equal(includeHistoryForMode('research', true), false);
});

test('research mode adds the controlled web research instruction', () => {
  const prompt = buildAgentPrompt('research', 'pesquise X', 'contexto');
  assert.match(prompt, /detailed web research/i);
  assert.match(prompt, /research_web/);
  assert.match(prompt, /pesquise X/);
  assert.match(prompt, /contexto/);
});

test('agent mode does not inject the research-only instruction', () => {
  const prompt = buildAgentPrompt('agent', 'corrija o projeto');
  assert.equal(prompt, 'corrija o projeto');
  assert.equal(modeLabel('fresh'), 'Fresh');
});
