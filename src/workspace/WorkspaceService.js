const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { resolveInsideRoot, isInsideRoot } = require('./pathSafety');
const { unifiedDiff } = require('./diff');

class WorkspaceService {
  constructor(rootUri, permissions, history, output) {
    if (!rootUri || rootUri.scheme !== 'file') throw new Error('Agent requires a local file workspace.');
    this.rootUri = rootUri; this.rootPath = rootUri.fsPath; this.permissions = permissions; this.history = history; this.output = output;
    this.observed = new Map(); this.rootRealPathPromise = fs.realpath(this.rootPath);
  }
  resetSession() { this.observed.clear(); }
  async workspaceSummary() { const items = await this.listDirectory('.',80); return { root: this.rootPath, entries: items.entries.map(entry => `${entry.type}: ${entry.path}`) }; }
  async listDirectory(relativePath='.', maxEntries=200) {
    const safe = await this.resolveExisting(relativePath); const stat = await fs.stat(safe.absolute); if (!stat.isDirectory()) throw new Error(`${safe.relative} is not a directory.`);
    const entries = await fs.readdir(safe.absolute,{withFileTypes:true});
    return { path:safe.relative, entries:entries.slice(0,maxEntries).map(entry=>({name:entry.name,path:normalizeSlash(path.join(safe.relative==='.'?'':safe.relative,entry.name)),type:entry.isDirectory()?'directory':entry.isFile()?'file':entry.isSymbolicLink()?'symlink':'other'})), truncated:entries.length>maxEntries };
  }
  async readFile(relativePath,maxCharacters=30000) {
    const safe=await this.resolveExisting(relativePath); const stat=await fs.stat(safe.absolute); if(!stat.isFile()) throw new Error(`${safe.relative} is not a file.`);
    const bytes=await fs.readFile(safe.absolute); const hash=sha256(bytes); this.observed.set(safe.relative,hash); const text=bytes.toString('utf8');
    return {path:safe.relative,hash,text:text.slice(0,maxCharacters),truncated:text.length>maxCharacters,size:bytes.length};
  }
  async searchFiles(pattern='**/*',maxResults=100) {
    const glob=String(pattern||'**/*'); const results=await vscode.workspace.findFiles(new vscode.RelativePattern(this.rootUri,glob),'**/{.git,node_modules,dist,build,out,target,vendor,.venv,venv}/**',maxResults); const paths=[];
    for(const uri of results){try{await this.assertRealPathInside(uri.fsPath,false);paths.push(normalizeSlash(path.relative(this.rootPath,uri.fsPath)));}catch{}}
    return {pattern:glob,paths,truncated:results.length>=maxResults};
  }
  async searchText(query,options={}) {
    const needle=String(query||''); if(!needle) throw new Error('search_text requires a non-empty query.');
    const maxResults=Math.max(1,Number(options.maxResults||100)); const maxFiles=Math.max(1,Number(options.maxFiles||400)); const caseSensitive=Boolean(options.caseSensitive); const useRegex=Boolean(options.regex); const filePattern=options.filePattern||'**/*';
    let matcher; if(useRegex){try{matcher=new RegExp(needle,caseSensitive?'g':'gi');}catch(error){throw new Error(`Invalid regular expression: ${error.message}`);}}
    const files=await vscode.workspace.findFiles(new vscode.RelativePattern(this.rootUri,filePattern),'**/{.git,node_modules,dist,build,out,target,vendor,.venv,venv}/**',maxFiles); const results=[];
    for(const uri of files){if(results.length>=maxResults)break;let safe;try{safe=await this.resolveExisting(path.relative(this.rootPath,uri.fsPath));}catch{continue;}let text;try{const stat=await fs.stat(safe.absolute);if(!stat.isFile()||stat.size>1024*1024)continue;text=await fs.readFile(safe.absolute,'utf8');}catch{continue;}
      const lines=text.split(/\r?\n/);for(let i=0;i<lines.length&&results.length<maxResults;i+=1){const line=lines[i];let matched=false;if(matcher){matcher.lastIndex=0;matched=matcher.test(line);}else{matched=caseSensitive?line.includes(needle):line.toLowerCase().includes(needle.toLowerCase());}if(matched)results.push({path:safe.relative,line:i+1,text:line.slice(0,500)});}}
    return {query:needle,results,truncated:results.length>=maxResults};
  }
  async createDirectory(relativePath) {
    this.permissions.assertTrusted('create directories'); const safe=await this.resolveForWrite(relativePath); try{await fs.stat(safe.absolute);throw new Error(`${safe.relative} already exists.`);}catch(error){if(error.code!=='ENOENT')throw error;}
    await this.permissions.confirmFileOperation('create_directory',`create directory ${safe.relative}`); await fs.mkdir(safe.absolute,{recursive:true}); await this.history.recordDirectory(safe.relative); return {path:safe.relative};
  }
  async createFile(relativePath,content) {
    this.permissions.assertTrusted('create files'); const safe=await this.resolveForWrite(relativePath); try{await fs.stat(safe.absolute);throw new Error(`${safe.relative} already exists.`);}catch(error){if(error.code!=='ENOENT')throw error;}
    await this.permissions.confirmFileOperation('create_file',`create file ${safe.relative}`); const after=Buffer.from(String(content??''),'utf8'); await fs.mkdir(path.dirname(safe.absolute),{recursive:true}); await fs.writeFile(safe.absolute,after); await this.history.recordChange(safe.relative,null,after,'create'); this.observed.set(safe.relative,sha256(after));
    return {path:safe.relative,diff:unifiedDiff(safe.relative,'',after.toString('utf8'))};
  }
  async editFile(relativePath,content) {
    const safe=await this.resolveExisting(relativePath); await this.assertObservedAndUnchanged(safe); await this.permissions.confirmFileOperation('edit_file',`edit ${safe.relative}`); const before=await fs.readFile(safe.absolute); const after=Buffer.from(String(content??''),'utf8'); await fs.writeFile(safe.absolute,after); await this.history.recordChange(safe.relative,before,after,'edit'); this.observed.set(safe.relative,sha256(after));
    return {path:safe.relative,diff:unifiedDiff(safe.relative,before.toString('utf8'),after.toString('utf8'))};
  }
  async replaceInFile(relativePath,search,replacement,replaceAll=false) {
    const safe=await this.resolveExisting(relativePath); await this.assertObservedAndUnchanged(safe); const before=await fs.readFile(safe.absolute); const beforeText=before.toString('utf8'); const needle=String(search??''); if(!needle)throw new Error('replace_in_file requires a non-empty search string.'); const occurrences=beforeText.split(needle).length-1; if(!occurrences)throw new Error(`Text was not found in ${safe.relative}.`); if(!replaceAll&&occurrences>1)throw new Error(`Search text occurs ${occurrences} times. Use a more specific search or set replace_all=true.`);
    await this.permissions.confirmFileOperation('replace_in_file',`modify ${safe.relative}`); const afterText=replaceAll?beforeText.split(needle).join(String(replacement??'')):beforeText.replace(needle,String(replacement??'')); const after=Buffer.from(afterText,'utf8'); await fs.writeFile(safe.absolute,after); await this.history.recordChange(safe.relative,before,after,'replace'); this.observed.set(safe.relative,sha256(after)); return {path:safe.relative,replacements:replaceAll?occurrences:1,diff:unifiedDiff(safe.relative,beforeText,afterText)};
  }
  async deleteFile(relativePath) {
    const safe=await this.resolveExisting(relativePath); await this.assertObservedAndUnchanged(safe); const stat=await fs.stat(safe.absolute); if(!stat.isFile())throw new Error('delete_file only deletes files, not directories.'); await this.permissions.confirmFileOperation('delete_file',`delete ${safe.relative}`); const before=await fs.readFile(safe.absolute); await fs.unlink(safe.absolute); await this.history.recordChange(safe.relative,before,null,'delete'); this.observed.delete(safe.relative); return {path:safe.relative};
  }
  async moveFile(fromPath,toPath) {
    const source=await this.resolveExisting(fromPath); await this.assertObservedAndUnchanged(source); const stat=await fs.stat(source.absolute); if(!stat.isFile())throw new Error('move_file currently supports files only.'); const destination=await this.resolveForWrite(toPath); try{await fs.stat(destination.absolute);throw new Error(`${destination.relative} already exists.`);}catch(error){if(error.code!=='ENOENT')throw error;}
    await this.permissions.confirmFileOperation('move_file',`move ${source.relative} to ${destination.relative}`); const bytes=await fs.readFile(source.absolute); await fs.mkdir(path.dirname(destination.absolute),{recursive:true}); await fs.rename(source.absolute,destination.absolute); await this.history.recordChange(source.relative,bytes,null,'move-source'); await this.history.recordChange(destination.relative,null,bytes,'move-destination'); this.observed.delete(source.relative); this.observed.set(destination.relative,sha256(bytes)); return {from:source.relative,to:destination.relative};
  }
  async getErrors(maxResults=100) {
    const diagnostics=vscode.languages.getDiagnostics(); const results=[]; for(const [uri,list] of diagnostics){if(uri.scheme!=='file'||!isInsideRoot(this.rootPath,uri.fsPath))continue;for(const item of list){if(item.severity!==vscode.DiagnosticSeverity.Error&&item.severity!==vscode.DiagnosticSeverity.Warning)continue;results.push({path:normalizeSlash(path.relative(this.rootPath,uri.fsPath)),line:item.range.start.line+1,column:item.range.start.character+1,severity:item.severity===vscode.DiagnosticSeverity.Error?'error':'warning',source:item.source||'',message:item.message});if(results.length>=maxResults)return{results,truncated:true};}}
    return {results,truncated:false};
  }
  async rollbackFile(relativePath,beforeBytes,expectedAfterHash,expectedAfterAbsent) {
    const safe=await this.resolveForWrite(relativePath); let current=null; try{current=await fs.readFile(safe.absolute);}catch(error){if(error.code!=='ENOENT')throw error;} const currentMatches=expectedAfterAbsent?current===null:current!==null&&sha256(current)===expectedAfterHash; if(!currentMatches)await this.permissions.confirmRollback(`${safe.relative} changed after the agent edit. Overwrite it during rollback?`);
    if(beforeBytes===null){if(current!==null)await fs.unlink(safe.absolute);this.observed.delete(safe.relative);}else{await fs.mkdir(path.dirname(safe.absolute),{recursive:true});await fs.writeFile(safe.absolute,beforeBytes);this.observed.set(safe.relative,sha256(beforeBytes));}
  }
  async rollbackDirectory(relativePath) { const safe=await this.resolveExisting(relativePath).catch(()=>null); if(!safe)return; try{await fs.rmdir(safe.absolute);}catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')throw error;} }
  async assertObservedAndUnchanged(safe) { const observed=this.observed.get(safe.relative); if(!observed)throw new Error(`${safe.relative} must be read with read_file before it can be modified, moved, or deleted.`); const current=await fs.readFile(safe.absolute); if(sha256(current)!==observed)throw new Error(`${safe.relative} changed externally since the agent last read it. Read the file again before modifying it.`); }
  async resolveExisting(relativePath) { const resolved=resolveInsideRoot(this.rootPath,relativePath); await this.assertRealPathInside(resolved.absolute,false); return {...resolved,relative:normalizeSlash(resolved.relative)}; }
  async resolveForWrite(relativePath) { const resolved=resolveInsideRoot(this.rootPath,relativePath); await this.assertRealPathInside(resolved.absolute,true); return {...resolved,relative:normalizeSlash(resolved.relative)}; }
  async assertRealPathInside(absolutePath,forWrite) {
    const rootReal=await this.rootRealPathPromise; let targetReal; if(!forWrite){targetReal=await fs.realpath(absolutePath);}else{let parent=path.dirname(absolutePath);while(true){try{targetReal=await fs.realpath(parent);break;}catch(error){if(error.code!=='ENOENT')throw error;const next=path.dirname(parent);if(next===parent)throw error;parent=next;}}}
    if(!isInsideRoot(rootReal,targetReal))throw new Error('Symlink or resolved path escapes the workspace root.');
  }
}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function normalizeSlash(value){return String(value).split(path.sep).join('/');}
module.exports={WorkspaceService,sha256};
