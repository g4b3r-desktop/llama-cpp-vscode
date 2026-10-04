const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ContextBudgetManager,
  estimateInputTokens,
  extractLlamaContextWindow,
  parseContextSizeArgs,
  inferUserPromptBoundary,
  compactStructuredContent
} = require('../src/context/ContextBudgetManager');

const exactByChars = async (messages, tools) => Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools || []).length) / 4);

test('discovers n_ctx from llama.cpp props and local args', () => {
  assert.equal(extractLlamaContextWindow({ default_generation_settings: { n_ctx: 4096 } }), 4096);
  assert.equal(extractLlamaContextWindow({ slot_n_ctx: 8192 }), 8192);
  assert.equal(parseContextSizeArgs(['--flash-attn', 'on', '--ctx-size', '16384']), 16384);
  assert.equal(parseContextSizeArgs(['-c=8192']), 8192);
});

test('estimates tool schemas as part of the input budget', () => {
  const messages = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }];
  const withoutTools = estimateInputTokens(messages, [], 3);
  const withTools = estimateInputTokens(messages, [{ type: 'function', function: { name: 'read_file', description: 'x'.repeat(900), parameters: {} } }], 3);
  assert.ok(withTools > withoutTools + 250);
});

test('drops old chat history before trimming current context', async () => {
  const manager = new ContextBudgetManager({ safetyMarginTokens: 64, minOutputTokens: 128, charactersPerToken: 4 });
  const prompt = 'corrija o bug';
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old question '.repeat(200) },
    { role: 'assistant', content: 'old answer '.repeat(200) },
    { role: 'user', content: `${prompt}\n\n<workspace_chunk file="a.js">\n${'x'.repeat(3000)}\n</workspace_chunk>` }
  ];
  const result = await manager.fit({ messages, contextWindowTokens: 1200, requestedOutputTokens: 256, countTokens: exactByChars, mode: 'chat' });
  assert.ok(result.stats.historyMessagesDropped >= 2);
  assert.equal(result.messages[1].role, 'user');
  assert.ok(result.messages[1].content.startsWith(prompt));
  assert.ok(result.stats.inputTokens <= result.stats.inputBudgetTokens);
});

test('trims automatic/RAG context from the tail while preserving the user prompt', async () => {
  const manager = new ContextBudgetManager({ safetyMarginTokens: 32, minOutputTokens: 64, charactersPerToken: 4 });
  const prompt = 'explique exatamente esta função';
  const user = `${prompt}\n\n<editor_context file="a.js">\n${'a'.repeat(7000)}\n</editor_context>`;
  assert.equal(inferUserPromptBoundary(user), prompt.length);
  const result = await manager.fit({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: user }], contextWindowTokens: 900, requestedOutputTokens: 200, countTokens: exactByChars, mode: 'chat' });
  const finalUser = result.messages.at(-1).content;
  assert.ok(finalUser.startsWith(prompt));
  assert.ok(finalUser.includes('reduzido automaticamente'));
  assert.ok(result.stats.userContextCharactersDropped > 0);
});

test('compacts tool results and preserves tool-call pairing in agent context', async () => {
  const manager = new ContextBudgetManager({ safetyMarginTokens: 32, minOutputTokens: 64, charactersPerToken: 4 });
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'system', content: 'agent rules\nInitial workspace entries (summary only):\n- a\n- b' },
    { role: 'user', content: 'corrija os testes' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: JSON.stringify({ ok: true, content: 'x'.repeat(20000) }) }
  ];
  const result = await manager.fit({ messages, tools, contextWindowTokens: 1600, requestedOutputTokens: 256, countTokens: exactByChars, mode: 'agent' });
  const assistantIndex = result.messages.findIndex(m => m.role === 'assistant');
  const toolIndex = result.messages.findIndex(m => m.role === 'tool');
  assert.ok(assistantIndex >= 0 && toolIndex === assistantIndex + 1);
  assert.ok(result.stats.toolMessagesCompacted > 0);
  assert.doesNotThrow(() => JSON.parse(result.messages[toolIndex].content));
  assert.ok(result.stats.inputTokens <= result.stats.inputBudgetTokens);
});

test('reduces output reserve only after compacting input', async () => {
  const manager = new ContextBudgetManager({ safetyMarginTokens: 50, minOutputTokens: 100, charactersPerToken: 4 });
  const messages = [{ role: 'system', content: 's'.repeat(1200) }, { role: 'user', content: 'prompt' }];
  const result = await manager.fit({ messages, contextWindowTokens: 500, requestedOutputTokens: 250, countTokens: exactByChars, mode: 'chat' });
  assert.ok(result.maxOutputTokens < 250);
  assert.ok(result.maxOutputTokens >= 100);
  assert.ok(result.stats.inputTokens <= result.stats.inputBudgetTokens);
});

test('fails instead of silently truncating an essential user prompt', async () => {
  const manager = new ContextBudgetManager({ safetyMarginTokens: 32, minOutputTokens: 64, charactersPerToken: 4 });
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'p'.repeat(6000) }];
  await assert.rejects(
    manager.fit({ messages, contextWindowTokens: 600, requestedOutputTokens: 128, countTokens: exactByChars, mode: 'chat' }),
    error => error?.code === 'CONTEXT_BUDGET_EXCEEDED'
  );
});

test('structured compaction returns valid JSON under the requested cap neighborhood', () => {
  const compacted = compactStructuredContent(JSON.stringify({ ok: true, stdout: 'z'.repeat(10000) }), 1000);
  const parsed = JSON.parse(compacted);
  assert.equal(parsed.truncated, true);
  assert.ok(compacted.length < 1200);
});
