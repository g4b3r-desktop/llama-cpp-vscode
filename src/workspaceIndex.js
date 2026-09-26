const vscode = require('vscode');
const { getConfig } = require('./config');

class WorkspaceIndex {
  constructor(client, output, storageUri) {
    this.client = client; this.output = output; this.storageUri = storageUri;
    this.chunks = []; this.indexed = false; this.indexing = undefined; this.indexedAt = undefined; this.vectorError = undefined; this.watcher = undefined;
    this.setupWatcher();
  }
  setupWatcher() {
    const config = getConfig();
    if (!config.rag.watchWorkspace || !vscode.workspace.workspaceFolders?.length) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(config.rag.includeGlob);
    const refresh = () => { if (this.indexed) void this.reindex(false); };
    this.watcher.onDidCreate(refresh); this.watcher.onDidChange(refresh); this.watcher.onDidDelete(refresh);
  }
  dispose() { this.watcher?.dispose(); }
  status() { const c=getConfig(); return { enabled:c.rag.enabled,strategy:c.rag.strategy,indexed:this.indexed,indexing:Boolean(this.indexing),files:new Set(this.chunks.map(x=>x.filename)).size,chunks:this.chunks.length,vectors:this.chunks.filter(x=>x.vector?.length).length,indexedAt:this.indexedAt,cacheEnabled:c.rag.cache.enabled,vectorError:this.vectorError }; }
  async ensureIndexed() { const c=getConfig(); if (!c.rag.enabled || this.indexed) return; if (c.rag.cache.enabled && await this.loadCache()) return; if (c.rag.autoIndex) await this.reindex(false); }
  async reindex(showProgress=true) {
    const c=getConfig();
    if (!c.rag.enabled || !vscode.workspace.workspaceFolders?.length) { this.chunks=[]; this.indexed=false; return {files:0,chunks:0,vectors:0}; }
    if (!vscode.workspace.isTrusted) throw new Error('Workspace RAG requires a trusted VS Code workspace.');
    if (this.indexing) return this.indexing;
    const run = async progress => {
      const uris = await vscode.workspace.findFiles(c.rag.includeGlob,c.rag.excludeGlob||undefined,c.rag.maxFiles);
      const chunks=[]; let i=0;
      for (const uri of uris) { i++; if(i%25===0) progress?.report({message:`Indexing ${i}/${uris.length} files…`}); chunks.push(...await this.readAndChunk(uri,c)); }
      this.chunks=chunks; this.vectorError=undefined;
      if (c.rag.embedding.enabled && c.rag.strategy!=='bm25' && chunks.length) {
        try { await this.embedChunks(chunks,c,progress); } catch(e) { this.vectorError=e instanceof Error?e.message:String(e); this.output.appendLine(`[rag] embeddings unavailable, BM25 fallback active: ${this.vectorError}`); }
      }
      this.indexed=true; this.indexedAt=new Date(); await this.saveCache();
      const result={files:new Set(chunks.map(x=>x.filename)).size,chunks:chunks.length,vectors:chunks.filter(x=>x.vector?.length).length};
      this.output.appendLine(`[rag] Indexed ${result.files} files / ${result.chunks} chunks / ${result.vectors} vectors.`); return result;
    };
    this.indexing=showProgress?vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'llama.cpp: indexing workspace',cancellable:false},run):run();
    try{return await this.indexing;}finally{this.indexing=undefined;}
  }
  async readAndChunk(uri,c) {
    try {
      const stat=await vscode.workspace.fs.stat(uri); if(stat.type!==vscode.FileType.File||stat.size>c.rag.maxFileBytes) return [];
      const bytes=await vscode.workspace.fs.readFile(uri); if(looksBinary(bytes)) return [];
      const text=new TextDecoder().decode(bytes); if(!text.trim()) return [];
      const lines=text.split(/\r?\n/), size=Math.max(10,c.rag.chunkLines), overlap=Math.min(size-1,Math.max(0,c.rag.chunkOverlapLines)), step=Math.max(1,size-overlap), filename=vscode.workspace.asRelativePath(uri,true), out=[];
      for(let start=0;start<lines.length;start+=step){ const end=Math.min(lines.length,start+size), body=lines.slice(start,end).join('\n').trim(); if(body) out.push({uri,filename,startLine:start+1,endLine:end,text:body,tokens:tokenize(body),pathTokens:new Set(tokenize(filename))}); if(end>=lines.length) break; }
      return out;
    } catch { return []; }
  }
  async embedChunks(chunks,c,progress) {
    const batch=Math.max(1,c.rag.embedding.batchSize);
    for(let i=0;i<chunks.length;i+=batch){ const slice=chunks.slice(i,i+batch), inputs=slice.map(x=>`file: ${x.filename}\nlines: ${x.startLine}-${x.endLine}\n${x.text}`.slice(0,c.rag.embedding.maxCharacters)); const vectors=await this.client.embed(inputs); vectors.forEach((v,j)=>slice[j].vector=v); progress?.report({message:`Embedding ${Math.min(i+slice.length,chunks.length)}/${chunks.length} chunks…`}); }
  }
  async search(query,options={}) {
    const c=getConfig(); if(!c.rag.enabled||!String(query).trim()) return []; await this.ensureIndexed(); if(!this.indexed||!this.chunks.length) return [];
    const exclude=options.excludeUri?.toString()||'', topK=Math.max(1,options.topK||c.rag.topK), candidates=Math.min(this.chunks.length,Math.max(topK*4,c.rag.rerank.candidates||topK));
    const bm25=this.rankBm25(query,candidates,exclude); let vector=[];
    if(c.rag.strategy!=='bm25'&&this.chunks.some(x=>x.vector?.length)) try { const [qv]=await this.client.embed([String(query).slice(-12000)],options.signal); vector=this.rankVector(qv,candidates,exclude); } catch(e){ this.vectorError=e instanceof Error?e.message:String(e); }
    let merged;
    if(c.rag.strategy==='bm25') merged=bm25; else if(c.rag.strategy==='vector'&&vector.length) merged=vector; else if(vector.length&&bm25.length) merged=rrf(bm25,vector,candidates); else merged=vector.length?vector:bm25;
    if(c.rag.rerank.enabled&&merged.length>1) try { const subset=merged.slice(0,Math.min(c.rag.rerank.candidates,merged.length)); const ranks=await this.client.rerank(query,subset.map(x=>x.text),options.signal); if(ranks?.length){ const map=new Map(ranks.map(r=>[r.index,r.score])); subset.forEach((x,i)=>x.rerankScore=map.get(i)??-Infinity); subset.sort((a,b)=>b.rerankScore-a.rerankScore); merged=subset.concat(merged.slice(subset.length)); } } catch(e){ this.output.appendLine(`[rag] rerank fallback: ${e.message||e}`); }
    return merged.slice(0,topK);
  }
  rankBm25(query,limit,exclude) {
    const q=[...new Set(tokenize(query))]; const N=this.chunks.length, df=new Map(); for(const ch of this.chunks){ for(const t of new Set(ch.tokens)) df.set(t,(df.get(t)||0)+1); }
    const avg=this.chunks.reduce((s,x)=>s+x.tokens.length,0)/Math.max(1,N), out=[];
    for(const ch of this.chunks){ if(exclude&&ch.uri.toString()===exclude) continue; const counts=countTokens(ch.tokens); let score=0; for(const t of q){ const tf=counts.get(t)||0;if(!tf)continue; const idf=Math.log(1+(N-(df.get(t)||0)+.5)/((df.get(t)||0)+.5)); const denom=tf+1.2*(.25+.75*(ch.tokens.length/Math.max(1,avg))); score+=idf*((tf*2.2)/denom); if(ch.pathTokens.has(t))score+=idf*1.8; } if(score>0) out.push({...ch,score,retrieval:'bm25'}); }
    return out.sort((a,b)=>b.score-a.score).slice(0,limit);
  }
  rankVector(q,limit,exclude){ return this.chunks.filter(x=>x.vector?.length&&(!exclude||x.uri.toString()!==exclude)&&x.vector.length===q.length).map(x=>({...x,score:dot(q,x.vector),retrieval:'vector'})).sort((a,b)=>b.score-a.score).slice(0,limit); }
  toExtraFiles(results,maxChars=12000){ let left=maxChars; const out=[]; for(const r of results){ if(left<=0)break; const text=r.text.slice(0,left); out.push({filename:r.filename,text}); left-=text.length; } return out; }
  formatForChat(results,maxChars=24000){ let left=maxChars; const blocks=[]; for(const r of results){ if(left<=0)break; const text=r.text.slice(0,left); blocks.push(`<workspace_chunk file="${escapeAttr(r.filename)}" lines="${r.startLine}-${r.endLine}">\n${text}\n</workspace_chunk>`); left-=text.length; } return blocks.join('\n\n'); }
  async getMentionedFileContext(question,maxChars=30000,maxFiles=6){ const mentions=parseFileMentions(question).slice(0,maxFiles), files=[], unresolved=[], blocks=[]; let left=maxChars; for(const m of mentions){ const found=await this.findMention(m); if(!found){unresolved.push(m);continue;} try{ const bytes=await vscode.workspace.fs.readFile(found.uri); const text=new TextDecoder().decode(bytes).slice(0,left); blocks.push(`<mentioned_file file="${escapeAttr(found.filename)}">\n${text}\n</mentioned_file>`); files.push(found.filename); left-=text.length; if(left<=0)break; }catch{unresolved.push(m);} } return {context:blocks.join('\n\n'),files,unresolved}; }
  async findMention(raw){ const target=normalizePath(raw), base=target.split('/').pop(); if(!base)return; const c=getConfig(), uris=await vscode.workspace.findFiles(`**/${base}`,c.rag.excludeGlob||undefined,30); return uris.map(uri=>{const display=vscode.workspace.asRelativePath(uri,true),n=normalizePath(display);return{uri,filename:display,rank:n===target?100:n.endsWith('/'+target)?90:n.split('/').pop()===base?70:0};}).sort((a,b)=>b.rank-a.rank||a.filename.length-b.filename.length)[0]; }
  cacheUri(){ return this.storageUri?vscode.Uri.joinPath(this.storageUri,'rag-index.json'):undefined; }
  async saveCache(){ const c=getConfig(),uri=this.cacheUri(); if(!c.rag.cache.enabled||!uri||!this.indexed)return; const payload={v:1,indexedAt:this.indexedAt?.toISOString(),chunks:this.chunks.map(x=>({uri:x.uri.toString(),filename:x.filename,startLine:x.startLine,endLine:x.endLine,text:x.text,vector:x.vector}))}; const data=JSON.stringify(payload); if(Buffer.byteLength(data)>c.rag.cache.maxMegabytes*1024*1024)return; try{await vscode.workspace.fs.createDirectory(this.storageUri);await vscode.workspace.fs.writeFile(uri,new TextEncoder().encode(data));}catch(e){this.output.appendLine(`[rag] cache write failed: ${e.message||e}`);} }
  async loadCache(){ const uri=this.cacheUri(); if(!uri)return false; try{ const raw=JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))); if(raw?.v!==1||!Array.isArray(raw.chunks)||!raw.chunks.length)return false; this.chunks=raw.chunks.map(x=>({uri:vscode.Uri.parse(x.uri),filename:x.filename,startLine:x.startLine,endLine:x.endLine,text:x.text,tokens:tokenize(x.text),pathTokens:new Set(tokenize(x.filename)),vector:Array.isArray(x.vector)?x.vector:undefined})); this.indexed=true;this.indexedAt=raw.indexedAt?new Date(raw.indexedAt):new Date();return true;}catch{return false;} }
}

function tokenize(v){ return String(v||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().match(/[a-z_][a-z0-9_$.-]{1,63}|\d{2,}/g)||[]; }
function countTokens(tokens){ const m=new Map(); for(const t of tokens)m.set(t,(m.get(t)||0)+1); return m; }
function dot(a,b){ let n=0;for(let i=0;i<a.length;i++)n+=a[i]*b[i];return n; }
function rrf(a,b,limit){ const scores=new Map(),items=new Map(); for(const list of [a,b]) list.forEach((x,i)=>{const k=`${x.uri}#${x.startLine}:${x.endLine}`;items.set(k,x);scores.set(k,(scores.get(k)||0)+1/(61+i));}); return [...items.entries()].map(([k,x])=>({...x,score:scores.get(k),retrieval:'hybrid'})).sort((x,y)=>y.score-x.score).slice(0,limit); }
function parseFileMentions(text){ const out=[],re=/@"([^"]+)"|@([A-Za-z0-9_.\\/-]+\.[A-Za-z0-9_-]+)/g; let m; while((m=re.exec(String(text||'')))){const v=(m[1]||m[2]||'').trim();if(v&&!out.includes(v))out.push(v);}return out; }
function normalizePath(v){ return String(v||'').trim().replace(/^\.\//,'').replace(/\\/g,'/').replace(/^\/+/, '').toLowerCase(); }
function looksBinary(bytes){ const n=Math.min(bytes.length,4096);if(!n)return false;let suspicious=0;for(let i=0;i<n;i++){const b=bytes[i];if(b===0)return true;if(b<7||(b>14&&b<32))suspicious++;}return suspicious/n>.08; }
function escapeAttr(v){ return String(v).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c])); }
module.exports={WorkspaceIndex,tokenize,parseFileMentions};
