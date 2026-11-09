const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const http = require('http');
const vscode = require('vscode');
const { getConfig } = require('../config');
const { assertWorkspaceScopedCommand, isDangerousCommand } = require('./commandPolicy');
const { detectExecutionPlan } = require('./executionPlan');
const { isInsideRoot } = require('../workspace/pathSafety');

class TerminalService {
  constructor(rootPath, permissions, output, options = {}) {
    this.rootPath = rootPath;
    this.permissions = permissions;
    this.output = output;
    this.spawnProcess = options.spawn || spawn;
    this.getConfig = options.getConfig || getConfig;
    this.openExternal = options.openExternal || (url => vscode.env.openExternal(vscode.Uri.parse(url)));
    this.servers = new Map();
  }

  async run(command, signal) {
    const text = assertWorkspaceScopedCommand(command);
    const dangerous = isDangerousCommand(text);
    const config = this.getConfig();
    const timeoutMs = Math.max(1000, Number(config.agent.terminalTimeoutMs || 120000));
    const maxChars = Math.max(1000, Number(config.agent.maxTerminalOutputCharacters || 40000));
    this.output?.appendLine(`[agent:terminal] ${text}`);
    await this.permissions.confirmTerminal(text, dangerous);
    return this.runProcess(text, text, { cwd: this.rootPath, shell: true, signal, timeoutMs, maxChars });
  }

  async runStructured(executable, args, options = {}) {
    const commandArgs = validateArguments(args);
    const executableName = String(executable || '').trim();
    const command = [executableName, ...commandArgs].join(' ');
    if (!executableName || /[\0\r\n]/.test(command) || !isAllowedRuntime(executableName)) throw new Error('Structured command contains an unsupported executable or argument.');
    assertWorkspaceScopedCommand(commandArgs.join(' '));
    const rootRealPath = await fs.realpath(this.rootPath);
    const cwd = await fs.realpath(options.cwd || this.rootPath);
    if (!isInsideRoot(rootRealPath, cwd)) throw new Error('Structured execution working directory must remain inside the workspace.');
    this.permissions.assertTrusted('execute project code');
    if (options.signal?.aborted) return cancelledResult(command, options);
    const approvalCommand = String(options.approvalCommand || command);
    if (approvalCommand.length > 5000) throw new Error('Configured project script is too large to show for safe terminal approval; inspect it and run the check manually.');
    await this.permissions.confirmTerminal(approvalCommand, true);
    if (options.signal?.aborted) return cancelledResult(command, options);
    const config = this.getConfig();
    const timeoutMs = Math.min(600000, Math.max(1000, Number(options.timeoutMs || config.agent.execution?.timeoutMs || config.agent.terminalTimeoutMs || 120000)));
    const maxChars = Math.max(1000, Number(config.agent.maxTerminalOutputCharacters || 40000));
    this.output?.appendLine(`[agent:execution] ${command}`);
    return this.runProcess(command, executableName, {
      args: commandArgs,
      cwd,
      env: options.env || process.env,
      signal: options.signal,
      timeoutMs,
      maxChars
    });
  }

  async runFile(relativePath, options = {}) {
    const plan = await detectExecutionPlan(this.rootPath, relativePath);
    if (!plan.supported) {
      return {
        ...plan,
        executed: false,
        status: 'FAILED',
        executionAttempted: false,
        error: plan.reason
      };
    }

    if (plan.kind === 'preview' || plan.kind === 'preview-script') {
      const start = Date.now();
      const preview = await this.startPreview(plan, options.signal, options.timeoutMs, options.onServerExit);
      return {
        ...pickPlan(plan),
        ...preview,
        durationMs: Date.now() - start,
        executed: true,
        status: preview.status,
        executionAttempted: true,
        executionPassed: preview.status === 'SUCCESS',
        stdout: preview.stdout || '',
        stderr: preview.stderr || '',
        exitCode: preview.exitCode ?? 0,
        timedOut: false
      };
    }

    const result = await this.runStructured(plan.runtime, plan.args, { cwd: plan.cwd, signal: options.signal, timeoutMs: options.timeoutMs, approvalCommand: plan.approvalCommand });
    const diagnostics = parseExecutionDiagnostics(result.stdout, result.stderr, plan.path);
    const executionPassed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    return {
      ...pickPlan(plan),
      command: result.command,
      executed: true,
      executionAttempted: true,
      executionPassed,
      status: result.cancelled ? 'CANCELLED' : result.timedOut ? 'TIMEOUT' : executionPassed ? 'SUCCESS' : 'FAILED',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      diagnostics
    };
  }

  async startPreview(plan, signal, timeoutMs, onServerExit) {
    this.permissions.assertTrusted('start a local preview server');
    if (signal?.aborted) return { status: 'CANCELLED', cancelled: true, reason: 'Execution was cancelled before starting the preview.' };
    for (const id of this.servers.keys()) await this.stopServer(id);
    const port = await findAvailablePort();
    const projectScript = plan.kind === 'preview-script';
    const commandArgs = projectScript
      ? [...plan.args, '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
      : ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', plan.cwd];
    const command = `${plan.runtime} ${commandArgs.map(quoteForDisplay).join(' ')}`;
    const approvalCommand = projectScript
      ? `${plan.approvalCommand}\nComando iniciado: ${command}`
      : command;
    if (approvalCommand.length > 5000) throw new Error('Configured project script is too large to show for safe preview approval; inspect it and run the preview manually.');
    await this.permissions.confirmTerminal(approvalCommand, true);
    if (signal?.aborted) return { status: 'CANCELLED', cancelled: true, reason: 'Execution was cancelled before starting the preview.' };
    const maxChars = Math.max(1000, Number(this.getConfig().agent.maxTerminalOutputCharacters || 40000));
    this.output?.appendLine(`[agent:preview] ${command}`);
    const child = this.spawnProcess(plan.runtime, commandArgs, {
      cwd: plan.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const id = `${Date.now()}-${child.pid || port}`;
    const server = { id, child, port, command, stdout: '', stderr: '', path: plan.path, startedAt: Date.now(), onServerExit };
    this.servers.set(id, server);
    child.once('error', error => { server.spawnError = error; });
    child.stdout?.on('data', chunk => { server.stdout = appendBounded(server.stdout, chunk, maxChars); });
    child.stderr?.on('data', chunk => { server.stderr = appendBounded(server.stderr, chunk, maxChars); });
    child.once('close', (code, signalName) => {
      this.servers.delete(id);
      if (server.stopping) return;
      const report = {
        path: server.path,
        command: server.command,
        durationMs: Date.now() - server.startedAt,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signalName || null,
        stdout: server.stdout,
        stderr: server.stderr,
        executionAttempted: true,
        executionPassed: false,
        status: 'FAILED',
        finalStatus: 'FAILED',
        error: 'The managed preview server exited unexpectedly.'
      };
      this.output?.appendLine(`[agent:preview:exit] ${JSON.stringify(report)}`);
      server.onServerExit?.(report);
    });

    const ready = await waitForHttpServer(port, signal, Math.min(10000, Number(timeoutMs || this.getConfig().agent.execution?.timeoutMs || 120000)), child, projectScript, server);
    if (!ready.ready) {
      await this.stopServer(id);
      return {
        status: ready.cancelled ? 'CANCELLED' : ready.timedOut ? 'TIMEOUT' : 'FAILED',
        cancelled: ready.cancelled,
        timedOut: ready.timedOut,
        command,
        stdout: server.stdout,
        stderr: server.stderr,
        exitCode: ready.exitCode,
        error: ready.error || 'The managed local preview server did not become ready.'
      };
    }

    const previewPath = projectScript ? '' : plan.path.split('/').map(encodeURIComponent).join('/');
    const url = `http://127.0.0.1:${port}/${previewPath}`;
    server.url = url;
    try {
      const opened = await this.openExternal(url);
      if (opened === false) throw new Error('VS Code did not open the preview URL.');
    } catch (error) {
      await this.stopServer(id);
      throw new Error(`The preview server started, but VS Code could not open the browser: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: 'SUCCESS', command, url, serverId: id, stdout: server.stdout, stderr: server.stderr, exitCode: 0 };
  }

  async stopServer(id) {
    const server = this.servers.get(id);
    if (!server) return false;
    server.stopping = true;
    terminateProcess(server.child, 'SIGTERM');
    await waitForClose(server.child, 1500);
    if (this.servers.has(id)) terminateProcess(server.child, 'SIGKILL');
    this.servers.delete(id);
    return true;
  }

  async stopPreview() {
    const ids = [...this.servers.keys()];
    for (const id of ids) await this.stopServer(id);
    return ids.length;
  }

  async dispose() {
    await this.stopPreview();
  }

  runProcess(command, executable, options) {
    if (options.signal?.aborted) return Promise.resolve(cancelledResult(command, options));
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(executable, options.args || [], {
        cwd: options.cwd,
        shell: Boolean(options.shell),
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const append = (current, chunk) => appendBounded(current, chunk, options.maxChars);
      child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener?.('abort', onAbort);
        if (error) reject(error);
        else resolve({ command, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: value, timedOut, cancelled, durationMs: Date.now() - start });
      };
      const onAbort = () => { cancelled = true; terminateProcess(child, 'SIGTERM'); };
      options.signal?.addEventListener?.('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; terminateProcess(child, 'SIGTERM'); }, options.timeoutMs);
      child.once('error', error => finish(null, error));
      child.once('close', code => finish(Number.isInteger(code) ? code : null));
      if (options.signal?.aborted) onAbort();
    });
  }
}

function parseExecutionDiagnostics(stdout, stderr, fallbackPath) {
  const text = `${String(stdout || '')}\n${String(stderr || '')}`;
  const diagnostics = [];
  const add = (file, line, column, message, severity = 'error') => {
    diagnostics.push({
      file: file || fallbackPath,
      line: line !== null && line !== undefined && Number.isInteger(Number(line)) ? Number(line) : null,
      column: column !== null && column !== undefined && Number.isInteger(Number(column)) ? Number(column) : null,
      severity,
      message: String(message || '').trim().slice(0, 1000)
    });
  };
  const seen = new Set();
  for (const match of text.matchAll(/(?:^|\n)([^\n(]+?)\((\d+),(\d+)\):\s*(error|warning)\s*[^:]*:\s*([^\n]+)/gi)) {
    const key = `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], match[3], match[5], match[4].toLowerCase()); }
  }
  for (const match of text.matchAll(/File ["']([^"']+)["'], line (\d+)/g)) {
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], null, text.split(/\r?\n/).find(line => /Error|Exception/.test(line)) || 'Python traceback'); }
  }
  for (const match of text.matchAll(/(?:^|\n)([^\s\n:]+\.go):(\d+):(\d+):\s*([^\n]+)/g)) {
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], match[3], match[4]); }
  }
  for (const match of text.matchAll(/(?:^|\n)([^\s\n:]+\.(?:js|mjs|cjs|ts|tsx|py|php|sh|bash)):(\d+)(?::(\d+))?(?:\s*[-|:]?\s*([^\n]+))?/gi)) {
    const key = `${match[1]}:${match[2]}:${match[3] || ''}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], match[3], match[4] || 'Execution error'); }
  }
  for (const match of text.matchAll(/in ([^\s\n]+\.php) on line (\d+)/gi)) {
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], null, text.split(/\r?\n/).find(line => /PHP (?:Fatal|Parse) error/.test(line)) || 'PHP execution error'); }
  }
  for (const match of text.matchAll(/(?:^|\n)([^\s\n]+\.sh): line (\d+):\s*([^\n]+)/g)) {
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) { seen.add(key); add(match[1], match[2], null, match[3]); }
  }
  if (!diagnostics.length && text.trim()) add(fallbackPath, null, null, text.trim().split(/\r?\n/).slice(-3).join('\n'));
  return diagnostics;
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string' || /[\0\r\n]/.test(argument))) {
    throw new Error('Structured execution requires a list of newline-free string arguments.');
  }
  return args;
}

function isAllowedRuntime(executable) {
  return executable === process.execPath || new Set(['npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'py', 'php', 'go', 'bash']).has(executable);
}

function cancelledResult(command, options) {
  return { command, stdout: '', stderr: '', exitCode: null, timedOut: false, cancelled: true, durationMs: 0 };
}

function pickPlan(plan) {
  return {
    path: plan.path,
    language: plan.language,
    kind: plan.kind,
    command: plan.command || [plan.runtime, ...(plan.args || [])].join(' '),
    projectConfig: plan.projectConfig || [],
    dependencies: plan.dependencies || []
  };
}

function appendBounded(current, chunk, maxChars) {
  const next = current + String(chunk);
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

function quoteForDisplay(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHttpServer(port, signal, timeoutMs, child, projectScript, server) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ready: false, cancelled: true, error: 'Preview startup cancelled.' };
    if (child.spawnError) return { ready: false, error: child.spawnError.message };
    if (child.exitCode !== null && child.exitCode !== undefined) return { ready: false, exitCode: child.exitCode, error: 'The preview server exited before becoming ready.' };
    if (projectScript && !`${server.stdout}\n${server.stderr}`.includes(`127.0.0.1:${port}`)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const ready = await probeHttpServer(port, projectScript);
    if (ready) return { ready: true };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { ready: false, timedOut: true, error: 'Timed out while waiting for the preview server.' };
}

function probeHttpServer(port, projectScript) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 300 }, response => {
      response.resume();
      const standardServer = /^SimpleHTTP\//i.test(String(response.headers.server || ''));
      const viteBanner = projectScript && response.statusCode >= 200 && response.statusCode < 500;
      resolve(response.statusCode >= 200 && response.statusCode < 500 && (standardServer || viteBanner));
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function terminateProcess(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

module.exports = { TerminalService, parseExecutionDiagnostics, validateArguments };
