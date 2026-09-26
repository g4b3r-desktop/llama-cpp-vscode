const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class AgentHistory {
  constructor(context, permissions, output) { this.context = context; this.permissions = permissions; this.output = output; this.session = undefined; }
  async beginSession(rootPath, prompt) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const storageRoot = this.context.storageUri?.fsPath || this.context.globalStorageUri.fsPath;
    const folder = path.join(storageRoot, 'agent-backups', id);
    await fs.mkdir(folder, { recursive: true });
    this.session = { id, rootPath, prompt, folder, records: [], startedAt: new Date().toISOString(), completed: false };
    await this.persist();
    await this.context.workspaceState.update('llamaCpp.agent.lastSessionId', id);
    await this.context.workspaceState.update('llamaCpp.agent.lastSessionRoot', rootPath);
    return id;
  }
  async recordChange(relativePath, beforeBytes, afterBytes, kind = 'write') {
    if (!this.session) throw new Error('No active agent history session.');
    const index = this.session.records.length;
    let backupFile = null;
    if (beforeBytes !== null && beforeBytes !== undefined) {
      backupFile = `${String(index).padStart(4,'0')}.bak`;
      await fs.writeFile(path.join(this.session.folder, backupFile), beforeBytes);
    }
    const record = { index, kind, path: relativePath, beforeAbsent: beforeBytes === null || beforeBytes === undefined, backupFile, afterAbsent: afterBytes === null || afterBytes === undefined, afterHash: afterBytes === null || afterBytes === undefined ? null : sha256(afterBytes) };
    this.session.records.push(record);
    await this.persist();
    return record;
  }
  async recordDirectory(relativePath) {
    if (!this.session) throw new Error('No active agent history session.');
    this.session.records.push({ index: this.session.records.length, kind: 'mkdir', path: relativePath });
    await this.persist();
  }
  async complete(success = true) {
    if (!this.session) return;
    this.session.completed = true; this.session.success = success; this.session.completedAt = new Date().toISOString();
    await this.persist();
  }
  async rollback(workspaceService) {
    const session = this.session || await this.loadLastSession();
    if (!session || !session.records.length) throw new Error('No agent changes are available to roll back.');
    await this.permissions.confirmRollback(`Roll back ${session.records.length} change(s) from the last llama.cpp agent session?`);
    for (const record of [...session.records].reverse()) {
      if (record.kind === 'mkdir') { await workspaceService.rollbackDirectory(record.path); continue; }
      let beforeBytes = null;
      if (!record.beforeAbsent && record.backupFile) beforeBytes = await fs.readFile(path.join(session.folder, record.backupFile));
      await workspaceService.rollbackFile(record.path, beforeBytes, record.afterHash, record.afterAbsent);
    }
    session.rolledBackAt = new Date().toISOString(); this.session = session; await this.persist();
    return { sessionId: session.id, changes: session.records.length };
  }
  async loadLastSession() {
    const id = this.context.workspaceState.get('llamaCpp.agent.lastSessionId');
    const rootPath = this.context.workspaceState.get('llamaCpp.agent.lastSessionRoot');
    if (!id || !rootPath) return undefined;
    const storageRoot = this.context.storageUri?.fsPath || this.context.globalStorageUri.fsPath;
    const folder = path.join(storageRoot, 'agent-backups', id);
    try { const data = JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8')); return { ...data, folder, rootPath }; } catch { return undefined; }
  }
  async persist() {
    if (!this.session) return;
    const { folder, ...serializable } = this.session;
    await fs.writeFile(path.join(folder,'manifest.json'), JSON.stringify(serializable,null,2), 'utf8');
  }
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
module.exports = { AgentHistory, sha256 };
