const test = require('node:test');
const assert = require('node:assert/strict');
const { toResponsesInput, toResponsesTools, extractResponseText, extractFunctionCalls } = require('../src/openai/responseUtils');

test('maps chat messages and tool outputs to Responses input', () => {
  const input = toResponsesInput([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
  ]);
  assert.deepEqual(input[0], { role: 'developer', content: 'rules' });
  assert.deepEqual(input[1], { role: 'user', content: 'hello' });
  assert.equal(input[2].type, 'function_call');
  assert.equal(input[2].call_id, 'call_1');
  assert.equal(input[2].name, 'read_file');
  assert.equal(input[3].type, 'function_call_output');
  assert.equal(input[3].call_id, 'call_1');
});

test('maps OpenAI-style tool schemas to Responses function tools', () => {
  const tools = toResponsesTools([{ type: 'function', function: { name: 'search_text', description: 'Search text', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].name, 'search_text');
  assert.equal(tools[0].parameters.required[0], 'query');
});

test('extracts text from Responses output', () => {
  assert.equal(extractResponseText({ output_text: 'direct' }), 'direct');
  assert.equal(extractResponseText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }] }] }), 'hello world');
});

test('extracts function calls and parses JSON arguments', () => {
  const calls = extractFunctionCalls({ output: [{ type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"path":"src/app.js"}' }] });
  assert.deepEqual(calls, [{ id: 'call_2', name: 'read_file', arguments: { path: 'src/app.js' } }]);
});
