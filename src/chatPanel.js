const vscode = require('vscode');
const { getConfig } = require('./config');

class ChatPanel {
  constructor(client, workspaceIndex, extensionUri) {
    this.client = client; this.workspaceIndex = workspaceIndex; this.extensionUri = extensionUri;
    this.panel = undefined; this.history = []; this.activeRequest = undefined; this.requestSerial = 0;
    this.editorListener = undefined; this.lastFileEditor = undefined;
  }
  open(initialPrompt, options = {}) {
    this.rememberActiveFileEditor();
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); this.postEditorState(); if (initialPrompt) void this.handleAsk(initialPrompt, options); return; }
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('llamaCppChat','llama.cpp Chat',vscode.ViewColumn.Beside,{ enableScripts:true, retainContextWhenHidden:true, localResourceRoots:[mediaRoot] });
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ask' && typeof message.text === 'string') await this.handleAsk(message.text,{ includeActiveFile:Boolean(message.includeActiveFile), includeHistory:Boolean(message.includeHistory) });
      else if (message?.type === 'clear') { this.history=[]; this.panel?.webview.postMessage({type:'cleared'}); }
      else if (message?.type === 'cancel') this.activeRequest?.abort();
      else if (message?.type === 'reindex') await this.reindexFromChat();
      else if (message?.type === 'ready') this.postEditorState();
      else if (message?.type === 'openLink' && typeof message.url === 'string') await this.openExternalLink(message.url);
    });
    this.editorListener?.dispose();
    this.editorListener = vscode.window.onDidChangeActiveTextEditor(editor => { if (editor?.document?.uri?.scheme === 'file') this.lastFileEditor=editor; this.postEditorState(); });
    this.panel.onDidDispose(()=>{ this.activeRequest?.abort(); this.editorListener?.dispose(); this.editorListener=undefined; this.panel=undefined; });
    if (initialPrompt) void this.handleAsk(initialPrompt, options);
  }
  dispose(){ this.activeRequest?.abort(); this.editorListener?.dispose(); this.editorListener=undefined; this.panel?.dispose(); }
  rememberActiveFileEditor(){ const editor=vscode.window.activeTextEditor; if(editor?.document?.uri?.scheme==='file') this.lastFileEditor=editor; }
  getContextEditor(){
    const active=vscode.window.activeTextEditor; if(active?.document?.uri?.scheme==='file'){ this.lastFileEditor=active; return active; }
    if(this.lastFileEditor?.document?.uri?.scheme==='file'){ const visible=vscode.window.visibleTextEditors.find(e=>e.document.uri.toString()===this.lastFileEditor.document.uri.toString()); if(visible){ this.lastFileEditor=visible; return visible; } }
    const fallback=vscode.window.visibleTextEditors.find(e=>e.document.uri.scheme==='file'); if(fallback) this.lastFileEditor=fallback; return fallback;
  }
  postEditorState(){ if(!this.panel) return; const editor=this.getContextEditor(); const hasFile=Boolean(editor&&editor.document.uri.scheme==='file'); const filename=hasFile?vscode.workspace.asRelativePath(editor.document.uri,true):''; const config=getConfig(); this.panel.webview.postMessage({type:'editorState',hasFile,filename,defaultIncludeActiveFile:config.chat.includeEditorContext,defaultIncludeHistory:config.chat.includeHistory}); }
  async openExternalLink(rawUrl){ const url=String(rawUrl||'').trim(); if(!/^(https?:\/\/|mailto:)/i.test(url)) return; try{ await vscode.env.openExternal(vscode.Uri.parse(url,true)); }catch(error){ this.client.logError('open link',error); } }
  async reindexFromChat(){ try{ const result=await this.workspaceIndex.reindex(true); this.panel?.webview.postMessage({type:'notice',text:`RAG index: ${result.files} files, ${result.chunks} chunks.`}); }catch(error){ this.panel?.webview.postMessage({type:'error',text:error instanceof Error?error.message:String(error)}); } }
  async handleAsk(rawText,options={}){
    const text=String(rawText).trim(); if(!text||!this.panel) return;
    const config=getConfig(); const includeActiveFile=typeof options.includeActiveFile==='boolean'?options.includeActiveFile:config.chat.includeEditorContext; const includeHistory=typeof options.includeHistory==='boolean'?options.includeHistory:config.chat.includeHistory; const activeEditor=this.getContextEditor();
    const activeFilename=activeEditor?.document?.uri?.scheme==='file'?vscode.workspace.asRelativePath(activeEditor.document.uri,true):'';
    this.activeRequest?.abort(); const controller=new AbortController(); this.activeRequest=controller; const requestId=`r${++this.requestSerial}`;
    this.panel.webview.postMessage({type:'user',text,includeActiveFile:Boolean(includeActiveFile&&activeFilename),includeHistory,activeFilename}); this.panel.webview.postMessage({type:'busy',value:true}); this.panel.webview.postMessage({type:'assistantStart',id:requestId});
    try{
      const context=await buildChatContext(text,this.workspaceIndex,controller.signal,{includeActiveFile,editor:activeEditor});
      if(context.mentionedFiles.length) this.panel?.webview.postMessage({type:'notice',text:`Using @file context: ${context.mentionedFiles.join(', ')}`});
      if(context.unresolvedMentions.length) this.panel?.webview.postMessage({type:'notice',text:`@file not found: ${context.unresolvedMentions.join(', ')}`});
      const userMessage=context.text?`${text}\n\n${context.text}`:text;
      const messages=[{role:'system',content:'You are a coding assistant inside Visual Studio Code. Be precise and practical. Use the supplied editor and workspace context when relevant. Format answers with GitHub-flavored Markdown when useful, especially fenced code blocks, lists and tables. When context includes filenames and line ranges, refer to them when it helps the user navigate the code. Do not claim you read files that are not present in the supplied context.'},...(includeHistory?this.history:[]),{role:'user',content:userMessage}];
      let answer=''; if(config.chat.streaming) answer=await this.client.chatStream(messages,controller.signal,delta=>this.panel?.webview.postMessage({type:'assistantDelta',id:requestId,text:delta})); else { answer=await this.client.chat(messages,controller.signal); if(answer) this.panel?.webview.postMessage({type:'assistantDelta',id:requestId,text:answer}); }
      const finalAnswer=answer||'(empty response)'; this.history.push({role:'user',content:text},{role:'assistant',content:finalAnswer}); this.history=trimHistory(this.history,12); this.panel?.webview.postMessage({type:'assistantDone',id:requestId});
    }catch(error){ if(controller.signal.aborted){ this.panel?.webview.postMessage({type:'assistantDone',id:requestId}); this.panel?.webview.postMessage({type:'notice',text:'Request cancelled.'}); } else { this.client.logError('chat',error); this.panel?.webview.postMessage({type:'assistantDone',id:requestId}); this.panel?.webview.postMessage({type:'error',text:error instanceof Error?error.message:String(error)}); } }
    finally{ if(this.activeRequest===controller) this.activeRequest=undefined; this.panel?.webview.postMessage({type:'busy',value:false}); }
  }
  html(webview){
    const styleUri=webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri,'media','chat.css')); const scriptUri=webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri,'media','chat.js')); const csp=`default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}`;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${csp}"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><link rel="stylesheet" href="${styleUri}"/><title>llama.cpp Chat</title></head><body><div id="app"><div id="messages" aria-live="polite"></div><div id="composer"><textarea id="input" aria-label="Prompt do chat" placeholder="Pergunte sobre seu código. Use @src/file.ts ou @&quot;path with spaces/file.ts&quot;. Ctrl/Cmd+Enter para enviar."></textarea><div class="context-row"><label id="active-file-wrap" class="context-toggle" title="Controla se arquivos do editor do VS Code são enviados automaticamente com este prompt."><input id="include-active-file" type="checkbox"/><span>Arquivo atual:</span><strong id="active-file-name">Carregando…</strong></label><span class="context-hint">Desligado = sem contexto automático de arquivo atual/editores visíveis. @file explícito continua funcionando.</span></div><div class="context-row"><label class="context-toggle" title="Quando desligado, esta inferência não envia mensagens anteriores da conversa ao modelo."><input id="include-history" type="checkbox"/><span>Usar conversa anterior</span></label><span class="context-hint">Desligado = inferência isolada, mantendo apenas o prompt atual e os contextos selecionados.</span></div><div class="actions"><button id="send">Enviar</button><button id="cancel" class="secondary">Cancelar</button><button id="reindex" class="secondary">Reindexar workspace</button><button id="clear" class="secondary">Limpar</button><span id="status"></span></div></div></div><script src="${scriptUri}"></script></body></html>`;
  }
}

async function buildChatContext(question,workspaceIndex,signal,options={}){
  const config=getConfig(); const blocks=[]; const editor=options.editor||vscode.window.activeTextEditor; const activeUri=editor?.document?.uri?.scheme==='file'?editor.document.uri:undefined; const includeActiveFile=typeof options.includeActiveFile==='boolean'?options.includeActiveFile:config.chat.includeEditorContext; let retrievalHint=question;
  const visibleFileUris=vscode.window.visibleTextEditors.filter(e=>e.document.uri.scheme==='file').map(e=>e.document.uri);
  const mentioned=await workspaceIndex.getMentionedFileContext(question,config.chat.mentionedFilesMaxCharacters,config.chat.maxMentionedFiles); if(mentioned.context) blocks.push(mentioned.context);
  if(includeActiveFile&&editor&&editor.document.uri.scheme==='file'){ let text; let label; if(!editor.selection.isEmpty){ text=editor.document.getText(editor.selection); label='Selected code'; retrievalHint+=`\n${text.slice(0,5000)}`; } else { text=editor.document.getText(); label='Active file'; retrievalHint+=`\n${editor.document.lineAt(editor.selection.active.line).text}`; } if(text.length>config.chat.maxContextCharacters) text=text.slice(0,config.chat.maxContextCharacters); blocks.push([`<editor_context file="${escapeAttr(vscode.workspace.asRelativePath(editor.document.uri,true))}" language="${escapeAttr(editor.document.languageId)}">`,`${label}:`,text,'</editor_context>'].join('\n')); }
  if(includeActiveFile&&config.chat.includeVisibleEditors){ let remaining=config.chat.maxVisibleContextCharacters,count=0; for(const visible of vscode.window.visibleTextEditors){ if(count>=config.chat.maxVisibleFiles||remaining<=0) break; if(visible.document.uri.scheme!=='file') continue; if(activeUri&&visible.document.uri.toString()===activeUri.toString()) continue; const text=visible.document.getText().slice(0,remaining); if(!text.trim()) continue; blocks.push([`<visible_editor file="${escapeAttr(vscode.workspace.asRelativePath(visible.document.uri,true))}" language="${escapeAttr(visible.document.languageId)}">`,text,'</visible_editor>'].join('\n')); remaining-=text.length; count++; } }
  if(config.rag.enabled){
    const blocked=new Set();
    if(includeActiveFile){ if(activeUri) blocked.add(activeUri.toString()); }
    else visibleFileUris.forEach(uri=>blocked.add(uri.toString()));
    const extra=Math.min(blocked.size,config.rag.topK);
    let results=await workspaceIndex.search(retrievalHint,{topK:config.rag.topK+extra,signal,excludeUri:includeActiveFile?activeUri:undefined});
    if(blocked.size) results=results.filter(item=>!blocked.has(item.uri?.toString())).slice(0,config.rag.topK);
    const workspaceContext=workspaceIndex.formatForChat(results,config.chat.workspaceContextCharacters); if(workspaceContext) blocks.push(workspaceContext);
  }
  return {text:blocks.join('\n\n'),mentionedFiles:mentioned.files,unresolvedMentions:mentioned.unresolved};
}
function trimHistory(history,maxMessages){ return history.length<=maxMessages?history:history.slice(history.length-maxMessages); }
function escapeAttr(value){ return String(value).replace(/[&"<>]/g,char=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char])); }
module.exports={ChatPanel,buildChatContext};
