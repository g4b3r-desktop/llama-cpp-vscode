const vscode = require('vscode');
const { getConfig } = require('../config');
const { buildChatContext } = require('../chatPanel');
const { normalizeMode, includeHistoryForMode, buildAgentPrompt, modeLabel } = require('./requestMode');

const VIEW_ID = 'llamaCpp.assistantView';

class AssistantViewProvider {
  constructor(client, workspaceIndex, agentController, extensionUri, output) {
    this.client = client;
    this.workspaceIndex = workspaceIndex;
    this.agentController = agentController;
    this.extensionUri = extensionUri;
    this.output = output;
    this.view = undefined;
    this.history = [];
    this.transcript = [];
    this.activeRequest = undefined;
    this.requestSerial = 0;
    this.lastFileEditor = undefined;
    this.pendingCompose = undefined;
    this.editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document?.uri?.scheme === 'file') this.lastFileEditor = editor;
      this.postEditorState();
    });
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => this.onMessage(message));
    webviewView.onDidDispose(() => {
      this.activeRequest?.abort();
      if (this.view === webviewView) this.view = undefined;
    });
  }

  async focus(initialPrompt, mode = 'ask', options = {}) {
    this.rememberActiveFileEditor();
    this.pendingCompose = initialPrompt ? { text: String(initialPrompt), mode: normalizeMode(mode), includeActiveFile: options.includeActiveFile } : undefined;
    try { await vscode.commands.executeCommand(`${VIEW_ID}.focus`); }
    catch { await vscode.commands.executeCommand('workbench.view.extension.llamaCppAssistant'); }
    this.postEditorState();
    this.flushPendingCompose();
  }

  dispose() {
    this.activeRequest?.abort();
    this.editorListener?.dispose();
  }

  async onMessage(message) {
    if (message?.type === 'ask' && typeof message.text === 'string') {
      await this.handleAsk(message.text, {
        mode: message.mode,
        includeActiveFile: Boolean(message.includeActiveFile),
        includeHistory: Boolean(message.includeHistory)
      });
    } else if (message?.type === 'clear') {
      this.history = [];
      this.transcript = [];
      this.post({ type: 'cleared' });
    } else if (message?.type === 'cancel') {
      this.activeRequest?.abort();
    } else if (message?.type === 'reindex') {
      await this.reindex();
    } else if (message?.type === 'ready') {
      this.post({ type: 'hydrate', transcript: this.transcript });
      this.postEditorState();
      this.postProviderState();
      this.flushPendingCompose();
    } else if (message?.type === 'openLink' && typeof message.url === 'string') {
      await this.openExternalLink(message.url);
    } else if (message?.type === 'manageProvider') {
      await vscode.commands.executeCommand('llamaCpp.manageProvider');
      this.postProviderState();
    } else if (message?.type === 'rollback') {
      await this.rollback();
    }
  }

  rememberActiveFileEditor() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document?.uri?.scheme === 'file') this.lastFileEditor = editor;
  }

  getContextEditor() {
    const active = vscode.window.activeTextEditor;
    if (active?.document?.uri?.scheme === 'file') {
      this.lastFileEditor = active;
      return active;
    }
    if (this.lastFileEditor?.document?.uri?.scheme === 'file') {
      const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === this.lastFileEditor.document.uri.toString());
      if (visible) {
        this.lastFileEditor = visible;
        return visible;
      }
    }
    const fallback = vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'file');
    if (fallback) this.lastFileEditor = fallback;
    return fallback;
  }

  postEditorState() {
    if (!this.view) return;
    const editor = this.getContextEditor();
    const hasFile = Boolean(editor && editor.document.uri.scheme === 'file');
    const filename = hasFile ? vscode.workspace.asRelativePath(editor.document.uri, true) : '';
    const config = getConfig();
    this.post({
      type: 'editorState',
      hasFile,
      filename,
      defaultIncludeActiveFile: config.chat.includeEditorContext,
      defaultIncludeHistory: config.chat.includeHistory
    });
  }

  postProviderState() {
    const config = getConfig();
    this.post({
      type: 'providerState',
      provider: config.provider,
      label: config.provider === 'openai' ? `OpenAI · ${config.openai.model}` : `llama.cpp${config.api.model ? ` · ${config.api.model}` : ''}`
    });
  }

  flushPendingCompose() {
    if (!this.view || !this.pendingCompose) return;
    this.post({ type: 'compose', ...this.pendingCompose });
    this.pendingCompose = undefined;
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }

  async handleAsk(rawText, options = {}) {
    const text = String(rawText || '').trim();
    if (!text || !this.view) return;
    const config = getConfig();
    const mode = normalizeMode(options.mode);
    const includeActiveFile = typeof options.includeActiveFile === 'boolean' ? options.includeActiveFile : config.chat.includeEditorContext;
    const requestedHistory = typeof options.includeHistory === 'boolean' ? options.includeHistory : config.chat.includeHistory;
    const includeHistory = includeHistoryForMode(mode, requestedHistory);
    const activeEditor = this.getContextEditor();
    const activeFilename = activeEditor?.document?.uri?.scheme === 'file' ? vscode.workspace.asRelativePath(activeEditor.document.uri, true) : '';

    this.activeRequest?.abort();
    const controller = new AbortController();
    this.activeRequest = controller;
    const requestId = `sidebar-${++this.requestSerial}`;
    const userEntry = { role: 'user', text, mode, meta: `${modeLabel(mode)} · ${includeActiveFile && activeFilename ? activeFilename : 'sem arquivo automático'}` };
    this.transcript.push(userEntry);
    this.post({ type: 'user', ...userEntry, includeHistory, activeFilename });
    this.post({ type: 'busy', value: true, mode });

    try {
      if (mode === 'agent' || mode === 'research') {
        await this.handleAgentRequest(text, mode, includeActiveFile, activeEditor, controller, requestId);
      } else {
        await this.handleChatRequest(text, mode, includeActiveFile, includeHistory, activeEditor, controller, requestId);
      }
    } catch (error) {
      if (controller.signal.aborted) this.post({ type: 'notice', text: 'Solicitação cancelada.' });
      else {
        this.client.logError('assistant sidebar', error);
        this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
      this.post({ type: 'busy', value: false, mode });
    }
  }

  async handleChatRequest(text, mode, includeActiveFile, includeHistory, activeEditor, controller, requestId) {
    const config = getConfig();
    const context = await buildChatContext(text, this.workspaceIndex, controller.signal, { includeActiveFile, editor: activeEditor });
    if (context.mentionedFiles.length) this.post({ type: 'notice', text: `Usando @file: ${context.mentionedFiles.join(', ')}` });
    if (context.unresolvedMentions.length) this.post({ type: 'notice', text: `@file não encontrado: ${context.unresolvedMentions.join(', ')}` });
    const userMessage = context.text ? `${text}\n\n${context.text}` : text;
    const messages = [
      { role: 'system', content: 'You are llama.cpp Assistant inside Visual Studio Code. Be precise, practical and code-aware. Use supplied editor/workspace context when relevant. Use GitHub-flavored Markdown. Do not claim to have read files that were not supplied.' },
      ...(includeHistory ? this.history : []),
      { role: 'user', content: userMessage }
    ];
    this.post({ type: 'assistantStart', id: requestId });
    let answer = '';
    if (config.chat.streaming) {
      answer = await this.client.chatStream(messages, controller.signal, delta => this.post({ type: 'assistantDelta', id: requestId, text: delta }));
    } else {
      answer = await this.client.chat(messages, controller.signal);
      if (answer) this.post({ type: 'assistantDelta', id: requestId, text: answer });
    }
    const finalAnswer = answer || '(resposta vazia)';
    this.post({ type: 'assistantDone', id: requestId });
    this.transcript.push({ role: 'assistant', text: finalAnswer, mode });
    if (mode === 'ask') {
      this.history.push({ role: 'user', content: text }, { role: 'assistant', content: finalAnswer });
      this.history = this.history.slice(-12);
    }
  }

  async handleAgentRequest(text, mode, includeActiveFile, activeEditor, controller, requestId) {
    let contextText = '';
    if (includeActiveFile && activeEditor?.document?.uri?.scheme === 'file') {
      const context = await buildChatContext(text, this.workspaceIndex, controller.signal, { includeActiveFile: true, editor: activeEditor });
      contextText = context.text ? `Explicit editor/workspace context:\n${context.text}` : '';
    }
    const prompt = buildAgentPrompt(mode, text, contextText);
    this.post({ type: 'assistantStart', id: requestId });
    const result = await this.agentController.run(prompt, {
      signal: controller.signal,
      onAction: event => this.post({ type: 'agentProgress', event })
    });
    const answer = result.answer || 'Tarefa concluída.';
    this.post({ type: 'assistantDelta', id: requestId, text: answer });
    this.post({ type: 'assistantDone', id: requestId });
    this.transcript.push({ role: 'assistant', text: answer, mode, plan: result.plan, verification: result.verification });
    this.post({ type: 'agentResult', plan: result.plan, verification: result.verification, steps: result.steps });
  }

  async reindex() {
    try {
      const result = await this.workspaceIndex.reindex(true);
      this.post({ type: 'notice', text: `RAG: ${result.files} arquivos, ${result.chunks} chunks.` });
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async rollback() {
    try {
      const result = await this.agentController.rollback();
      this.post({ type: 'notice', text: `Rollback concluído: ${result.changes} alteração(ões).` });
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async openExternalLink(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
    try { await vscode.env.openExternal(vscode.Uri.parse(url, true)); }
    catch (error) { this.client.logError('open sidebar link', error); }
  }

  html(webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}`;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${csp}"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><link rel="stylesheet" href="${styleUri}"/><title>llama.cpp Assistant</title></head><body><div id="app"><header><div><strong>llama.cpp Assistant</strong><div id="provider-label">Carregando provider…</div></div><button id="provider" class="icon-button" title="Trocar provider">⚙</button></header><div id="agent-progress" class="agent-progress hidden"></div><main id="messages" aria-live="polite"></main><section id="composer"><div class="mode-row"><select id="mode" aria-label="Modo"><option value="ask">Ask</option><option value="agent">Agent</option><option value="research">Research</option><option value="fresh">Fresh</option></select><button id="rollback" class="secondary" title="Rollback da última sessão do agente">Rollback</button></div><textarea id="input" aria-label="Prompt" placeholder="Pergunte, peça uma alteração ou use @arquivo…"></textarea><label id="active-file-wrap" class="toggle"><input id="include-active-file" type="checkbox"/><span>Arquivo atual</span><strong id="active-file-name"></strong></label><label id="history-wrap" class="toggle"><input id="include-history" type="checkbox"/><span>Usar conversa anterior</span></label><div class="actions"><button id="send">Enviar</button><button id="cancel" class="secondary">Cancelar</button><button id="reindex" class="secondary">Reindexar</button><button id="clear" class="secondary">Limpar</button><span id="status"></span></div></section></div><script src="${scriptUri}"></script></body></html>`;
  }
}

module.exports = { AssistantViewProvider, VIEW_ID };
