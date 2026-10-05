const vscode = require('vscode');
const { buildChatContext } = require('./chatPanel');
const { getConfig } = require('./config');
const { VENDOR } = require('./nativeModelProvider');

const PARTICIPANT_ID = 'llama-cpp-assistant.llama';

function registerNativeChat(context, client, workspaceIndex, agentController) {
  if (!vscode.chat?.createChatParticipant) return undefined;
  const handler = async (request, chatContext, stream, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const command = request.command || '';
      const modelOverride = request.model?.vendor === VENDOR ? request.model.id : undefined;
      if (command === 'agent' || command === 'research') {
        const referenceContext = await resolveReferences(request.references || [], stream);
        const researchInstruction = command === 'research' ? 'Perform detailed web research before answering. Use research_web or web_search + fetch_url, corroborate important claims when practical, and include the source URLs in the final answer.' : '';
        const agentPrompt = [researchInstruction, request.prompt, referenceContext.blocks.length ? `Explicitly attached context:\n${referenceContext.blocks.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
        const result = await agentController.run(agentPrompt, {
          model: modelOverride,
          signal: controller.signal,
          onAction: event => {
            if (typeof stream.progress !== 'function') return;
            stream.progress(event.message);
          }
        });
        stream.markdown(result.answer || 'Tarefa concluída.');
        return { metadata: { command, model: modelOverride || defaultModel(), agentSessionId: result.sessionId, steps: result.steps, plan: result.plan, verification: result.verification } };
      }
      const config = getConfig();
      const commandPrompt = commandInstruction(command);
      const referenceContext = await resolveReferences(request.references || [], stream);
      const includeActiveFile = referenceContext.blocks.length ? false : config.chat.includeEditorContext;
      const includeHistory = command === 'fresh' ? false : config.chat.includeHistory;
      const autoContext = await buildChatContext(request.prompt, workspaceIndex, controller.signal, { includeActiveFile, editor: vscode.window.activeTextEditor, forceCodebase: command === 'codebase' });
      const messages = [
        { role: 'system', content: ['You are llama.cpp Assistant inside Visual Studio Code.','Be precise, practical, and code-aware. Use GitHub-flavored Markdown.','When context contains filenames or line ranges, cite them naturally.','Do not claim to have read files that were not supplied.',commandPrompt].filter(Boolean).join('\n') },
        ...(includeHistory ? historyMessages(chatContext.history || []) : []),
        { role: 'user', content: [request.prompt, referenceContext.blocks.join('\n\n'), autoContext.text].filter(Boolean).join('\n\n') }
      ];
      const answer = await client.chatStream(messages, controller.signal, delta => stream.markdown(delta), { model: modelOverride });
      return { metadata: { command, model: modelOverride || defaultModel(), answerLength: answer.length, references: referenceContext.labels, includeHistory } };
    } catch (error) {
      if (controller.signal.aborted) return;
      client.logError('native chat', error);
      return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
    } finally { cancellation.dispose(); }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('sparkle');
  participant.followupProvider = { provideFollowups() { return [
    { prompt: 'Responda novamente sem usar o histórico anterior da conversa', command: 'fresh' },
    { prompt: 'Pesquise este assunto na web, compare várias fontes e responda com links', command: 'research' },
    { prompt: 'Corrija os testes que estão falhando e valide a solução', command: 'agent' },
    { prompt: 'Explique a parte mais importante deste código', command: 'explain' }
  ]; } };
  return participant;
}

async function resolveReferences(references, stream) {
  const blocks=[];const labels=[];let remaining=40000;
  for(const reference of references){if(remaining<=0)break;const value=reference?.value;let uri;let range;if(value instanceof vscode.Uri)uri=value;else if(value instanceof vscode.Location){uri=value.uri;range=value.range;}if(!uri||uri.scheme!=='file')continue;try{const doc=await vscode.workspace.openTextDocument(uri);let text=range?doc.getText(range):doc.getText();text=text.slice(0,remaining);remaining-=text.length;const label=vscode.workspace.asRelativePath(uri,true);labels.push(label);blocks.push(`<attached_context file="${escapeAttr(label)}" language="${escapeAttr(doc.languageId)}">\n${text}\n</attached_context>`);if(typeof stream.reference==='function')stream.reference(range?new vscode.Location(uri,range):uri);}catch{}}
  return{blocks,labels};
}
function defaultModel(){const config=getConfig();return String(config.provider==='openai'?config.openai.model:config.api.model||'');}
function historyMessages(history){const out=[];for(const turn of history.slice(-10)){if(turn&&typeof turn.prompt==='string'){out.push({role:'user',content:turn.prompt});continue;}if(turn?.response&&Array.isArray(turn.response)){const text=turn.response.map(part=>{const value=part?.value;if(typeof value==='string')return value;if(typeof value?.value==='string')return value.value;return '';}).join('');if(text)out.push({role:'assistant',content:text});}}return out;}
function commandInstruction(command){const commands={fresh:'Treat this as a standalone inference. Do not assume facts from previous conversation turns.',explain:'Explain the relevant code clearly, including data flow and important edge cases.',fix:'Find the bug or defect and propose the smallest safe fix. Show changed code when useful.',review:'Perform a code review focused on correctness, security, maintainability, and performance. Prioritize concrete findings.',tests:'Generate focused tests for the supplied code, covering happy paths, edge cases, and failure cases.',refactor:'Propose a behavior-preserving refactor. Prefer small, reviewable changes and explain tradeoffs.',codebase:'Use workspace context aggressively to answer as a codebase-aware assistant.'};return commands[command]||'';}
function escapeAttr(value){return String(value).replace(/[&"<>]/g,char=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char]));}
module.exports={registerNativeChat,PARTICIPANT_ID};
