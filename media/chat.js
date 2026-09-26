(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const cancelButton = document.getElementById('cancel');
  const status = document.getElementById('status');
  const activeFileToggle = document.getElementById('include-active-file');
  const activeFileName = document.getElementById('active-file-name');
  const activeFileWrap = document.getElementById('active-file-wrap');
  const assistantNodes = new Map();
  const savedState = vscode.getState() || {};
  let hasInitializedToggle = false;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderInline(value) {
    let text = escapeHtml(value);
    const code = [];
    text = text.replace(/`([^`]+)`/g, (_, v) => { code.push(v); return `@@CODE${code.length - 1}@@`; });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="#" data-external="$2">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>');
    text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
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
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
        continue;
      }
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
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }
      if (!line.trim()) { i += 1; continue; }
      const paragraph = [line]; i += 1;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i].trim()) && !/^\s*>/.test(lines[i]) && !/^\s*([-+*]|\d+[.)])\s+/.test(lines[i])) paragraph.push(lines[i++]);
      out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  function scrollToBottom() { messages.scrollTop = messages.scrollHeight; }
  function add(kind, text, markdown, meta) {
    const div = document.createElement('div'); div.className = `msg ${kind}`;
    const body = document.createElement('div'); body.className = markdown ? 'markdown-body' : '';
    if (markdown) body.innerHTML = renderMarkdown(text); else body.textContent = text;
    div.appendChild(body);
    if (meta) { const m = document.createElement('div'); m.className = 'message-meta'; m.textContent = meta; div.appendChild(m); }
    messages.appendChild(div); scrollToBottom(); return div;
  }
  function addAssistant(id) { const div=document.createElement('div'); div.className='msg assistant'; const body=document.createElement('div'); body.className='markdown-body'; div.appendChild(body); messages.appendChild(div); assistantNodes.set(id,{node:body,raw:''}); scrollToBottom(); }
  function updateToggleState(){ activeFileWrap.classList.toggle('disabled',activeFileToggle.disabled); }
  function saveToggleState(){ vscode.setState({includeActiveFile:Boolean(activeFileToggle.checked)}); }
  function send(){ const text=input.value.trim(); if(!text)return; vscode.postMessage({type:'ask',text,includeActiveFile:Boolean(activeFileToggle.checked&&!activeFileToggle.disabled)}); input.value=''; }

  sendButton.addEventListener('click', send);
  cancelButton.addEventListener('click', () => vscode.postMessage({type:'cancel'}));
  document.getElementById('reindex').addEventListener('click', () => vscode.postMessage({type:'reindex'}));
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({type:'clear'}));
  activeFileToggle.addEventListener('change', saveToggleState);
  input.addEventListener('keydown', e => { if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); send(); } });
  messages.addEventListener('click', e => { const a=e.target.closest('a[data-external]'); if(!a)return; e.preventDefault(); vscode.postMessage({type:'openLink',url:a.getAttribute('data-external')||''}); });

  window.addEventListener('message', event => {
    const msg=event.data||{};
    if(msg.type==='user') add('user',msg.text,false,msg.includeActiveFile&&msg.activeFilename?`Context: current file · ${msg.activeFilename}`:'Context: current file not attached');
    if(msg.type==='assistantStart') addAssistant(msg.id);
    if(msg.type==='assistantDelta'){ const entry=assistantNodes.get(msg.id); if(entry){ entry.raw+=msg.text||''; entry.node.innerHTML=renderMarkdown(entry.raw); scrollToBottom(); } }
    if(msg.type==='assistantDone') assistantNodes.delete(msg.id);
    if(msg.type==='error') add('error',msg.text||'',false);
    if(msg.type==='notice') add('notice',msg.text||'',false);
    if(msg.type==='busy'){ status.textContent=msg.value?'Generating…':''; sendButton.disabled=Boolean(msg.value); cancelButton.disabled=!msg.value; }
    if(msg.type==='cleared'){ messages.textContent=''; assistantNodes.clear(); }
    if(msg.type==='editorState'){
      const hasFile=Boolean(msg.hasFile); activeFileName.textContent=hasFile?msg.filename:'No active file'; activeFileName.title=hasFile?msg.filename:''; activeFileToggle.disabled=!hasFile;
      if(!hasInitializedToggle){ activeFileToggle.checked=hasFile&&(typeof savedState.includeActiveFile==='boolean'?savedState.includeActiveFile:Boolean(msg.defaultIncludeActiveFile)); hasInitializedToggle=true; }
      updateToggleState();
    }
  });
  cancelButton.disabled=true;
  vscode.postMessage({type:'ready'});
}());
