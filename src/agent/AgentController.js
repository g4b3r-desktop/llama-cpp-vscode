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

class AgentController{
  constructor(context,client,output){this.context=context;this.client=client;this.output=output;this.activeRunner=undefined;this.web=new WebResearchService(context.secrets,output);}
  async run(prompt,options={}){
    const config=getConfig();
    if(!config.agent.enabled)throw new Error('Agent mode is disabled in llama.cpp Assistant settings.');
    const rootUri=selectWorkspaceRoot();if(!rootUri)throw new Error('Open a workspace folder before running the agent.');if(rootUri.scheme!=='file')throw new Error('Agent mode currently requires a file-based workspace.');
    const permissions=new PermissionService();const history=new AgentHistory(this.context,permissions,this.output);const workspace=new WorkspaceService(rootUri,permissions,history,this.output);const terminal=new TerminalService(rootUri.fsPath,permissions,this.output);const registry=registerCoreTools(new ToolRegistry(),{workspace,terminal,web:this.web});const model=config.provider==='openai'?new OpenAIAgentModel(this.client):new LlamaAgentModel(this.client);const runner=new AgentRunner(model,registry,workspace,history,permissions,this.output);this.activeRunner=runner;
    try{return await runner.run(prompt,options);}finally{if(this.activeRunner===runner)this.activeRunner=undefined;}
  }
  async rollback(){const permissions=new PermissionService();const history=new AgentHistory(this.context,permissions,this.output);const last=await history.loadLastSession();if(!last)throw new Error('No previous agent session is available to roll back.');const workspace=new WorkspaceService(vscode.Uri.file(last.rootPath),permissions,history,this.output);history.session=last;return history.rollback(workspace);}
  setWebSearchApiKey(){return this.web.setApiKey();}
  clearWebSearchApiKey(){return this.web.clearApiKey();}
  dispose(){}
}
function selectWorkspaceRoot(){const active=vscode.window.activeTextEditor?.document?.uri;if(active){const folder=vscode.workspace.getWorkspaceFolder(active);if(folder)return folder.uri;}return vscode.workspace.workspaceFolders?.[0]?.uri;}
module.exports={AgentController,selectWorkspaceRoot};
