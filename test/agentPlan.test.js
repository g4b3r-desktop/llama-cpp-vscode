const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlanContent, fallbackPlan, AgentPlanState, isMutationTool, isVerificationTool } = require('../src/agent/AgentPlan');

test('parsePlanContent accepts fenced JSON and appends verification', () => {
  const plan = parsePlanContent('```json\n{"summary":"Corrigir login","steps":[{"title":"Localizar autenticação","kind":"analyze"},{"title":"Corrigir sessão","kind":"execute"}]}\n```', { request: 'corrija login', maxSteps: 5 });
  assert.equal(plan.summary, 'Corrigir login');
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].kind, 'analyze');
  assert.equal(plan.steps[1].kind, 'execute');
  assert.equal(plan.steps[2].kind, 'verify');
});

test('parsePlanContent falls back on invalid JSON', () => {
  const plan = parsePlanContent('not-json', { request: 'faça algo', maxSteps: 6 });
  assert.equal(plan.steps.at(-1).kind, 'verify');
  assert.ok(plan.steps.length >= 2);
});

test('plan respects maximum step count and keeps verification last', () => {
  const raw = JSON.stringify({ steps: [
    { title: 'A', kind: 'analyze' },
    { title: 'B', kind: 'execute' },
    { title: 'C', kind: 'execute' },
    { title: 'D', kind: 'execute' },
    { title: 'E', kind: 'execute' }
  ] });
  const plan = parsePlanContent(raw, { maxSteps: 3 });
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[2].kind, 'verify');
});

test('AgentPlanState exposes public lifecycle without reasoning', () => {
  const state = new AgentPlanState(fallbackPlan('corrija os testes', 4));
  state.start(0);
  assert.equal(state.steps[0].status, 'running');
  state.complete(0, 'arquivos localizados');
  state.start(1);
  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[1].status, 'running');
  state.fail(1, 'teste falhou');
  assert.equal(state.steps[1].status, 'failed');
  assert.match(state.progressText(), /Plano:/);
  assert.match(state.markdown(), /Plano executado/);
});

test('mutation and verification tool classification', () => {
  assert.equal(isMutationTool('edit_file'), true);
  assert.equal(isMutationTool('read_file'), false);
  assert.equal(isVerificationTool('get_errors', {}), true);
  assert.equal(isVerificationTool('run_terminal', { command: 'npm test' }), true);
  assert.equal(isVerificationTool('run_terminal', { command: 'pnpm run lint' }), true);
  assert.equal(isVerificationTool('run_terminal', { command: 'pytest -q' }), true);
  assert.equal(isVerificationTool('run_terminal', { command: 'ls -la' }), false);
});
