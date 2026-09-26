const vscode = require('vscode');
const { getConfig } = require('./config');

class LlamaInlineCompletionProvider {
  constructor(client, workspaceIndex) {
    this.client = client;
    this.workspaceIndex = workspaceIndex;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const config = getConfig();
    if (!config.autocomplete.enabled || document.uri.scheme !== 'file') return [];

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && config.autocomplete.debounceMs > 0) {
      await cancellableDelay(config.autocomplete.debounceMs, token);
      if (token.isCancellationRequested) return [];
    }

    const startLine = Math.max(0, position.line - config.autocomplete.contextLinesBefore);
    const endLine = Math.min(document.lineCount - 1, position.line + config.autocomplete.contextLinesAfter);
    const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    const suffix = document.getText(new vscode.Range(position, document.lineAt(endLine).range.end));
    if (!prefix.trim() && !suffix.trim()) return [];

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      let extraFiles = [];
      if (config.autocomplete.relatedFilesEnabled && config.rag.enabled && !token.isCancellationRequested) {
        const retrievalQuery = `${prefix.slice(-5000)}\n${suffix.slice(0, 1500)}`;
        const results = await this.workspaceIndex.search(retrievalQuery, {
          topK: config.autocomplete.relatedFilesTopK,
          excludeUri: document.uri,
          signal: controller.signal
        });
        extraFiles = this.workspaceIndex.toExtraFiles(results, config.autocomplete.relatedFilesMaxCharacters);
      }

      if (token.isCancellationRequested) return [];
      const completion = await this.client.complete(prefix, suffix, document.languageId, controller.signal, extraFiles);
      if (!completion || token.isCancellationRequested) return [];
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (error) {
      if (!token.isCancellationRequested && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.client.logError('autocomplete', error);
      }
      return [];
    } finally {
      cancellation.dispose();
    }
  }
}

function cancellableDelay(ms, token) {
  return new Promise(resolve => {
    let disposable;
    const timer = setTimeout(() => {
      disposable?.dispose();
      resolve();
    }, ms);
    disposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      disposable.dispose();
      resolve();
    });
  });
}

module.exports = { LlamaInlineCompletionProvider };
