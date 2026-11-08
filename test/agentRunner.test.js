const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (key, defaultValue) => key === 'agent.planning.enabled' ? false : defaultValue
        })
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { AgentRunner } = require('../src/agent/AgentRunner');
Module._load = originalLoad;

test('planning disabled executes directly without emitting or returning a public plan', async () => {
  const actions = [];
  let modelTurns = 0;
  let systemPrompt = '';
  const runner = new AgentRunner(
    {
      async next({ messages }) {
        modelTurns += 1;
        systemPrompt = messages[0].content;
        return {
          assistantMessage: { role: 'assistant', content: 'Solicitação concluída.' },
          toolCalls: [],
          content: 'Solicitação concluída.'
        };
      }
    },
    { get: () => undefined, asOpenAITools: () => [] },
    {
      rootPath: '/workspace',
      resetSession() {},
      async workspaceSummary() { return { root: '/workspace', entries: [] }; }
    },
    { session: { id: 'test-session' }, async beginSession() {}, async complete() {} },
    { resetSession() {} }
  );

  const result = await runner.run('Responda diretamente', { onAction: action => actions.push(action) });

  assert.equal(modelTurns, 1);
  assert.equal(result.answer, 'Solicitação concluída.');
  assert.equal(result.plan, undefined);
  assert.doesNotMatch(systemPrompt, /Public operational plan/);
  assert.equal(actions.some(action => action.kind === 'plan'), false);
});
