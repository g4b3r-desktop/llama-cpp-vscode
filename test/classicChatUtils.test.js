const test = require('node:test');
const assert = require('node:assert/strict');
const {
  trimHistory,
  removeLatestHistoryExchange,
  removeLatestTranscriptExchange,
  providerPresentation
} = require('../src/chat/classicChatUtils');

test('trimHistory keeps only the newest messages', () => {
  const history = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  assert.deepEqual(trimHistory(history, 4).map(item => item.content), ['4', '5', '6', '7']);
});

test('regenerate removes only the latest matching chat exchange', () => {
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'two' }
  ];
  assert.equal(removeLatestHistoryExchange(history, 'again').length, 2);
  assert.equal(removeLatestHistoryExchange(history, 'first').length, 4);
});

test('regenerate removes only the latest matching transcript exchange', () => {
  const transcript = [
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'answer' }
  ];
  assert.deepEqual(removeLatestTranscriptExchange(transcript, 'question'), []);
});

test('provider presentation includes provider mode/model information', () => {
  assert.equal(providerPresentation({ provider: 'openai', openai: { model: 'gpt-test' } }).label, 'OpenAI · gpt-test');
  assert.equal(providerPresentation({ provider: 'llamacpp', mode: 'local', api: { model: 'qwen' } }).label, 'llama.cpp · local · qwen');
});
