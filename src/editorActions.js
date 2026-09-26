const vscode = require('vscode');

class EditorActions {
  constructor(client, chat, context) {
    this.client = client;
    this.chat = chat;
    this.context = context;
    this.previewProvider = new PreviewProvider();
    this.previewRegistration = vscode.workspace.registerTextDocumentContentProvider('llama-proposed', this.previewProvider);
  }

  dispose() { this.previewRegistration.dispose(); }

  async explain() {
    this.chat.open('Explain the selected code. Cover its purpose, control flow, important dependencies, and edge cases.', { includeActiveFile: true });
  }

  async review() {
    this.chat.open('Review the selected code for correctness, security, maintainability, performance, and missing tests. Prioritize concrete findings.', { includeActiveFile: true });
  }

  async tests() {
    this.chat.open('Generate focused unit tests for the selected code or active file. Cover happy paths, edge cases, and failures. Use the project\'s apparent test style when possible.', { includeActiveFile: true });
  }

  async edit(kind = 'edit') {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const range = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
    const source = editor.document.getText(range);
    if (!source.trim()) return;

    const instruction = kind === 'edit'
      ? await vscode.window.showInputBox({ title: 'Llama.cpp: Inline Edit', prompt: 'Describe the change to make', ignoreFocusOut: true })
      : presetInstruction(kind);
    if (!instruction) return;

    const messages = [
      { role: 'system', content: 'You edit source code. Return only the replacement code/text for the selected range. Do not use Markdown fences or explanations.' },
      { role: 'user', content: `File: ${vscode.workspace.asRelativePath(editor.document.uri, true)}\nLanguage: ${editor.document.languageId}\nInstruction: ${instruction}\n\nSelected text:\n${source}` }
    ];

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'llama.cpp: generating edit', cancellable: false }, async () => {
      const raw = await this.client.chat(messages);
      const replacement = cleanCode(raw);
      if (!replacement.trim()) return;
      await this.previewAndApply(editor, range, replacement, instruction);
    });
  }

  async previewAndApply(editor, range, replacement, instruction) {
    const originalText = editor.document.getText();
    const start = editor.document.offsetAt(range.start);
    const end = editor.document.offsetAt(range.end);
    const proposedText = originalText.slice(0, start) + replacement + originalText.slice(end);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const proposedUri = vscode.Uri.parse(`llama-proposed:${encodeURIComponent(editor.document.fileName)}?id=${id}`);
    this.previewProvider.set(proposedUri, proposedText);
    await vscode.commands.executeCommand('vscode.diff', editor.document.uri, proposedUri, `llama.cpp proposal: ${instruction}`);
    const choice = await vscode.window.showInformationMessage('Apply llama.cpp proposed edit?', { modal: false }, 'Apply', 'Keep Preview');
    if (choice === 'Apply') {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(editor.document.uri, range, replacement);
      await vscode.workspace.applyEdit(edit);
      await editor.document.save();
    }
  }
}

class PreviewProvider {
  constructor() { this.contents = new Map(); }
  set(uri, content) { this.contents.set(uri.toString(), content); }
  provideTextDocumentContent(uri) { return this.contents.get(uri.toString()) || ''; }
}

function presetInstruction(kind) {
  if (kind === 'fix') return 'Fix bugs and obvious correctness problems with the smallest safe change.';
  if (kind === 'refactor') return 'Refactor this code for clarity and maintainability without changing behavior.';
  return '';
}

function cleanCode(text) {
  return String(text || '').replace(/^```[\w+.-]*\s*/i, '').replace(/```\s*$/i, '').trimEnd();
}

module.exports = { EditorActions };
