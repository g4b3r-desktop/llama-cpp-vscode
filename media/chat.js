(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
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
  const connectionDot = document.getElementById('connection-dot');
  const ragStatus = document.getElementById('rag-status');
  const toast = document.getElementById('toast');
  const modeButtons = Array.from(document.querySelectorAll('.mode-button'));
  const assistantNodes = new Map();
  const entryStore = new Map();
  const savedState = vscode.getState() || {};

  let currentMode = ['ask', 'fresh', 'research', 'agent'].includes(savedState.mode) ? savedState.mode : 'ask';
  let initialized = false;
  let hydrated = false;
  let busy = false;
  let entrySerial = 0;
  let toastTimer;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function renderInline(value) {
    let text = escapeHtml(value);
    const code = [];
    text = text.replace(/`([^`]+)`/g, (_, content) => {
      code.push(content);
      return `@@CODE${code.length - 1}@@`;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="#" data-external="$2">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>');
    text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
    text = text.replace(/@@CODE(\d+)@@/g, (_, index) => `<code>${escapeHtml(code[Number(index)] || '')}</code>`);
    return text;
  }

  function parseTableRow(line) {
    return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  }

  function isTableDivider(line) {
    const cells = parseTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
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
        out.push(`<div class="code-block"><div class="code-header"><span>${escapeHtml(lang || 'code')}</span><button class="copy-code" type="button">Copiar</button></div><pre><code data-language="${escapeAttr(lang)}">${escapeHtml(code.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const headers = parseTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(parseTableRow(lines[i++]));
        out.push(`<div class="table-wrap"><table><thead><tr>${headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, index) => `<td>${renderInline(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
        continue;
      }
      const task = line.match(/^\s*[-+*]\s+\[([ xX])\]\s+(.+)$/);
      if (task) {
        const items = [];
        while (i < lines.length) {
          const match = lines[i].match(/^\s*[-+*]\s+\[([ xX])\]\s+(.+)$/);
          if (!match) break;
          items.push({ checked: match[1].toLowerCase() === 'x', text: match[2] });
          i += 1;
        }
        out.push(`<ul class="task-list">${items.map(item => `<li><input type="checkbox" disabled ${item.checked ? 'checked' : ''}/><span>${renderInline(item.text)}</span></li>`).join('')}</ul>`);
        continue;
      }
      const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
      if (list) {
        const ordered = /^\d/.test(list[1]);
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length) {
          const match = lines[i].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
          if (!match || /^\d/.test(match[1]) !== ordered) break;
          items.push(match[2]);
          i += 1;
        }
        out.push(`<${tag}>${items.map(item => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const paragraph = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^```/.test(lines[i].trim()) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*[-+*]\s+\[[ xX]\]\s+/.test(lines[i]) &&
        !/^\s*([-+*]|\d+[.)])\s+/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))
      ) paragraph.push(lines[i++]);
      out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  function formatTime(timestamp) {
    const date = new Date(Number(timestamp || Date.now()));
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function showToast(text) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 1600);
  }

  function scrollBottom() {
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }

  function createActions(entry) {
    const footer = document.createElement('footer');
    footer.className = 'message-actions';
    const actions = entry.role === 'user' ? ['copy', 'edit', 'repeat'] : ['copy', 'regenerate'];
    const labels = { copy: 'Copiar', edit: 'Editar', repeat: 'Repetir', regenerate: 'Regenerar' };
    for (const action of actions) {
      if (action === 'regenerate' && !entry.request) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-action';
      button.dataset.action = action;
      button.textContent = labels[action];
      footer.appendChild(button);
    }
    return footer;
  }

  function createMessage(entry) {
    const id = `entry-${++entrySerial}`;
    const article = document.createElement('article');
    article.className = `message ${entry.role}`;
    article.dataset.entryId = id;
    article.dataset.role = entry.role;

    const header = document.createElement('header');
    header.className = 'message-header';
    const who = document.createElement('span');
    who.className = 'message-author';
    who.textContent = entry.role === 'user' ? 'Você' : 'llama.cpp';
    const meta = document.createElement('span');
    meta.className = 'message-time';
    const mode = String(entry.mode || '').toUpperCase();
    meta.textContent = `${mode ? `${mode} · ` : ''}${formatTime(entry.timestamp)}`;
    header.append(who, meta);

    const body = document.createElement('div');
    body.className = entry.role === 'assistant' ? 'message-body markdown-body' : 'message-body';
    if (entry.role === 'assistant') body.innerHTML = renderMarkdown(entry.text || '');
    else body.textContent = entry.text || '';

    article.append(header, body, createActions(entry));
    entryStore.set(id, entry);
    messages.appendChild(article);
    scrollBottom();
    return article;
  }

  function addAssistantStream(id, request, timestamp) {
    const article = document.createElement('article');
    article.className = 'message assistant streaming';
    article.dataset.role = 'assistant';

    const header = document.createElement('header');
    header.className = 'message-header';
    const who = document.createElement('span');
    who.className = 'message-author';
    who.textContent = 'llama.cpp';
    const meta = document.createElement('span');
    meta.className = 'message-time';
    meta.textContent = `${String(request?.mode || 'ask').toUpperCase()} · ${formatTime(timestamp)}`;
    header.append(who, meta);

    const body = document.createElement('div');
    body.className = 'message-body markdown-body';
    const cursor = document.createElement('span');
    cursor.className = 'typing-cursor';
    body.appendChild(cursor);
    article.append(header, body);
    messages.appendChild(article);
    assistantNodes.set(id, { article, body, raw: '', request, timestamp });
    scrollBottom();
  }

  function finishAssistant(id, timestamp, aborted) {
    const stream = assistantNodes.get(id);
    if (!stream) return;
    assistantNodes.delete(id);
    stream.article.classList.remove('streaming');
    stream.body.innerHTML = renderMarkdown(stream.raw || (aborted ? '_Resposta interrompida._' : ''));
    const entry = { role: 'assistant', text: stream.raw || (aborted ? 'Resposta interrompida.' : ''), mode: stream.request?.mode || 'ask', timestamp: timestamp || Date.now(), request: stream.request };
    const entryId = `entry-${++entrySerial}`;
    stream.article.dataset.entryId = entryId;
    entryStore.set(entryId, entry);
    stream.article.appendChild(createActions(entry));
    scrollBottom();
  }

  function addNotice(kind, text) {
    const div = document.createElement('div');
    div.className = `notice-card ${kind}`;
    div.textContent = text;
    messages.appendChild(div);
    scrollBottom();
  }

  function ensureEmptyState() {
    if (messages.querySelector('.message, .notice-card')) return;
    messages.innerHTML = '<section class="empty-state"><div class="empty-icon">λ</div><h1>Classic Chat, agora mais completo</h1><p>Converse com o projeto, pesquise na web ou execute tarefas com o Agent Mode.</p><div class="suggestions"><button data-suggestion="Explique o arquivo atual e destaque os pontos mais importantes." data-suggestion-mode="ask">Explicar arquivo</button><button data-suggestion="Revise o arquivo atual procurando bugs, riscos e melhorias." data-suggestion-mode="ask">Revisar código</button><button data-suggestion="Pesquise a documentação atual relacionada a este projeto e traga fontes." data-suggestion-mode="research">Pesquisar docs</button><button data-suggestion="Analise o projeto, identifique o próximo problema relevante e proponha um plano seguro para corrigi-lo." data-suggestion-mode="agent">Rodar agente</button></div><div class="empty-hint">Use <code>@arquivo</code> para contexto explícito. O arquivo atual e o RAG podem ser ligados ou desligados abaixo.</div></section>';
  }

  function clearMessages() {
    messages.textContent = '';
    assistantNodes.clear();
    entryStore.clear();
    progress.textContent = '';
    progress.classList.add('hidden');
    ensureEmptyState();
  }

  function removeLastExchange() {
    const list = Array.from(messages.querySelectorAll('.message'));
    const last = list[list.length - 1];
    const previous = list[list.length - 2];
    if (last?.dataset.role === 'assistant') last.remove();
    if (previous?.dataset.role === 'user') previous.remove();
    ensureEmptyState();
  }

  function setMode(mode) {
    currentMode = ['ask', 'fresh', 'research', 'agent'].includes(mode) ? mode : 'ask';
    for (const button of modeButtons) {
      const selected = button.dataset.mode === currentMode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    const historyAllowed = currentMode === 'ask';
    historyToggle.disabled = !historyAllowed;
    historyWrap.classList.toggle('disabled', !historyAllowed);
    if (!historyAllowed) historyToggle.checked = false;
    input.placeholder = {
      ask: 'Pergunte sobre seu código, use @arquivo ou peça uma explicação…',
      fresh: 'Pergunta isolada, sem enviar a conversa anterior…',
      research: 'Pesquise um assunto na web e compare fontes…',
      agent: 'Descreva uma tarefa para o agente planejar, executar e validar…'
    }[currentMode];
    saveState();
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(240, Math.max(54, input.scrollHeight))}px`;
  }

  function saveState() {
    vscode.setState({
      mode: currentMode,
      includeActiveFile: Boolean(activeFileToggle.checked),
      includeHistory: Boolean(historyToggle.checked),
      draft: input.value
    });
  }

  function currentRequest(textOverride) {
    return {
      text: String(textOverride === undefined ? input.value : textOverride).trim(),
      mode: currentMode,
      includeActiveFile: Boolean(activeFileToggle.checked && !activeFileToggle.disabled),
      includeHistory: Boolean(historyToggle.checked && !historyToggle.disabled)
    };
  }

  function sendRequest(override) {
    if (busy) return;
    const request = override || currentRequest();
    if (!request?.text) return;
    vscode.postMessage({ type: 'ask', ...request });
    if (!override) {
      input.value = '';
      autoResize();
      saveState();
    }
  }

  function loadRequest(request) {
    if (!request) return;
    setMode(request.mode || 'ask');
    if (typeof request.includeActiveFile === 'boolean' && !activeFileToggle.disabled) activeFileToggle.checked = request.includeActiveFile;
    if (typeof request.includeHistory === 'boolean' && !historyToggle.disabled) historyToggle.checked = request.includeHistory;
    input.value = request.text || '';
    autoResize();
    saveState();
    input.focus();
  }

  function renderPlan(plan, phase) {
    if (!plan?.steps?.length) return;
    const lines = plan.steps.map(step => {
      const icon = step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : step.status === 'failed' ? '✗' : '○';
      return `<div class="plan-step ${escapeAttr(step.status || 'pending')}"><span class="plan-icon">${icon}</span><span>${escapeHtml(step.title || '')}</span></div>`;
    });
    const title = phase === 'verify' ? 'Verificando' : phase === 'failed' ? 'Falha no agente' : phase === 'done' ? 'Plano concluído' : 'Plano do agente';
    progress.innerHTML = `<div class="progress-title"><span>${escapeHtml(title)}</span><span class="progress-phase">${escapeHtml(phase || '')}</span></div>${lines.join('')}`;
    progress.classList.remove('hidden');
  }

  modeButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode || 'ask')));
  sendButton.addEventListener('click', () => sendRequest());
  cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('new-chat').addEventListener('click', () => vscode.postMessage({ type: 'newConversation' }));
  document.getElementById('rag-chip').addEventListener('click', () => vscode.postMessage({ type: 'reindex' }));
  document.getElementById('rollback').addEventListener('click', () => vscode.postMessage({ type: 'rollback' }));
  document.getElementById('provider-label').addEventListener('click', () => vscode.postMessage({ type: 'manageProvider' }));
  document.getElementById('test-connection').addEventListener('click', () => vscode.postMessage({ type: 'testConnection' }));
  document.getElementById('open-assistant').addEventListener('click', () => vscode.postMessage({ type: 'openAssistant' }));

  activeFileToggle.addEventListener('change', saveState);
  historyToggle.addEventListener('change', saveState);
  input.addEventListener('input', () => { autoResize(); saveState(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendRequest();
    }
  });

  messages.addEventListener('click', event => {
    const suggestion = event.target.closest('[data-suggestion]');
    if (suggestion) {
      setMode(suggestion.getAttribute('data-suggestion-mode') || 'ask');
      input.value = suggestion.getAttribute('data-suggestion') || '';
      if (!activeFileToggle.disabled && currentMode !== 'research') activeFileToggle.checked = true;
      autoResize();
      saveState();
      input.focus();
      return;
    }

    const link = event.target.closest('a[data-external]');
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: 'openLink', url: link.getAttribute('data-external') || '' });
      return;
    }

    const codeButton = event.target.closest('.copy-code');
    if (codeButton) {
      const code = codeButton.closest('.code-block')?.querySelector('code')?.textContent || '';
      vscode.postMessage({ type: 'copy', text: code });
      return;
    }

    const actionButton = event.target.closest('.message-action');
    if (!actionButton) return;
    const article = actionButton.closest('.message');
    const entry = entryStore.get(article?.dataset.entryId || '');
    if (!entry) return;
    const action = actionButton.dataset.action;
    if (action === 'copy') vscode.postMessage({ type: 'copy', text: entry.text || '' });
    else if (action === 'edit') loadRequest({ ...(entry.request || entry), text: entry.text || '' });
    else if (action === 'repeat') sendRequest(entry.request || { text: entry.text || '', mode: entry.mode || 'ask', includeActiveFile: entry.includeActiveFile, includeHistory: entry.includeHistory });
    else if (action === 'regenerate' && entry.request) vscode.postMessage({ type: 'regenerate', ...entry.request });
  });

  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'hydrate' && !hydrated) {
      hydrated = true;
      messages.textContent = '';
      for (const entry of msg.transcript || []) createMessage(entry);
      ensureEmptyState();
    } else if (msg.type === 'user') {
      const empty = messages.querySelector('.empty-state');
      empty?.remove();
      createMessage({ role: 'user', text: msg.text || '', mode: msg.mode || 'ask', timestamp: msg.timestamp, request: msg.request, includeActiveFile: msg.includeActiveFile, includeHistory: msg.includeHistory, activeFilename: msg.activeFilename });
      if (msg.mode === 'agent' || msg.mode === 'research') {
        progress.classList.remove('hidden');
        progress.innerHTML = '<div class="progress-title"><span>Preparando plano…</span></div>';
      }
    } else if (msg.type === 'assistantStart') {
      addAssistantStream(msg.id, msg.request, msg.timestamp);
    } else if (msg.type === 'assistantDelta') {
      const stream = assistantNodes.get(msg.id);
      if (stream) {
        stream.raw += msg.text || '';
        stream.body.innerHTML = renderMarkdown(stream.raw) + '<span class="typing-cursor"></span>';
        scrollBottom();
      }
    } else if (msg.type === 'assistantDone') {
      finishAssistant(msg.id, msg.timestamp, false);
    } else if (msg.type === 'assistantAbort') {
      finishAssistant(msg.id, Date.now(), true);
    } else if (msg.type === 'removeLastExchange') {
      removeLastExchange();
    } else if (msg.type === 'agentProgress') {
      const data = msg.event || {};
      if (data.kind === 'plan') renderPlan(data.plan, data.phase);
      else {
        status.textContent = data.message || 'Executando…';
        progress.classList.remove('hidden');
      }
    } else if (msg.type === 'agentResult') {
      if (msg.plan) renderPlan(msg.plan, 'done');
      const verification = msg.verification || {};
      status.textContent = verification.workspaceChanged
        ? `Diagnostics ${verification.diagnostics ? '✓' : '—'} · testes/comando ${verification.command ? '✓' : '—'}`
        : 'Concluído';
    } else if (msg.type === 'error') {
      addNotice('error', msg.text || 'Erro');
    } else if (msg.type === 'notice') {
      addNotice('notice', msg.text || '');
    } else if (msg.type === 'busy') {
      busy = Boolean(msg.value);
      sendButton.disabled = busy;
      cancelButton.disabled = !busy;
      modeButtons.forEach(button => { button.disabled = busy; });
      status.textContent = busy ? (msg.mode === 'agent' || msg.mode === 'research' ? 'Executando…' : 'Gerando…') : 'Pronto';
    } else if (msg.type === 'cleared') {
      clearMessages();
      input.value = '';
      autoResize();
      saveState();
    } else if (msg.type === 'editorState') {
      const hasFile = Boolean(msg.hasFile);
      activeFileName.textContent = hasFile ? msg.filename : 'Nenhum';
      activeFileName.title = hasFile ? msg.filename : '';
      activeFileToggle.disabled = !hasFile;
      activeFileWrap.classList.toggle('disabled', !hasFile);
      if (!initialized) {
        activeFileToggle.checked = hasFile && (typeof savedState.includeActiveFile === 'boolean' ? savedState.includeActiveFile : Boolean(msg.defaultIncludeActiveFile));
        historyToggle.checked = typeof savedState.includeHistory === 'boolean' ? savedState.includeHistory : Boolean(msg.defaultIncludeHistory);
        initialized = true;
        setMode(currentMode);
      }
    } else if (msg.type === 'providerState') {
      providerLabel.textContent = msg.label || msg.provider || '';
      connectionDot.className = `connection-dot ${msg.connection || 'idle'}`;
      connectionDot.title = msg.connection === 'ok' ? 'Conectado' : msg.connection === 'error' ? 'Falha na conexão' : msg.connection === 'checking' ? 'Testando conexão' : 'Status não testado';
    } else if (msg.type === 'ragState') {
      ragStatus.textContent = msg.enabled ? `${msg.files} arq · ${msg.strategy}${msg.vectorFallback ? ' · fallback' : ''}` : 'desligado';
    } else if (msg.type === 'copied') {
      showToast('Copiado');
    }
  });

  input.value = savedState.draft || '';
  setMode(currentMode);
  autoResize();
  cancelButton.disabled = true;
  ensureEmptyState();
  vscode.postMessage({ type: 'ready' });
}());
