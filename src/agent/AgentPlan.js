const PLAN_KINDS = new Set(['analyze', 'execute', 'verify']);
const MUTATION_TOOLS = new Set(['create_directory', 'create_file', 'edit_file', 'replace_in_file', 'delete_file', 'move_file']);

async function createOperationalPlan(model, options = {}) {
  const request = String(options.request || '').trim();
  const maxSteps = clampInt(options.maxSteps, 2, 10, 6);
  const entries = Array.isArray(options.summary?.entries) ? options.summary.entries.slice(0, 40) : [];
  const messages = [
    {
      role: 'system',
      content: [
        'Create a short PUBLIC operational plan for a coding agent.',
        'This is not chain-of-thought and must not contain hidden reasoning, deliberation, or internal analysis.',
        'Return JSON only with this shape: {"summary":"...","steps":[{"title":"...","kind":"analyze|execute|verify"}]}.',
        `Use 2 to ${maxSteps} concrete, user-visible steps.`,
        'Keep titles concise and action-oriented.',
        'The final step must be verification. Verification means diagnostics and relevant tests/build/lint when applicable.',
        'Do not call tools in this planning turn.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Task: ${request}`,
        entries.length ? `Workspace summary:\n${entries.map(entry => `- ${entry}`).join('\n')}` : ''
      ].filter(Boolean).join('\n\n')
    }
  ];
  const turn = await model.next({ messages, tools: [], signal: options.signal, model: options.model });
  return parsePlanContent(turn?.content, { request, maxSteps });
}

function parsePlanContent(content, options = {}) {
  const maxSteps = clampInt(options.maxSteps, 2, 10, 6);
  const request = String(options.request || '').trim();
  const text = stripFence(String(content || '').trim());
  let parsed;
  try { parsed = JSON.parse(text); } catch { return fallbackPlan(request, maxSteps); }
  const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const seen = new Set();
  const steps = [];
  for (const raw of rawSteps) {
    const title = cleanTitle(typeof raw === 'string' ? raw : raw?.title);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = normalizeKind(typeof raw === 'string' ? undefined : raw?.kind, title);
    steps.push({ title, kind });
    if (steps.length >= maxSteps) break;
  }
  if (!steps.length) return fallbackPlan(request, maxSteps);
  ensureVerificationStep(steps, maxSteps);
  return {
    summary: cleanTitle(parsed?.summary) || summarizeRequest(request),
    steps: steps.map((step, index) => ({ id: `step-${index + 1}`, title: step.title, kind: step.kind, status: 'pending' }))
  };
}

function fallbackPlan(request, maxSteps = 6) {
  const candidates = [
    { title: 'Analisar o pedido e localizar o código relevante', kind: 'analyze' },
    { title: 'Executar as alterações ou ações necessárias', kind: 'execute' },
    { title: 'Validar diagnostics e testes relevantes', kind: 'verify' }
  ];
  const steps = candidates.slice(0, Math.max(2, Math.min(maxSteps, candidates.length)));
  ensureVerificationStep(steps, maxSteps);
  return {
    summary: summarizeRequest(request),
    steps: steps.map((step, index) => ({ id: `step-${index + 1}`, title: step.title, kind: step.kind, status: 'pending' }))
  };
}

class AgentPlanState {
  constructor(plan) {
    const source = Array.isArray(plan?.steps) ? plan.steps : [];
    this.summary = cleanTitle(plan?.summary) || 'Executar a tarefa solicitada';
    this.steps = source.map((step, index) => ({
      id: String(step?.id || `step-${index + 1}`),
      title: cleanTitle(step?.title) || `Etapa ${index + 1}`,
      kind: normalizeKind(step?.kind, step?.title),
      status: ['pending', 'running', 'completed', 'failed'].includes(step?.status) ? step.status : 'pending',
      note: undefined
    }));
  }

  start(index) {
    const step = this.steps[index];
    if (!step) return;
    for (let i = 0; i < this.steps.length; i += 1) if (i !== index && this.steps[i].status === 'running') this.steps[i].status = 'pending';
    if (step.status !== 'completed') step.status = 'running';
  }

  complete(index, note) {
    const step = this.steps[index];
    if (!step) return;
    step.status = 'completed';
    if (note) step.note = cleanTitle(note).slice(0, 180);
  }

  fail(index, note) {
    const step = this.steps[index];
    if (!step) return;
    step.status = 'failed';
    if (note) step.note = cleanTitle(note).slice(0, 180);
  }

  snapshot() {
    return {
      summary: this.summary,
      steps: this.steps.map(step => ({ ...step }))
    };
  }

  progressText() {
    return ['Plano:', ...this.steps.map(step => `${statusIcon(step.status)} ${step.title}`)].join('\n');
  }

  markdown() {
    return ['### Plano executado', ...this.steps.map(step => `- ${statusEmoji(step.status)} ${step.title}${step.note ? ` — ${step.note}` : ''}`)].join('\n');
  }
}

function ensureVerificationStep(steps, maxSteps) {
  if (!steps.length) return;
  const last = steps[steps.length - 1];
  if (last.kind === 'verify') return;
  const verification = { title: 'Validar diagnostics e testes relevantes', kind: 'verify' };
  if (steps.length >= maxSteps) steps[steps.length - 1] = verification;
  else steps.push(verification);
}

function isMutationTool(name) { return MUTATION_TOOLS.has(String(name || '')); }

function isVerificationTool(name, args = {}) {
  const tool = String(name || '');
  if (tool === 'get_errors') return true;
  if (tool !== 'run_terminal') return false;
  const command = String(args.command || args.cmd || '').toLowerCase();
  return /(^|\s|&&|;)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|check|typecheck)|\b(pytest|unittest|ruff|mypy|eslint|tsc|cargo\s+(test|check)|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|make\s+(test|check))\b/.test(command);
}

function normalizeKind(value, title = '') {
  const kind = String(value || '').toLowerCase();
  if (PLAN_KINDS.has(kind)) return kind;
  const text = String(title || '').toLowerCase();
  if (/test|valid|diagnostic|lint|build|verif|check/.test(text)) return 'verify';
  if (/edit|alter|implement|corrig|refactor|create|cri|remove|move|atualiz/.test(text)) return 'execute';
  return 'analyze';
}

function stripFence(text) { return String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim(); }
function cleanTitle(value) { return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 180); }
function summarizeRequest(request) { const value = cleanTitle(request); return value ? value.slice(0, 140) : 'Executar a tarefa solicitada'; }
function statusIcon(status) { return status === 'completed' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '✗' : '○'; }
function statusEmoji(status) { return status === 'completed' ? '✅' : status === 'running' ? '🔄' : status === 'failed' ? '❌' : '⬜'; }
function clampInt(value, min, max, fallback) { const number = Math.floor(Number(value)); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }

module.exports = { createOperationalPlan, parsePlanContent, fallbackPlan, AgentPlanState, isMutationTool, isVerificationTool, normalizeKind };
