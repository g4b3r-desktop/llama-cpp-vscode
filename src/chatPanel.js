const vscode = require('vscode');
const { getConfig } = require('./config');
const { normalizeMode, includeHistoryForMode, buildAgentPrompt, modeLabel } = require('./sidebar/requestMode');
const {
  trimHistory,
  removeLatestHistoryExchange,
  removeLatestTranscriptExchange,
  providerPresentation
} = require('./chat/classicChatUtils');

class ChatPanel {
  constructor(client, workspaceIndex, extensionUri, agentController) {
    this.client = client;
    this.workspaceIndex = workspaceIndex;
    this.extensionUri = extensionUri;
    this.agentController = agentController;
    this.panel = undefined;
    this.history = [];
    this.transcript = [];
    this.activeRequest = undefined;
    this.requestSerial = 0;
    this.editorListener = undefined;
    this.lastFileEditor = undefined;
  }

  open(initialPrompt, options = {}) {
    this.rememberActiveFileEditor();
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postEditorState();
      this.postProviderState();
      this.postRagState();
      if (initialPrompt) void this.handleAsk(initialPrompt, options);
      return;
    }

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'llamaCppChat',
      'llama.cpp Classic Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));

    this.editorListener?.dispose();
    this.editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document?.uri?.scheme === 'file') this.lastFileEditor = editor;
      this.postEditorState();
    });

    this.panel.onDidDispose(() => {
      this.activeRequest?.abort();
      this.editorListener?.dispose();
      this.editorListener = undefined;
      this.panel = undefined;
    });

    if (initialPrompt) void this.handleAsk(initialPrompt, options);
  }

  dispose() {
    this.activeRequest?.abort();
    this.editorListener?.dispose();
    this.editorListener = undefined;
    this.panel?.dispose();
  }

  async onMessage(message) {
    if (message?.type === 'ask' && typeof message.text === 'string') {
      await this.handleAsk(message.text, {
        mode: message.mode,
        includeActiveFile: Boolean(message.includeActiveFile),
        includeHistory: Boolean(message.includeHistory)
      });
    } else if (message?.type === 'regenerate' && typeof message.text === 'string') {
      await this.handleAsk(message.text, {
        mode: message.mode,
        includeActiveFile: Boolean(message.includeActiveFile),
        includeHistory: Boolean(message.includeHistory),
        regenerate: true
      });
    } else if (message?.type === 'clear' || message?.type === 'newConversation') {
      this.clearConversation();
    } else if (message?.type === 'cancel') {
      this.activeRequest?.abort();
    } else if (message?.type === 'reindex') {
      await this.reindexFromChat();
    } else if (message?.type === 'ready') {
      this.post({ type: 'hydrate', transcript: this.transcript });
      this.postEditorState();
      this.postProviderState();
      this.postRagState();
    } else if (message?.type === 'openLink' && typeof message.url === 'string') {
      await this.openExternalLink(message.url);
    } else if (message?.type === 'openAssistant') {
      await vscode.commands.executeCommand('llamaCpp.openAssistantView');
    } else if (message?.type === 'manageProvider') {
      await vscode.commands.executeCommand('llamaCpp.manageProvider');
      this.postProviderState();
    } else if (message?.type === 'testConnection') {
      await this.testConnection();
    } else if (message?.type === 'rollback') {
      await this.rollback();
    } else if (message?.type === 'copy' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      this.post({ type: 'copied' });
    }
  }

  post(message) {
    this.panel?.webview.postMessage(message);
  }

  clearConversation() {
    this.activeRequest?.abort();
    this.history = [];
    this.transcript = [];
    this.post({ type: 'cleared' });
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
    if (!this.panel) return;
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

  postProviderState(connection) {
    if (!this.panel) return;
    const presentation = providerPresentation(getConfig());
    this.post({ type: 'providerState', ...presentation, connection: connection || 'idle' });
  }

  postRagState() {
    if (!this.panel) return;
    const status = this.workspaceIndex.status();
    this.post({
      type: 'ragState',
      enabled: Boolean(status.enabled),
      strategy: status.strategy || 'auto',
      files: Number(status.files || 0),
      chunks: Number(status.chunks || 0),
      vectors: Number(status.vectors || 0),
      vectorFallback: Boolean(status.vectorError)
    });
  }

  async testConnection() {
    this.postProviderState('checking');
    try {
      const models = await this.client.testConnection();
      this.postProviderState('ok');
      this.post({ type: 'notice', text: models.length ? `Conexão OK · ${models.slice(0, 5).join(', ')}` : 'Conexão OK.' });
    } catch (error) {
      this.postProviderState('error');
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async openExternalLink(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
    try { await vscode.env.openExternal(vscode.Uri.parse(url, true)); }
    catch (error) { this.client.logError('open classic chat link', error); }
  }

  async reindexFromChat() {
    try {
      const result = await this.workspaceIndex.reindex(true);
      this.post({ type: 'notice', text: `RAG reindexado: ${result.files} arquivos, ${result.chunks} chunks, ${result.vectors || 0} vetores.` });
      this.postRagState();
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async rollback() {
    if (!this.agentController) return;
    try {
      const result = await this.agentController.rollback();
      this.post({ type: 'notice', text: `Rollback concluído: ${result.changes} alteração(ões).` });
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async handleAsk(rawText, options = {}) {
    const text = String(rawText || '').trim();
    if (!text || !this.panel) return;

    const config = getConfig();
    const mode = normalizeMode(options.mode);
    const includeActiveFile = typeof options.includeActiveFile === 'boolean' ? options.includeActiveFile : config.chat.includeEditorContext;
    const requestedHistory = typeof options.includeHistory === 'boolean' ? options.includeHistory : config.chat.includeHistory;
    const includeHistory = includeHistoryForMode(mode, requestedHistory);
    const activeEditor = this.getContextEditor();
    const activeFilename = activeEditor?.document?.uri?.scheme === 'file' ? vscode.workspace.asRelativePath(activeEditor.document.uri, true) : '';

    if (options.regenerate) {
      this.history = removeLatestHistoryExchange(this.history, text);
      this.transcript = removeLatestTranscriptExchange(this.transcript, text);
      this.post({ type: 'removeLastExchange', text });
    }

    this.activeRequest?.abort();
    const controller = new AbortController();
    this.activeRequest = controller;
    const requestId = `classic-${++this.requestSerial}`;
    const request = { text, mode, includeActiveFile, includeHistory };
    const timestamp = Date.now();
    const userEntry = {
      role: 'user',
      text,
      mode,
      includeActiveFile: Boolean(includeActiveFile && activeFilename),
      includeHistory,
      activeFilename,
      timestamp,
      meta: `${modeLabel(mode)} · ${includeActiveFile && activeFilename ? activeFilename : 'sem arquivo automático'}`
    };
    this.transcript.push(userEntry);
    this.post({ type: 'user', ...userEntry, request });
    this.post({ type: 'busy', value: true, mode });

    try {
      if (mode === 'agent' || mode === 'research') {
        await this.handleAgentRequest(text, mode, includeActiveFile, activeEditor, controller, requestId, request);
      } else {
        await this.handleChatRequest(text, mode, includeActiveFile, includeHistory, activeEditor, controller, requestId, request);
      }
    } catch (error) {
      this.post({ type: 'assistantAbort', id: requestId });
      if (controller.signal.aborted) {
        this.post({ type: 'notice', text: 'Solicitação cancelada.' });
      } else {
        this.client.logError('classic chat', error);
        this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
      this.post({ type: 'busy', value: false, mode });
    }
  }

  async handleChatRequest(text, mode, includeActiveFile, includeHistory, activeEditor, controller, requestId, request) {
    const config = getConfig();
    const context = await buildChatContext(text, this.workspaceIndex, controller.signal, { includeActiveFile, editor: activeEditor });
    if (context.mentionedFiles.length) this.post({ type: 'notice', text: `Usando @file: ${context.mentionedFiles.join(', ')}` });
    if (context.unresolvedMentions.length) this.post({ type: 'notice', text: `@file não encontrado: ${context.unresolvedMentions.join(', ')}` });

    const userMessage = context.text ? `${text}\n\n${context.text}` : text;
    const messages = [
      { role: 'system', content: 'You are llama.cpp Assistant inside Visual Studio Code. Be precise, practical and code-aware. Use supplied editor/workspace context when relevant. Format answers with GitHub-flavored Markdown, including tables and task lists when useful. Do not claim you read files that were not supplied.' },
      ...(includeHistory ? this.history : []),
      { role: 'user', content: userMessage }
    ];

    this.post({ type: 'assistantStart', id: requestId, request, timestamp: Date.now() });
    let answer = '';
    if (config.chat.streaming) {
      answer = await this.client.chatStream(messages, controller.signal, delta => this.post({ type: 'assistantDelta', id: requestId, text: delta }));
    } else {
      answer = await this.client.chat(messages, controller.signal);
      if (answer) this.post({ type: 'assistantDelta', id: requestId, text: answer });
    }

    const finalAnswer = answer || '(resposta vazia)';
    const assistantEntry = { role: 'assistant', text: finalAnswer, mode, timestamp: Date.now(), request };
    this.transcript.push(assistantEntry);
    if (mode === 'ask') {
      this.history.push({ role: 'user', content: text }, { role: 'assistant', content: finalAnswer });
      this.history = trimHistory(this.history, 12);
    }
    this.post({ type: 'assistantDone', id: requestId, timestamp: assistantEntry.timestamp });
  }

  async handleAgentRequest(text, mode, includeActiveFile, activeEditor, controller, requestId, request) {
    if (!this.agentController) throw new Error('Agent Mode não está disponível nesta sessão.');
    let contextText = '';
    if (includeActiveFile && activeEditor?.document?.uri?.scheme === 'file') {
      const context = await buildChatContext(text, this.workspaceIndex, controller.signal, { includeActiveFile: true, editor: activeEditor });
      contextText = context.text ? `Explicit editor/workspace context:\n${context.text}` : '';
    }

    const prompt = buildAgentPrompt(mode, text, contextText);
    this.post({ type: 'assistantStart', id: requestId, request, timestamp: Date.now() });
    const result = await this.agentController.run(prompt, {
      signal: controller.signal,
      onAction: event => this.post({ type: 'agentProgress', event })
    });
    const answer = result.answer || 'Tarefa concluída.';
    this.post({ type: 'assistantDelta', id: requestId, text: answer });
    const assistantEntry = { role: 'assistant', text: answer, mode, timestamp: Date.now(), request, plan: result.plan, verification: result.verification };
    this.transcript.push(assistantEntry);
    this.post({ type: 'assistantDone', id: requestId, timestamp: assistantEntry.timestamp });
    this.post({ type: 'agentResult', plan: result.plan, verification: result.verification, steps: result.steps });
  }

  html(webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}`;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${csp}"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><link rel="stylesheet" href="${styleUri}"/><title>llama.cpp Classic Chat</title></head><body><div id="app"><header class="topbar"><div class="brand"><div class="brand-mark">λ</div><div><div class="brand-title">llama.cpp Classic Chat</div><div class="provider-line"><span id="connection-dot" class="connection-dot idle"></span><button id="provider-label" class="provider-link">Carregando provider…</button></div></div></div><div class="header-actions"><button id="test-connection" class="icon-button" title="Testar conexão" aria-label="Testar conexão">◉</button><button id="open-assistant" class="icon-button" title="Abrir aba principal" aria-label="Abrir aba principal">↗</button><button id="new-chat" class="icon-button" title="Nova conversa" aria-label="Nova conversa">＋</button></div></header><section id="agent-progress" class="agent-progress hidden" aria-live="polite"></section><main id="messages" aria-live="polite"></main><section id="composer-shell"><div class="mode-tabs" role="tablist" aria-label="Modo do chat"><button class="mode-button active" data-mode="ask" role="tab" aria-selected="true">Ask</button><button class="mode-button" data-mode="fresh" role="tab" aria-selected="false">Fresh</button><button class="mode-button" data-mode="research" role="tab" aria-selected="false">Research</button><button class="mode-button" data-mode="agent" role="tab" aria-selected="false">Agent</button></div><div class="composer-card"><textarea id="input" rows="1" aria-label="Prompt do chat" placeholder="Pergunte sobre seu código…"></textarea><div class="context-strip"><label id="active-file-wrap" class="context-chip"><input id="include-active-file" type="checkbox"/><span>Arquivo</span><strong id="active-file-name">Nenhum</strong></label><label id="history-wrap" class="context-chip"><input id="include-history" type="checkbox"/><span>Histórico</span></label><button id="rag-chip" class="context-chip button-chip" title="Reindexar RAG"><span>RAG</span><strong id="rag-status">…</strong></button></div><div class="composer-footer"><div class="footer-left"><span id="status">Pronto</span><span class="shortcut">Enter envia · Shift+Enter quebra linha</span></div><div class="footer-actions"><button id="rollback" class="secondary compact" title="Rollback da última sessão do Agent">Rollback</button><button id="cancel" class="secondary compact">Cancelar</button><button id="send" class="primary">Enviar</button></div></div></div></section><div id="toast" class="toast hidden" role="status"></div></div><script src="${scriptUri}"></script></body></html>`;
  }
}

async function buildChatContext(question, workspaceIndex, signal, options = {}) {
  const config = getConfig();
  const blocks = [];
  const editor = options.editor || vscode.window.activeTextEditor;
  const activeUri = editor?.document?.uri?.scheme === 'file' ? editor.document.uri : undefined;
  const includeActiveFile = typeof options.includeActiveFile === 'boolean' ? options.includeActiveFile : config.chat.includeEditorContext;
  let retrievalHint = question;
  const visibleFileUris = vscode.window.visibleTextEditors.filter(item => item.document.uri.scheme === 'file').map(item => item.document.uri);

  const mentioned = await workspaceIndex.getMentionedFileContext(question, config.chat.mentionedFilesMaxCharacters, config.chat.maxMentionedFiles);
  if (mentioned.context) blocks.push(mentioned.context);

  if (includeActiveFile && editor && editor.document.uri.scheme === 'file') {
    let text;
    let label;
    if (!editor.selection.isEmpty) {
      text = editor.document.getText(editor.selection);
      label = 'Selected code';
      retrievalHint += `\n${text.slice(0, 5000)}`;
    } else {
      text = editor.document.getText();
      label = 'Active file';
      retrievalHint += `\n${editor.document.lineAt(editor.selection.active.line).text}`;
    }
    if (text.length > config.chat.maxContextCharacters) text = text.slice(0, config.chat.maxContextCharacters);
    blocks.push([
      `<editor_context file="${escapeAttr(vscode.workspace.asRelativePath(editor.document.uri, true))}" language="${escapeAttr(editor.document.languageId)}">`,
      `${label}:`,
      text,
      '</editor_context>'
    ].join('\n'));
  }

  if (includeActiveFile && config.chat.includeVisibleEditors) {
    let remaining = config.chat.maxVisibleContextCharacters;
    let count = 0;
    for (const visible of vscode.window.visibleTextEditors) {
      if (count >= config.chat.maxVisibleFiles || remaining <= 0) break;
      if (visible.document.uri.scheme !== 'file') continue;
      if (activeUri && visible.document.uri.toString() === activeUri.toString()) continue;
      const text = visible.document.getText().slice(0, remaining);
      if (!text.trim()) continue;
      blocks.push([
        `<visible_editor file="${escapeAttr(vscode.workspace.asRelativePath(visible.document.uri, true))}" language="${escapeAttr(visible.document.languageId)}">`,
        text,
        '</visible_editor>'
      ].join('\n'));
      remaining -= text.length;
      count += 1;
    }
  }

  if (config.rag.enabled) {
    const blocked = new Set();
    if (includeActiveFile) {
      if (activeUri) blocked.add(activeUri.toString());
    } else {
      visibleFileUris.forEach(uri => blocked.add(uri.toString()));
    }
    const extra = Math.min(blocked.size, config.rag.topK);
    let results = await workspaceIndex.search(retrievalHint, { topK: config.rag.topK + extra, signal, excludeUri: includeActiveFile ? activeUri : undefined });
    if (blocked.size) results = results.filter(item => !blocked.has(item.uri?.toString())).slice(0, config.rag.topK);
    const workspaceContext = workspaceIndex.formatForChat(results, config.chat.workspaceContextCharacters);
    if (workspaceContext) blocks.push(workspaceContext);
  }

  return { text: blocks.join('\n\n'), mentionedFiles: mentioned.files, unresolvedMentions: mentioned.unresolved };
}

function escapeAttr(value) {
  return String(value).replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]));
}

module.exports = { ChatPanel, buildChatContext };
