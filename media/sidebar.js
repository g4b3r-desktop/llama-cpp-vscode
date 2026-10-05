(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const mode = document.getElementById('mode');
  const sendButton = document.getElementById('send');
  const cancelButton = document.getElementById('cancel');
  const status = document.getElementById('status');
  const progress = document.getElementById('agent-progress');
  const activeFileToggle = document.getElementById('include-active-file');
  const historyToggle = document.getElementById('include-history');
  const activeFileName = document.getElementById('active-file-name');
  const activeFileWrap = document.getElementById('active-file-wrap');
  const historyWrap = document.getElementById('history-wrap');
  const providerLabel = document.getElementById('provider-label');
  const assistantNodes = new Map();
  const savedState = vscode.getState() || {};
  let initialized = false;
  let hydrated = false;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderInline(value) {
    let text = escapeHtml(value);
    const code = [];
    text = text.replace(/`([^`]+)`/g, (_, v) => { code.push(v); return `@@CODE${code.length - 1}@@`; });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="#" data-external="$2">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${escapeHtml(code[Number(i)] || '')}</code>`);
    return text;
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line.trim())) {
        const lang = line.trim().slice(3).trim();
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
        if (i < lines.length) i += 1;
        out.push(`<pre><code data-language="${escapeHtml(lang)}">${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { const n = heading[1].length; out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`); i += 1; continue; }
      const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
      if (list) {
        const ordered = /^\d/.test(list[1]);
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
          if (!m || /^\d/.test(m[1]) !== ordered) break;
          items.push(m[2]); i += 1;
        }
        out.push(`<${tag}>${items.map(x => `<li>${renderInline(x)}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      const paragraph = [line]; i += 1;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i].trim()) && !/^\s*([-+*]|\d+[.)])\s+/.test(lines[i])) paragraph.push(lines[i++]);
      out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }
  function add(kind, text, markdown = false, meta = '') {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    const body = document.createElement('div');
    body.className = markdown ? 'markdown-body' : '';
    if (markdown) body.innerHTML = renderMarkdown(text); else body.textContent = text;
    div.appendChild(body);
    if (meta) { const info = document.createElement('div'); info.className = 'message-meta'; info.textContent = meta; div.appendChild(info); }
    messages.appendChild(div); scrollBottom();
  }

  function addAssistant(id) {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const body = document.createElement('div');
    body.className = 'markdown-body';
    div.appendChild(body);
    messages.appendChild(div);
    assistantNodes.set(id, { node: body, raw: '' });
    scrollBottom();
  }

  function currentMode() { return mode.value || 'ask'; }
  function updateModeUi() {
    const selected = currentMode();
    const historyAllowed = selected === 'ask';
    historyToggle.disabled = !historyAllowed;
    historyWrap.classList.toggle('disabled', !historyAllowed);
    if (!historyAllowed) historyToggle.checked = false;
    const placeholder = {
      ask: 'Pergunte sobre o código ou projeto…',
      agent: 'Descreva uma tarefa para o agente executar e validar…',
      research: 'Informe um assunto para pesquisa detalhada na web…',
      fresh: 'Pergunta isolada, sem histórico anterior…'
    }[selected];
    input.placeholder = placeholder;
    saveState();
  }

  function saveState() {
    vscode.setState({
      mode: currentMode(),
      includeActiveFile: Boolean(activeFileToggle.checked),
      includeHistory: Boolean(historyToggle.checked)
    });
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({
      type: 'ask',
      text,
      mode: currentMode(),
      includeActiveFile: Boolean(activeFileToggle.checked && !activeFileToggle.disabled),
      includeHistory: Boolean(historyToggle.checked && !historyToggle.disabled)
    });
    input.value = '';
  }

  function renderPlan(plan, phase) {
    if (!plan?.steps?.length) return;
    const lines = plan.steps.map(step => {
      const icon = step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : step.status === 'failed' ? '✗' : '○';
      return `<div class="plan-step ${escapeHtml(step.status || 'pending')}"><span>${icon}</span><span>${escapeHtml(step.title || '')}</span></div>`;
    });
    progress.innerHTML = `<div class="progress-title">${escapeHtml(phase === 'verify' ? 'Verificando' : phase === 'failed' ? 'Falhou' : 'Plano do agente')}</div>${lines.join('')}`;
    progress.classList.remove('hidden');
  }

  sendButton.addEventListener('click', send);
  cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  document.getElementById('reindex').addEventListener('click', () => vscode.postMessage({ type: 'reindex' }));
  document.getElementById('rollback').addEventListener('click', () => vscode.postMessage({ type: 'rollback' }));
  document.getElementById('provider').addEventListener('click', () => vscode.postMessage({ type: 'manageProvider' }));
  activeFileToggle.addEventListener('change', saveState);
  historyToggle.addEventListener('change', saveState);
  mode.addEventListener('change', updateModeUi);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
  });
  messages.addEventListener('click', event => {
    const link = event.target.closest('a[data-external]');
    if (!link) return;
    event.preventDefault();
    vscode.postMessage({ type: 'openLink', url: link.getAttribute('data-external') || '' });
  });

  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'hydrate' && !hydrated) {
      hydrated = true;
      messages.textContent = '';
      for (const entry of msg.transcript || []) {
        if (entry.role === 'user') add('user', entry.text || '', false, entry.meta || entry.mode || '');
        else add('assistant', entry.text || '', true);
      }
    } else if (msg.type === 'user') {
      add('user', msg.text || '', false, `${String(msg.mode || '').toUpperCase()}${msg.activeFilename && msg.includeActiveFile ? ` · ${msg.activeFilename}` : ''}`);
      if (msg.mode === 'agent' || msg.mode === 'research') { progress.classList.remove('hidden'); progress.textContent = 'Preparando plano…'; }
    } else if (msg.type === 'assistantStart') addAssistant(msg.id);
    else if (msg.type === 'assistantDelta') {
      const entry = assistantNodes.get(msg.id);
      if (entry) { entry.raw += msg.text || ''; entry.node.innerHTML = renderMarkdown(entry.raw); scrollBottom(); }
    } else if (msg.type === 'assistantDone') assistantNodes.delete(msg.id);
    else if (msg.type === 'agentProgress') {
      const data = msg.event || {};
      if (data.kind === 'plan') renderPlan(data.plan, data.phase);
      else { status.textContent = data.message || ''; progress.classList.remove('hidden'); }
    } else if (msg.type === 'agentResult') {
      if (msg.plan) renderPlan(msg.plan, 'done');
      const verification = msg.verification || {};
      status.textContent = verification.workspaceChanged ? `Diagnostics: ${verification.diagnostics ? '✓' : '—'} · comando: ${verification.command ? '✓' : '—'}` : 'Concluído';
    } else if (msg.type === 'error') add('error', msg.text || 'Erro');
    else if (msg.type === 'notice') add('notice', msg.text || '');
    else if (msg.type === 'busy') {
      sendButton.disabled = Boolean(msg.value);
      cancelButton.disabled = !msg.value;
      if (!msg.value && !status.textContent) status.textContent = '';
    } else if (msg.type === 'cleared') {
      messages.textContent = '';
      assistantNodes.clear();
      progress.textContent = '';
      progress.classList.add('hidden');
    } else if (msg.type === 'editorState') {
      const hasFile = Boolean(msg.hasFile);
      activeFileName.textContent = hasFile ? msg.filename : 'Nenhum';
      activeFileToggle.disabled = !hasFile;
      activeFileWrap.classList.toggle('disabled', !hasFile);
      if (!initialized) {
        mode.value = savedState.mode || 'ask';
        activeFileToggle.checked = hasFile && (typeof savedState.includeActiveFile === 'boolean' ? savedState.includeActiveFile : Boolean(msg.defaultIncludeActiveFile));
        historyToggle.checked = typeof savedState.includeHistory === 'boolean' ? savedState.includeHistory : Boolean(msg.defaultIncludeHistory);
        initialized = true;
        updateModeUi();
      }
    } else if (msg.type === 'providerState') providerLabel.textContent = msg.label || msg.provider || '';
    else if (msg.type === 'compose') {
      mode.value = msg.mode || 'ask';
      if (typeof msg.includeActiveFile === 'boolean') activeFileToggle.checked = msg.includeActiveFile;
      input.value = msg.text || '';
      updateModeUi();
      input.focus();
    }
  });

  cancelButton.disabled = true;
  vscode.postMessage({ type: 'ready' });
}());
