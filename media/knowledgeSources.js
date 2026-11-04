(function () {
  const vscode = acquireVsCodeApi();
  const sourcesRoot = document.getElementById('sources');
  const summary = document.getElementById('summary');
  const toast = document.getElementById('toast');
  const addButton = document.getElementById('add');
  const allButton = document.getElementById('reindex-all');

  function showToast(message, kind) {
    toast.textContent = String(message || '');
    toast.className = 'toast' + (kind === 'error' ? ' error' : '');
    toast.classList.remove('hidden');
  }

  function formatDate(value) {
    if (!value) return 'Ainda não indexada';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function statusLabel(source) {
    if (source.indexing || source.status === 'indexing') return 'Indexando…';
    if (source.status === 'error') return 'Erro';
    if (source.status === 'indexed') return source.error ? 'Indexada com avisos' : 'Indexada';
    if (source.status === 'stale') return 'Verificando atualizações';
    return 'Pendente';
  }

  function makeButton(label, action, id, secondary) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.id = id;
    if (secondary) button.className = 'secondary';
    return button;
  }

  function render(sources) {
    sources = Array.isArray(sources) ? sources : [];
    const enabled = sources.filter(source => source.enabled).length;
    const files = sources.reduce((sum, source) => sum + Number(source.files || 0), 0);
    const chunks = sources.reduce((sum, source) => sum + Number(source.chunks || 0), 0);
    const vectors = sources.reduce((sum, source) => sum + Number(source.vectors || 0), 0);
    summary.textContent = sources.length
      ? sources.length + ' fontes · ' + enabled + ' ativas · ' + files + ' arquivos · ' + chunks + ' chunks · ' + vectors + ' embeddings'
      : 'Nenhuma fonte cadastrada.';
    sourcesRoot.textContent = '';
    if (!sources.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Adicione uma pasta com documentação HTML, Markdown, texto, JSON ou código.';
      sourcesRoot.appendChild(empty);
      return;
    }
    for (const source of sources) {
      const card = document.createElement('article');
      card.className = 'source-card';
      const heading = document.createElement('div');
      heading.className = 'source-heading';
      const name = document.createElement('strong');
      name.textContent = source.name || 'Knowledge Source';
      const status = document.createElement('span');
      status.className = 'status ' + (source.status || 'pending');
      status.textContent = statusLabel(source);
      heading.append(name, status);

      const root = document.createElement('p');
      root.className = 'source-path';
      root.textContent = source.rootPath || source.rootUri || '';
      root.title = root.textContent;

      const stats = document.createElement('p');
      stats.className = 'source-stats';
      stats.textContent = Number(source.files || 0) + ' arquivos · ' + Number(source.chunks || 0) + ' chunks · ' + Number(source.vectors || 0) + ' embeddings';

      const updated = document.createElement('p');
      updated.className = 'source-updated';
      updated.textContent = 'Última indexação: ' + formatDate(source.lastIndexedAt);

      const controls = document.createElement('div');
      controls.className = 'source-controls';
      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'enabled-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(source.enabled);
      checkbox.dataset.action = 'toggle';
      checkbox.dataset.id = source.id;
      const label = document.createElement('span');
      label.textContent = source.enabled ? 'Ativa' : 'Desativada';
      enabledLabel.append(checkbox, label);
      controls.append(enabledLabel);
      const reindex = makeButton(source.indexing ? 'Indexando…' : 'Reindexar', 'reindex', source.id, true);
      reindex.disabled = Boolean(source.indexing || source.status === 'indexing');
      const remove = makeButton('Remover', 'remove', source.id, true);
      controls.append(reindex, remove);

      card.append(heading, root, stats, updated, controls);
      if (Array.isArray(source.documents) && source.documents.length) {
        const details = document.createElement('details');
        details.className = 'source-documents';
        const summary = document.createElement('summary');
        summary.textContent = 'Abrir documentos (' + source.documents.length + (Number(source.files || 0) > source.documents.length ? '+' : '') + ')';
        details.appendChild(summary);
        const documentList = document.createElement('div');
        documentList.className = 'document-list';
        for (const filename of source.documents) {
          const open = makeButton(filename, 'open', source.id, true);
          open.dataset.filename = filename;
          open.title = 'Abrir ' + filename + ' no VS Code';
          documentList.appendChild(open);
        }
        details.appendChild(documentList);
        card.appendChild(details);
      }
      if (source.error) {
        const error = document.createElement('p');
        error.className = 'source-error';
        error.textContent = source.error;
        card.appendChild(error);
      }
      for (const item of (source.errors || []).slice(0, 3)) {
        const detail = document.createElement('p');
        detail.className = 'source-error-detail';
        detail.textContent = item.file + ': ' + item.message;
        card.appendChild(detail);
      }
      sourcesRoot.appendChild(card);
    }
  }

  addButton.addEventListener('click', () => {
    addButton.disabled = true;
    vscode.postMessage({ type: 'add' });
  });
  allButton.addEventListener('click', () => {
    allButton.disabled = true;
    vscode.postMessage({ type: 'reindexAll' });
  });
  sourcesRoot.addEventListener('change', event => {
    const target = event.target;
    if (target?.dataset?.action === 'toggle') {
      vscode.postMessage({ type: 'toggle', id: target.dataset.id, enabled: target.checked });
    }
  });
  sourcesRoot.addEventListener('click', event => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    target.disabled = true;
    vscode.postMessage({ type: target.dataset.action, id: target.dataset.id, filename: target.dataset.filename });
  });

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'sources') {
      render(message.sources);
      addButton.disabled = false;
      allButton.disabled = false;
    } else if (message.type === 'notice') {
      showToast(message.text, 'notice');
      addButton.disabled = false;
      allButton.disabled = false;
    } else if (message.type === 'error') {
      showToast(message.text, 'error');
      addButton.disabled = false;
      allButton.disabled = false;
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
