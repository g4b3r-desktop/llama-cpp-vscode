const vscode = require('vscode');
const { LlamaInlineCompletionProvider } = require('./autocomplete');
const { ChatPanel } = require('./chatPanel');
const { LlamaClient } = require('./llamaClient');
const { LocalServerManager } = require('./localServer');
const { WorkspaceIndex } = require('./workspaceIndex');

function activate(context) {
  const output = vscode.window.createOutputChannel('llama.cpp Assistant');
  const localServer = new LocalServerManager(output);
  const client = new LlamaClient(context.secrets, localServer, output);
  const workspaceIndex = new WorkspaceIndex(client, output, context.storageUri || context.globalStorageUri);
  const chat = new ChatPanel(client, workspaceIndex, context.extensionUri);

  context.subscriptions.push(output, localServer, workspaceIndex, chat);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file' },
      new LlamaInlineCompletionProvider(client, workspaceIndex)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llamaCpp.openChat', () => chat.open()),
    vscode.commands.registerCommand('llamaCpp.askSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      const hasSelection = editor && !editor.selection.isEmpty;
      const prompt = await vscode.window.showInputBox({
        title: 'Ask llama.cpp',
        prompt: hasSelection ? 'Ask a question about the selected code.' : 'Ask a question about the active file.',
        ignoreFocusOut: true
      });
      if (prompt) chat.open(prompt, { includeActiveFile: true });
    }),
    vscode.commands.registerCommand('llamaCpp.setApiKey', () => client.setApiKey()),
    vscode.commands.registerCommand('llamaCpp.clearApiKey', () => client.clearApiKey()),
    vscode.commands.registerCommand('llamaCpp.setRagApiKey', () => client.setRagApiKey()),
    vscode.commands.registerCommand('llamaCpp.clearRagApiKey', () => client.clearRagApiKey()),
    vscode.commands.registerCommand('llamaCpp.testConnection', async () => {
      try {
        const models = await client.testConnection();
        const suffix = models.length ? ` Models: ${models.join(', ')}` : '';
        vscode.window.showInformationMessage(`llama.cpp Assistant: connection OK.${suffix}`);
      } catch (error) {
        client.logError('connection', error);
        const message = error instanceof Error ? error.message : String(error);
        const choice = await vscode.window.showErrorMessage(`llama.cpp Assistant: ${message}`, 'Show Output');
        if (choice === 'Show Output') output.show(true);
      }
    }),
    vscode.commands.registerCommand('llamaCpp.triggerCompletion', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
    ),
    vscode.commands.registerCommand('llamaCpp.reindexWorkspace', async () => {
      try {
        const result = await workspaceIndex.reindex(true);
        vscode.window.showInformationMessage(`llama.cpp RAG: indexed ${result.files} files / ${result.chunks} chunks / ${result.vectors} vectors.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`llama.cpp RAG: ${message}`);
      }
    }),
    vscode.commands.registerCommand('llamaCpp.showIndexStatus', () => {
      const status = workspaceIndex.status();
      const when = status.indexedAt ? ` Last index: ${status.indexedAt.toLocaleString()}.` : '';
      const vectorNote = status.vectorError ? ' Vector fallback active.' : '';
      vscode.window.showInformationMessage(
        `llama.cpp RAG: ${status.enabled ? 'enabled' : 'disabled'} (${status.strategy}), ${status.files} files / ${status.chunks} chunks / ${status.vectors} vectors.${when}${vectorNote}`
      );
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
