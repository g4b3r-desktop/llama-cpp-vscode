const { spawn } = require('child_process');
const { getConfig } = require('../config');

class TerminalService {
  constructor(rootPath, permissions, output) { this.rootPath = rootPath; this.permissions = permissions; this.output = output; }
  async run(command, signal) {
    const text = String(command || '').trim();
    if (!text) throw new Error('Terminal command is empty.');
    const dangerous = isDangerousCommand(text);
    await this.permissions.confirmTerminal(text, dangerous);
    const config = getConfig();
    const timeoutMs = Math.max(1000, Number(config.agent.terminalTimeoutMs || 120000));
    const maxChars = Math.max(1000, Number(config.agent.maxTerminalOutputCharacters || 40000));
    this.output?.appendLine(`[agent:terminal] ${text}`);
    return new Promise((resolve, reject) => {
      const child = spawn(text, { cwd: this.rootPath, shell: true, windowsHide: true, env: process.env });
      let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
      const append = (target, chunk) => { const next = target + String(chunk); return next.length > maxChars ? next.slice(next.length - maxChars) : next; };
      child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => { child.kill(); finish(undefined, new Error('Terminal command cancelled.')); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.on('error', error => finish(undefined, error));
      child.on('close', (code, signalName) => finish({ command: text, exitCode: Number.isInteger(code) ? code : null, signal: signalName || null, timedOut, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }));
    });
  }
}
function isDangerousCommand(command) {
  return [/(^|\s)(sudo|su)(\s|$)/i,/\brm\s+-[^\n]*r/i,/\b(del|erase|rmdir|rd)\b/i,/\bgit\s+(reset\s+--hard|clean\s+-|checkout\s+--|restore\s+--source)/i,/\b(chmod|chown|mkfs|diskpart|format)\b/i,/\b(curl|wget)\b[^\n|]*(\||;|&&)\s*(sh|bash|zsh|powershell|pwsh)\b/i,/\b(npm|pnpm|yarn|pip|pip3|cargo|gem|composer)\s+(install|add|remove|uninstall)\b/i,/(^|[^>])>{1,2}\s*[^&]/].some(pattern => pattern.test(command));
}
module.exports = { TerminalService, isDangerousCommand };
