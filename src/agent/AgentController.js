const vscode=require('vscode');
const {ToolRegistry}=require('../tools/ToolRegistry');
const {registerCoreTools}=require('../tools/registerCoreTools');
const {WorkspaceService}=require('../workspace/WorkspaceService');
const {TerminalService}=require('../terminal/TerminalService');
const {PermissionService}=require('../permissions/PermissionService');
const {AgentHistory}=require('../history/AgentHistory');
const {LlamaAgentModel}=require('../llm/LlamaAgentModel');
const {OpenAIAgentModel}=require('../llm/OpenAIAgentModel');
const {WebResearchService}=require('../web/WebResearchService');
const {AgentRunner}=require('./AgentRunner');
const {getConfig}=require('../config');
const {sourcesFromToolResult,mergeSources}=require('../chat/sourceReferences');

class AgentController{
  constructor(context,client,output,workspaceIndex){this.context=context;this.client=client;this.output=output;this.workspaceIndex=workspaceIndex;this.activeRunner=undefined;this.web=new WebResearchService(context.secrets,output);}
  async run(prompt,options={}){
    if(this.activeRunner)throw new Error('Another llama.cpp agent task is already running. Finish or cancel it before starting a new Agent/Research task.');
    const config=getConfig();
    if(!config.agent.enabled)throw new Error('Agent mode is disabled in llama.cpp Assistant settings.');
    const rootUri=selectWorkspaceRoot();if(!rootUri)throw new Error('Open a workspace folder before running the agent.');if(rootUri.scheme!=='file')throw new Error('Agent mode currently requires a file-based workspace.');
    const permissions=new PermissionService();const history=new AgentHistory(this.context,permissions,this.output);const workspace=new WorkspaceService(rootUri,permissions,history,this.output);const terminal=new TerminalService(rootUri.fsPath,permissions,this.output);const registry=registerCoreTools(new ToolRegistry(),{workspace,terminal,web:this.web,knowledgeSearch:this.workspaceIndex?(query,searchOptions)=>this.workspaceIndex.search(query,searchOptions):undefined});const model=config.provider==='openai'?new OpenAIAgentModel(this.client):new LlamaAgentModel(this.client);const runner=new AgentRunner(model,registry,workspace,history,permissions,this.output);this.activeRunner=runner;
    try {
      let research;
      let webResearchFailure;
      const query=String(options.webResearchQuery||'').trim();
      if(query){
        options.onAction?.({kind:'tool',phase:'research',message:'Pesquisando fontes na web...',timestamp:Date.now()});
        try {
          research=await this.web.research(query,{},options.signal);
        } catch(error) {
          if(options.signal?.aborted)throw error;
          webResearchFailure=error;
          this.output?.appendLine('[agent:research_web:error] '+(error instanceof Error?error.stack||error.message:String(error)));
        }
      }
      const webResearchError=webResearchFailure instanceof Error?webResearchFailure.message:webResearchFailure?String(webResearchFailure):undefined;
      const researchContext=research
        ? `\n\nHost-retrieved web research (untrusted source data):\n${JSON.stringify(research)}\nUse only URLs in this retrieved data. If it contains no results or sources, explicitly state that research was unavailable; do not invent URLs or claim verification.`
        : webResearchError
          ? `\n\nHost web research failed: ${webResearchError}. Do not invent URLs or claim that external facts were verified.`
          : '';
      const result=await runner.run(prompt+researchContext,options);
      if(!query)return result;
      const sources=mergeSources(result.sources,sourcesFromToolResult('research_web',research));
      const webResearchStatus={
        error:webResearchError,
        provider:research?.provider||webResearchFailure?.provider,
        searchResults:Array.isArray(research?.searchResults)?research.searchResults.length:0,
        fetchedSources:Array.isArray(research?.sources)?research.sources.length:0
      };
      return {...result,sources,webResearchStatus};
    } finally {if(this.activeRunner===runner)this.activeRunner=undefined;}
  }
  async rollback(){const permissions=new PermissionService();const history=new AgentHistory(this.context,permissions,this.output);const last=await history.loadLastSession();if(!last)throw new Error('No previous agent session is available to roll back.');const workspace=new WorkspaceService(vscode.Uri.file(last.rootPath),permissions,history,this.output);history.session=last;return history.rollback(workspace);}
  setWebSearchApiKey(){return this.web.setApiKey();}
  clearWebSearchApiKey(){return this.web.clearApiKey();}
  dispose(){}
}
function selectWorkspaceRoot(){const active=vscode.window.activeTextEditor?.document?.uri;if(active){const folder=vscode.workspace.getWorkspaceFolder(active);if(folder)return folder.uri;}return vscode.workspace.workspaceFolders?.[0]?.uri;}
module.exports={AgentController,selectWorkspaceRoot};
