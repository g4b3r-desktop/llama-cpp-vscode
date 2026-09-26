const vscode = require('vscode');
const { getConfig } = require('../config');

class PermissionService {
  constructor() { this.sessionApprovals = new Set(); }
  resetSession() { this.sessionApprovals.clear(); }
  assertTrusted(action) {
    if (!vscode.workspace.isTrusted) throw new Error(`Workspace Trust is required before the agent can ${action}. Trust the workspace and retry.`);
  }
  async confirmFileOperation(kind, detail) {
    this.assertTrusted(kind);
    const config = getConfig();
    const always = kind === 'delete_file' || kind === 'move_file';
    if (!always && !config.agent.confirmFileWrites) return true;
    return this.confirm(`file:${kind}`, `Agent wants to ${detail}`);
  }
  async confirmTerminal(command, dangerous = true) {
    this.assertTrusted('run terminal commands');
    const config = getConfig();
    if (!dangerous && !config.agent.confirmTerminalCommands) return true;
    return this.confirm('terminal', `Agent wants to run:\n\n${command}`);
  }
  async confirmRollback(detail) {
    this.assertTrusted('rollback changes');
    return this.confirm('rollback', detail);
  }
  async confirm(key, message) {
    if (this.sessionApprovals.has(key)) return true;
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Allow once', 'Allow for this agent session');
    if (choice === 'Allow for this agent session') { this.sessionApprovals.add(key); return true; }
    if (choice === 'Allow once') return true;
    throw new Error('Operation was not approved by the user.');
  }
}
module.exports = { PermissionService };
