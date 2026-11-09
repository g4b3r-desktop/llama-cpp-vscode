const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('node:module');

let configValues = {};
const vscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback
    })
  },
  env: { openExternal: async () => true },
  Uri: { parse: value => value }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { TerminalService } = require('../src/terminal/TerminalService');
const { detectExecutionPlan } = require('../src/terminal/executionPlan');
const { AgentRunner, findNewDiagnostics } = require('../src/agent/AgentRunner');
const { isVerificationTool } = require('../src/agent/AgentPlan');
Module._load = originalLoad;

const defaultConfig = {
  agent: {
    terminalTimeoutMs: 120000,
    maxTerminalOutputCharacters: 40000,
    maxToolResultCharacters: 30000,
    maxSteps: 30,
    web: { enabled: false },
    execution: { autoRunAfterChanges: true, maxRepairAttempts: 3, timeoutMs: 120000 },
    planning: { enabled: false, requireVerification: false, showFinalPlan: false }
  }
};

test('1. executes a valid JavaScript file with Node', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'valid.js'), 'console.log("valid-run");\n');
    let shellMode;
    const terminal = makeTerminal(root, {
      spawn: (executable, args, options) => {
        shellMode = options.shell;
        return require('child_process').spawn(executable, args, options);
      }
    });
    const result = await terminal.runFile('valid.js');
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /valid-run/);
    assert.equal(result.executionAttempted, true);
    assert.equal(result.executionPassed, true);
    assert.equal(shellMode, false);
  });
});

test('2. detects JavaScript syntax errors and returns source diagnostics', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'broken.js'), 'const value = ;\n');
    const result = await makeTerminal(root).runFile('broken.js');
    assert.equal(result.status, 'FAILED');
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /SyntaxError|Unexpected token/);
    assert.ok(result.diagnostics.some(item => item.line === 1));
  });
});

test('3. executes Python and captures a traceback on runtime errors', async t => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'broken.py'), 'raise RuntimeError("traceback-captured")\n');
    const result = await makeTerminal(root).runFile('broken.py');
    if (!result.executionAttempted && /Python runtime was not found/.test(result.error || '')) return t.skip('Python runtime unavailable');
    assert.equal(result.status, 'FAILED');
    assert.match(result.stderr, /Traceback/);
    assert.match(result.stderr, /traceback-captured/);
    assert.ok(result.diagnostics.some(item => item.line === 1));
  });
});

test('4. a project test script with a non-zero exit code is not verification success', async t => {
  await withWorkspace(async root => {
    if (!commandAvailable('npm')) return t.skip('npm unavailable');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"' } }));
    await fs.writeFile(path.join(root, 'app.js'), 'console.log("app");\n');
    const result = await makeTerminal(root).runFile('app.js');
    assert.equal(result.kind, 'test');
    assert.equal(result.exitCode, 7);
    assert.equal(result.status, 'FAILED');
    assert.equal(isVerificationTool('run_terminal', { command: result.command }, { ok: true, exitCode: result.exitCode }), false);
  });
});

test('5. repairs a failed file through AgentRunner and automatically reruns it', async () => {
  const { result, terminalCalls, contents, modelMessages } = await runAgentWithMutations([
    { path: 'app.js', content: 'broken' },
    { path: 'app.js', content: 'fixed' }
  ], [
    { status: 'FAILED', executionAttempted: true, executionPassed: false, exitCode: 1, stderr: 'SyntaxError', diagnostics: [] },
    { status: 'SUCCESS', executionAttempted: true, executionPassed: true, exitCode: 0, stdout: 'fixed-run', diagnostics: [] }
  ]);
  assert.equal(terminalCalls.length, 2);
  assert.equal(contents.get('app.js'), 'fixed');
  assert.equal(result.execution.status, 'SUCCESS');
  assert.equal(result.execution.repairAttempts, 1);
  assert.ok(modelMessages.some(text => text.includes('SyntaxError') && text.includes('exitCode')));
});

test('6. reports SUCCESS only after the second execution passes', async () => {
  const { result } = await runAgentWithMutations([
    { path: 'app.js', content: 'broken' },
    { path: 'app.js', content: 'fixed' }
  ], [
    { status: 'FAILED', executionAttempted: true, executionPassed: false, exitCode: 1, stderr: 'SyntaxError', diagnostics: [] },
    { status: 'SUCCESS', executionAttempted: true, executionPassed: true, exitCode: 0, diagnostics: [] }
  ]);
  assert.equal(result.execution.finalStatus, 'SUCCESS');
  assert.equal(result.verification.executionPassed, true);
  assert.equal(result.verification.executionAttempted, true);
});

test('7. a new file mutation invalidates the previous passing result', async () => {
  const { result, terminalCalls } = await runAgentWithMutations([
    { path: 'app.js', content: 'first version' },
    { path: 'app.js', content: 'second version' }
  ], [
    { status: 'SUCCESS', executionAttempted: true, executionPassed: true, exitCode: 0, diagnostics: [] },
    { status: 'FAILED', executionAttempted: true, executionPassed: false, exitCode: 1, stderr: 'new error', diagnostics: [] }
  ]);
  assert.equal(terminalCalls.length, 2);
  assert.equal(result.execution.finalStatus, 'FAILED');
  assert.equal(result.verification.executionPassed, false);
});

test('8. terminates automatic execution on timeout', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'timeout.js'), 'setTimeout(() => {}, 8000);\n');
    const result = await makeTerminal(root).runFile('timeout.js', { timeoutMs: 1000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 'TIMEOUT');
    assert.notEqual(result.exitCode, 0);
  });
});

test('9. cancels automatic execution and terminates the child process', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'cancel.js'), 'setTimeout(() => {}, 8000);\n');
    const controller = new AbortController();
    const pending = makeTerminal(root).runFile('cancel.js', { signal: controller.signal, timeoutMs: 10000 });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.status, 'CANCELLED');
  });
});

test('10. repair attempts are bounded and do not create an infinite loop', async () => {
  const { result, terminalCalls } = await runAgentWithMutations([
    { path: 'app.js', content: 'first' },
    { path: 'app.js', content: 'second' },
    { path: 'app.js', content: 'third' }
  ], [
    { status: 'FAILED', executionAttempted: true, exitCode: 1, stderr: 'first error', diagnostics: [] },
    { status: 'FAILED', executionAttempted: true, exitCode: 1, stderr: 'still failing', diagnostics: [] },
    { status: 'SUCCESS', executionAttempted: true, exitCode: 0, diagnostics: [] }
  ], { maxRepairAttempts: 1 });
  assert.equal(terminalCalls.length, 2);
  assert.equal(result.execution.finalStatus, 'FAILED');
  assert.equal(result.execution.repairAttempts, 1);
});

test('11. refuses to execute code when explicit terminal approval is denied', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'denied.js'), 'console.log("must-not-run");\n');
    let spawned = false;
    const terminal = makeTerminal(root, {
      permissions: { assertTrusted() {}, async confirmTerminal() { throw new Error('Operation was not approved by the user.'); } },
      spawn: (...args) => { spawned = true; return require('child_process').spawn(...args); }
    });
    await assert.rejects(terminal.runFile('denied.js'), /not approved/);
    assert.equal(spawned, false);
  });
});

test('12. pre-existing workspace diagnostics are not classified as newly introduced', () => {
  const existing = [{ path: 'legacy.js', line: 9, severity: 'error', message: 'old issue' }];
  const after = [...existing, { path: 'new.js', line: 2, severity: 'error', message: 'new issue' }];
  assert.deepEqual(findNewDiagnostics(existing, after), [after[1]]);
});

test('managed HTML preview opens only a loopback URL and can be stopped', async t => {
  await withWorkspace(async root => {
    if (!commandAvailable('python3') && !commandAvailable('python')) return t.skip('Python runtime unavailable');
    await fs.mkdir(path.join(root, 'site'), { recursive: true });
    await fs.writeFile(path.join(root, 'site', 'index.html'), '<h1>preview-ready</h1>');
    let openedUrl = '';
    const terminal = makeTerminal(root, { openExternal: async url => { openedUrl = url; return true; } });
    const result = await terminal.runFile('site/index.html');
    assert.equal(result.status, 'SUCCESS');
    assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/site\/index\.html$/);
    assert.equal((await (await fetch(openedUrl)).text()).includes('preview-ready'), true);
    assert.equal(await terminal.stopPreview(), 1);
    assert.equal(terminal.servers.size, 0);
  });
});

test('Three.js projects use a managed local Vite preview when explicitly configured', async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite' },
      dependencies: { three: '^0.180.0', vite: '^7.0.0' }
    }));
    await fs.writeFile(path.join(root, 'index.html'), '<div id="app"></div>');
    const plan = await detectExecutionPlan(root, 'index.html');
    assert.equal(plan.kind, 'preview-script');
    assert.equal(plan.command, 'npm run dev');
    assert.deepEqual(plan.dependencies, ['three', 'vite']);
    assert.match(plan.approvalCommand, /Script definido no package\.json/);
  });
});

test('unsupported and binary files are never automatically executed', async () => {
  await withWorkspace(async root => {
    let spawned = false;
    const terminal = makeTerminal(root, {
      spawn: (...args) => { spawned = true; return require('child_process').spawn(...args); }
    });
    await fs.writeFile(path.join(root, 'unknown.rb'), 'puts "not supported"\n');
    const unknown = await terminal.runFile('unknown.rb');
    assert.equal(unknown.executionAttempted, false);
    assert.equal(unknown.supported, false);
    await fs.writeFile(path.join(root, 'binary.js'), Buffer.from([0, 1, 2]));
    await assert.rejects(terminal.runFile('binary.js'), /binary files/);
    assert.equal(spawned, false);
  });
});

async function runAgentWithMutations(mutations, runResults, options = {}) {
  configValues = {
    'agent.execution.autoRunAfterChanges': true,
    'agent.execution.maxRepairAttempts': options.maxRepairAttempts ?? 3,
    'agent.execution.timeoutMs': 120000,
    'agent.planning.enabled': false,
    'agent.planning.requireVerification': false,
    'agent.maxSteps': 20
  };
  const contents = new Map();
  const terminalCalls = [];
  const modelMessages = [];
  let modelTurn = 0;
  const registry = {
    asOpenAITools: () => [],
    get: name => ({ actionLabel: () => name }),
    async execute(name, args) {
      if (['create_file', 'edit_file', 'replace_in_file'].includes(name)) {
        contents.set(args.path, args.content);
        return { ok: true, path: args.path };
      }
      return { ok: true };
    }
  };
  const model = {
    async next({ messages }) {
      modelMessages.push(messages.map(message => message.content || '').join('\n'));
      if (modelTurn < mutations.length) {
        const change = mutations[modelTurn];
        const name = modelTurn === 0 ? 'create_file' : 'edit_file';
        modelTurn += 1;
        return {
          assistantMessage: { role: 'assistant', content: '' },
          toolCalls: [{ id: `tool-${modelTurn}`, name, arguments: change }],
          content: ''
        };
      }
      modelTurn += 1;
      return { assistantMessage: { role: 'assistant', content: 'feito' }, toolCalls: [], content: 'feito' };
    }
  };
  const workspace = {
    rootPath: '/workspace',
    resetSession() {},
    async workspaceSummary() { return { root: '/workspace', entries: [] }; },
    async getErrors() { return { results: [] }; },
    async readFile(filename) {
      const text = contents.get(filename);
      if (text === undefined) throw new Error('File not found');
      return { text, hash: crypto.createHash('sha256').update(text).digest('hex') };
    }
  };
  const terminal = {
    async runFile(filename) {
      terminalCalls.push(filename);
      return { path: filename, command: `node ${filename}`, durationMs: 5, ...runResults[terminalCalls.length - 1] };
    }
  };
  const runner = new AgentRunner(
    model,
    registry,
    workspace,
    { session: { id: 'test' }, async beginSession() {}, async complete() {} },
    { resetSession() {} },
    { appendLine() {} },
    terminal
  );
  const result = await runner.run('create and verify', { onAction() {} });
  configValues = {};
  return { result, terminalCalls, contents, modelMessages };
}

function makeTerminal(root, options = {}) {
  configValues = {};
  const permissions = options.permissions || {
    assertTrusted() {},
    async confirmTerminal(command, dangerous) {
      assert.equal(dangerous, true);
      assert.ok(command);
    }
  };
  return new TerminalService(root, permissions, { appendLine() {} }, {
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    getConfig: () => ({
      agent: {
        terminalTimeoutMs: 120000,
        maxTerminalOutputCharacters: 40000,
        execution: { timeoutMs: 120000 }
      }
    })
  });
}

function commandAvailable(command) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 });
  return !result.error && result.status === 0;
}

async function withWorkspace(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llama-agent-execution-'));
  try { await callback(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
