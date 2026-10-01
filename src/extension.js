const vscode = require('vscode');
const { LlamaInlineCompletionProvider } = require('./autocomplete');
const { ChatPanel } = require('./chatPanel');
const { LlamaClient } = require('./llamaClient');
const { LocalServerManager } = require('./localServer');
const { PerformanceIndicator } = require('./performance');
const { WorkspaceIndex } = require('./workspaceIndex');
const { LlamaLanguageModelProvider, VENDOR } = require('./nativeModelProvider');
const { registerNativeChat } = require('./nativeChat');
const { EditorActions } = require('./editorActions');
const { InlineSuggestionsController } = require('./inlineSuggestionsController');
const { AgentController } = require('./agent/AgentController');
const { getConfig } = require('./config');

function activate(context) {
  const output = vscode.window.createOutputChannel('llama.cpp Assistant');
  const localServer = new LocalServerManager(output);
  const client = new LlamaClient(context.secrets, localServer, output);
  const workspaceIndex = new WorkspaceIndex(client, output, context.storageUri || context.globalStorageUri);
  const classicChat = new ChatPanel(client, workspaceIndex, context.extensionUri);
  const performance = new PerformanceIndicator(client);
  const editorActions = new EditorActions(client, classicChat, context);
  const nativeProvider = new LlamaLanguageModelProvider(client);
  const inlineSuggestions = new InlineSuggestionsController(context);
  const agentController = new AgentController(context, client, output);
  context.subscriptions.push(output, localServer, client, workspaceIndex, classicChat, performance, editorActions, nativeProvider, inlineSuggestions, agentController);
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, new LlamaInlineCompletionProvider(client, workspaceIndex, inlineSuggestions)));
  if (vscode.lm?.registerLanguageModelChatProvider) context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, nativeProvider));
  const nativeParticipant = registerNativeChat(context, client, workspaceIndex, agentController);
  if (nativeParticipant) context.subscriptions.push(nativeParticipant);
  context.subscriptions.push(
    vscode.commands.registerCommand('llamaCpp.openChat', () => openNativeChat(classicChat)),
    vscode.commands.registerCommand('llamaCpp.openClassicChat', () => classicChat.open()),
    vscode.commands.registerCommand('llamaCpp.runAgent', () => openAgentChat(classicChat)),
    vscode.commands.registerCommand('llamaCpp.rollbackAgent', async () => { try { const result = await agentController.rollback(); vscode.window.showInformationMessage(`llama.cpp Agent: rollback concluído (${result.changes} alteração(ões)).`); } catch (error) { vscode.window.showErrorMessage(`llama.cpp Agent: ${error instanceof Error ? error.message : String(error)}`); } }),
    vscode.commands.registerCommand('llamaCpp.setWebSearchApiKey', () => agentController.setWebSearchApiKey()),
    vscode.commands.registerCommand('llamaCpp.clearWebSearchApiKey', () => agentController.clearWebSearchApiKey()),
    vscode.commands.registerCommand('llamaCpp.openInlineStatusMenu', () => inlineSuggestions.openMenu()),
    vscode.commands.registerCommand('llamaCpp.askSelection', async () => { const editor = vscode.window.activeTextEditor; const hasSelection = editor && !editor.selection.isEmpty; const prompt = await vscode.window.showInputBox({ title: 'Ask llama.cpp Assistant', prompt: hasSelection ? 'Ask a question about the selected code.' : 'Ask a question about the active file.', ignoreFocusOut: true }); if (prompt) classicChat.open(prompt, { includeActiveFile: true }); }),
    vscode.commands.registerCommand('llamaCpp.inlineEdit', () => editorActions.edit('edit')),
    vscode.commands.registerCommand('llamaCpp.fixSelection', () => editorActions.edit('fix')),
    vscode.commands.registerCommand('llamaCpp.refactorSelection', () => editorActions.edit('refactor')),
    vscode.commands.registerCommand('llamaCpp.reviewSelection', () => editorActions.review()),
    vscode.commands.registerCommand('llamaCpp.generateTests', () => editorActions.tests()),
    vscode.commands.registerCommand('llamaCpp.manageProvider', () => manageProvider(client, nativeProvider)),
    vscode.commands.registerCommand('llamaCpp.setApiKey', async () => { await client.setApiKey(); nativeProvider.refresh(); }),
    vscode.commands.registerCommand('llamaCpp.clearApiKey', async () => { await client.clearApiKey(); nativeProvider.refresh(); }),
    vscode.commands.registerCommand('llamaCpp.setOpenAIApiKey', async () => { await client.setOpenAIApiKey(); nativeProvider.refresh(); }),
    vscode.commands.registerCommand('llamaCpp.clearOpenAIApiKey', async () => { await client.clearOpenAIApiKey(); nativeProvider.refresh(); }),
    vscode.commands.registerCommand('llamaCpp.setRagApiKey', () => client.setRagApiKey()),
    vscode.commands.registerCommand('llamaCpp.clearRagApiKey', () => client.clearRagApiKey()),
    vscode.commands.registerCommand('llamaCpp.showPerformanceMetrics', () => performance.showDetails()),
    vscode.commands.registerCommand('llamaCpp.testConnection', async () => { try { const models = await client.testConnection(); nativeProvider.refresh(); const suffix = models.length ? ` Models: ${models.slice(0, 12).join(', ')}` : ''; vscode.window.showInformationMessage(`llama.cpp Assistant: ${providerLabel()} connection OK.${suffix}`); } catch (error) { client.logError('connection', error); const message = error instanceof Error ? error.message : String(error); const choice = await vscode.window.showErrorMessage(`llama.cpp Assistant: ${message}`, 'Show Output'); if (choice === 'Show Output') output.show(true); } }),
    vscode.commands.registerCommand('llamaCpp.triggerCompletion', () => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')),
    vscode.commands.registerCommand('llamaCpp.reindexWorkspace', async () => { try { const result = await workspaceIndex.reindex(true); vscode.window.showInformationMessage(`llama.cpp RAG: indexed ${result.files} files / ${result.chunks} chunks / ${result.vectors} vectors.`); } catch (error) { vscode.window.showErrorMessage(`llama.cpp RAG: ${error instanceof Error ? error.message : String(error)}`); } }),
    vscode.commands.registerCommand('llamaCpp.showIndexStatus', () => { const status = workspaceIndex.status(); const when = status.indexedAt ? ` Last index: ${status.indexedAt.toLocaleString()}.` : ''; const vectorNote = status.vectorError ? ' Vector fallback active.' : ''; vscode.window.showInformationMessage(`llama.cpp RAG: ${status.enabled ? 'enabled' : 'disabled'} (${status.strategy}), ${status.files} files / ${status.chunks} chunks / ${status.vectors} vectors.${when}${vectorNote}`); })
  );
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('llamaCpp.metrics.showStatusBar')) performance.refreshVisibility();
    if (event.affectsConfiguration('llamaCpp.provider') || event.affectsConfiguration('llamaCpp.openai') || event.affectsConfiguration('llamaCpp.api') || event.affectsConfiguration('llamaCpp.mode') || event.affectsConfiguration('llamaCpp.local')) nativeProvider.refresh();
  }));
}

async function openNativeChat(classicChat) { try { const commands = await vscode.commands.getCommands(true); if (commands.includes('workbench.action.chat.open')) { await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@llama ', isPartialQuery: true }); return; } } catch {} classicChat.open(); }
async function openAgentChat(classicChat) { try { const commands = await vscode.commands.getCommands(true); if (commands.includes('workbench.action.chat.open')) { await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@llama /agent ', isPartialQuery: true }); return; } } catch {} classicChat.open('Use the native Chat command @llama /agent to run autonomous workspace and web research tools.'); }

async function manageProvider(client, nativeProvider) {
  const config = getConfig();
  const current = config.provider === 'openai' ? 'OpenAI' : 'llama.cpp';
  const choice = await vscode.window.showQuickPick([
    { label: `$(server) Use llama.cpp${config.provider === 'llamacpp' ? ' • current' : ''}`, value: 'provider:llamacpp' },
    { label: `$(cloud) Use OpenAI API${config.provider === 'openai' ? ' • current' : ''}`, value: 'provider:openai' },
    { label: '$(key) Set llama.cpp/API-compatible key', value: 'llama-key' },
    { label: '$(key) Set OpenAI API key', value: 'openai-key' },
    { label: '$(plug) Test current provider connection', value: 'test' },
    { label: '$(settings-gear) Open assistant settings', value: 'settings' },
    { label: '$(comment-discussion) Open native Chat', value: 'chat' }
  ], { title: `AI model provider — current: ${current}` });
  if (!choice) return;
  if (choice.value.startsWith('provider:')) {
    const provider = choice.value.split(':')[1];
    await vscode.workspace.getConfiguration('llamaCpp').update('provider', provider, vscode.ConfigurationTarget.Global);
    nativeProvider.refresh();
    vscode.window.showInformationMessage(`llama.cpp Assistant: provider changed to ${provider === 'openai' ? 'OpenAI' : 'llama.cpp'}.`);
  } else if (choice.value === 'llama-key') { await client.setApiKey(); nativeProvider.refresh(); }
  else if (choice.value === 'openai-key') { await client.setOpenAIApiKey(); nativeProvider.refresh(); }
  else if (choice.value === 'test') { await client.testConnection(); nativeProvider.refresh(); vscode.window.showInformationMessage(`${providerLabel()} models refreshed.`); }
  else if (choice.value === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.llama-cpp-assistant');
  else if (choice.value === 'chat') await openNativeChat({ open() {} });
}
function providerLabel(){return getConfig().provider === 'openai' ? 'OpenAI' : 'llama.cpp';}
function deactivate() {}
module.exports = { activate, deactivate };
