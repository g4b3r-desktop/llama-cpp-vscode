const { spawn } = require('node:child_process');
const { getConfig, openAiEndpoint } = require('./config');
const { requestJson } = require('./http');

class LocalServerManager {
  constructor(output) { this.output = output; this.process = undefined; this.starting = undefined; }
  async ensureReady() {
    const config = getConfig();
    if (config.mode !== 'local' || await this.isReady()) return;
    if (!config.local.autoStart) throw new Error(`No llama-server is responding at ${openAiEndpoint('/v1/models', config)} and local.autoStart is disabled.`);
    if (!String(config.local.modelPath).trim()) throw new Error('Set "llamaCpp.local.modelPath" to a GGUF model, or start llama-server manually and disable local.autoStart.');
    if (!this.starting) this.starting = this.startServer().finally(() => { this.starting = undefined; });
    await this.starting;
  }
  async isReady() {
    const config = getConfig();
    try { await requestJson(openAiEndpoint('/v1/models', config), { method: 'GET' }, Math.min(config.request.timeoutMs, 1500)); return true; } catch { return false; }
  }
  async startServer() {
    const config = getConfig();
    const args = ['-m', config.local.modelPath, '--host', config.local.host, '--port', String(config.local.port), ...config.local.args];
    this.output.appendLine(`[local] Starting: ${config.local.executable} ${args.map(quote).join(' ')}`);
    this.process = spawn(config.local.executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.process.stdout.on('data', data => this.output.append(data.toString()));
    this.process.stderr.on('data', data => this.output.append(data.toString()));
    this.process.on('error', error => this.output.appendLine(`[local] Failed to start llama-server: ${error.message}`));
    this.process.on('exit', (code, signal) => { this.output.appendLine(`[local] llama-server exited (code=${code}, signal=${signal}).`); this.process = undefined; });
    const deadline = Date.now() + Math.min(config.request.timeoutMs, 120000);
    while (Date.now() < deadline) {
      if (await this.isReady()) { this.output.appendLine('[local] llama-server is ready.'); return; }
      if (!this.process || this.process.exitCode !== null) throw new Error('llama-server stopped before becoming ready. Open "llama.cpp Assistant" output for details.');
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    throw new Error('Timed out waiting for llama-server to become ready.');
  }
  dispose() { if (this.process && this.process.exitCode === null) { this.output.appendLine('[local] Stopping llama-server started by the extension.'); this.process.kill(); } }
}
function quote(value) { return /\s/.test(value) ? JSON.stringify(value) : value; }
module.exports = { LocalServerManager };
