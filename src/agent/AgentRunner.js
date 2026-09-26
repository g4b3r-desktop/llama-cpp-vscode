const os = require('os');
const { getConfig } = require('../config');

class AgentRunner {
  constructor(model, registry, workspace, history, permissions, output) {
    this.model=model;this.registry=registry;this.workspace=workspace;this.history=history;this.permissions=permissions;this.output=output;this.running=false;
  }
  async run(userRequest,options={}) {
    if(this.running)throw new Error('Another llama.cpp agent task is already running in this extension host.');
    const prompt=String(userRequest||'').trim();if(!prompt)throw new Error('Agent task is empty.');
    this.running=true;this.permissions.resetSession();this.workspace.resetSession();const controller=new AbortController();const externalSignal=options.signal;const abort=()=>controller.abort();externalSignal?.addEventListener?.('abort',abort,{once:true});
    try{
      await this.history.beginSession(this.workspace.rootPath,prompt);const summary=await this.workspace.workspaceSummary();const config=getConfig();const maxSteps=Math.max(1,Math.min(100,Number(config.agent.maxSteps||30)));
      const messages=[{role:'system',content:buildSystemPrompt(summary,maxSteps)},{role:'user',content:prompt}];const tools=this.registry.asOpenAITools();this.emit(options,'Analisando a tarefa...');
      for(let step=1;step<=maxSteps;step+=1){if(controller.signal.aborted)throw new Error('Agent task cancelled.');const turn=await this.model.next({messages,tools,signal:controller.signal,model:options.model});messages.push(turn.assistantMessage);
        if(!turn.toolCalls.length){const answer=String(turn.content||'').trim();await this.history.complete(true);this.emit(options,'Tarefa concluída.');return{answer:answer||'Tarefa concluída.',steps:step,sessionId:this.history.session?.id};}
        for(const call of turn.toolCalls){if(controller.signal.aborted)throw new Error('Agent task cancelled.');const tool=this.registry.get(call.name);this.emit(options,tool?tool.actionLabel(call.arguments||{}):`Tentando ferramenta ${call.name}...`);const result=await this.registry.execute(call.name,call.arguments||{},{signal:controller.signal,step});const serialized=truncateToolResult(result,config.agent.maxToolResultCharacters||16000);this.output?.appendLine(`[agent:${step}:${call.name}] ${serialized}`);messages.push({role:'tool',tool_call_id:call.id,name:call.name,content:serialized});}
      }
      await this.history.complete(false);this.emit(options,'Limite de passos atingido.');return{answer:`O agente atingiu o limite de ${maxSteps} passos antes de concluir. Revise as alterações e continue em uma nova solicitação.`,steps:maxSteps,sessionId:this.history.session?.id};
    }catch(error){await this.history.complete(false).catch(()=>{});this.output?.appendLine(`[agent:error] ${error instanceof Error?error.stack||error.message:String(error)}`);throw error;}finally{externalSignal?.removeEventListener?.('abort',abort);this.running=false;}
  }
  emit(options,message){this.output?.appendLine(`[agent] ${message}`);options.onAction?.({message,timestamp:Date.now()});}
}
function buildSystemPrompt(summary,maxSteps){return['You are a local coding agent running inside Visual Studio Code.','You do not have direct filesystem or terminal access. You MUST use the provided tools for all reads, searches, writes, moves, deletes, diagnostics, and commands.','Discover only the files needed for the task. Do not request or reconstruct the entire repository.','Before modifying, moving, or deleting an existing file, read it first. The application enforces this to detect external modifications.','After code changes, inspect diagnostics and run the most relevant tests/build/lint command when practical. If a command or test fails, analyze its output and iterate.','Prefer replace_in_file for small focused edits and edit_file for complete rewrites.','Never attempt path traversal or access outside the workspace. Never attempt to bypass tool permissions.','When complete, return a concise final answer summarizing changes and verification. Do not reveal private chain-of-thought or internal reasoning.',`Maximum agent steps: ${maxSteps}.`,`Environment: ${process.platform} ${process.arch}; Node ${process.version}; ${os.type()} ${os.release()}.`,`Workspace root: ${summary.root}`,'Initial workspace entries (summary only):',...summary.entries.slice(0,80).map(entry=>`- ${entry}`),'','If native function calling is unavailable, request exactly one tool by returning only JSON like {"tool":"read_file","arguments":{"path":"..."}}.'].join('\n');}
function truncateToolResult(result,maxCharacters){const text=JSON.stringify(result);const max=Math.max(1000,Number(maxCharacters||16000));if(text.length<=max)return text;return JSON.stringify({ok:result?.ok!==false,truncated:true,prefix:text.slice(0,max)});}
module.exports={AgentRunner,buildSystemPrompt,truncateToolResult};
