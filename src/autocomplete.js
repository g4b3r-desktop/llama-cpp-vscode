const vscode = require('vscode');
const { getConfig } = require('./config');

class LlamaInlineCompletionProvider {
  constructor(client, workspaceIndex, inlineSuggestionsController) {
    this.client = client;
    this.workspaceIndex = workspaceIndex;
    this.inlineSuggestionsController = inlineSuggestionsController;
    this.activeController = undefined;
    this.requestSerial = 0;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const config = getConfig();
    const enabled = this.inlineSuggestionsController
      ? this.inlineSuggestionsController.isEnabledForDocument(document)
      : config.autocomplete.enabled;
    if (!enabled || document.uri.scheme !== 'file') return [];

    this.activeController?.abort();
    const serial = ++this.requestSerial;

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && config.autocomplete.debounceMs > 0) {
      await cancellableDelay(config.autocomplete.debounceMs, token);
      if (token.isCancellationRequested || serial !== this.requestSerial) return [];
    }

    const tuning = effectiveProfile(config.autocomplete);
    const startLine = Math.max(0, position.line - tuning.contextLinesBefore);
    const endLine = Math.min(document.lineCount - 1, position.line + tuning.contextLinesAfter);
    let prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    let suffix = document.getText(new vscode.Range(position, document.lineAt(endLine).range.end));
    prefix = prefix.slice(-tuning.maxPrefixCharacters);
    suffix = suffix.slice(0, tuning.maxSuffixCharacters);
    if (!prefix.trim() && !suffix.trim()) return [];

    const controller = new AbortController();
    this.activeController = controller;
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      let extraFiles = [];
      if (tuning.relatedFilesEnabled && config.rag.enabled && !token.isCancellationRequested) {
        const retrievalQuery = `${prefix.slice(-3500)}\n${suffix.slice(0, 1000)}`;
        let results = [];
        if (tuning.retrievalStrategy === 'bm25') {
          if (this.workspaceIndex.indexed && this.workspaceIndex.chunks?.length) {
            results = this.workspaceIndex.rankBm25(
              retrievalQuery,
              Math.max(tuning.relatedFilesTopK * 4, tuning.relatedFilesTopK),
              document.uri.toString()
            ).slice(0, tuning.relatedFilesTopK);
          }
        } else {
          results = await this.workspaceIndex.search(retrievalQuery, {
            topK: tuning.relatedFilesTopK,
            excludeUri: document.uri,
            signal: controller.signal
          });
        }
        extraFiles = this.workspaceIndex.toExtraFiles(results, tuning.relatedFilesMaxCharacters);
      }

      if (token.isCancellationRequested || controller.signal.aborted || serial !== this.requestSerial) return [];
      const completion = await this.client.complete(prefix, suffix, document.languageId, controller.signal, extraFiles, {
        maxTokens: tuning.maxTokens,
        maxPredictMs: tuning.maxPredictMs
      });
      if (!completion || token.isCancellationRequested || controller.signal.aborted || serial !== this.requestSerial) return [];
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (error) {
      if (!token.isCancellationRequested && !controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.client.logError('autocomplete', error);
      }
      return [];
    } finally {
      cancellation.dispose();
      if (this.activeController === controller) this.activeController = undefined;
    }
  }
}

function effectiveProfile(a) {
  const profile = String(a.profile || 'fast').toLowerCase();
  const base = {
    contextLinesBefore: Math.max(1, a.contextLinesBefore),
    contextLinesAfter: Math.max(0, a.contextLinesAfter),
    maxPrefixCharacters: Math.max(500, a.maxPrefixCharacters),
    maxSuffixCharacters: Math.max(0, a.maxSuffixCharacters),
    maxTokens: Math.max(1, a.maxTokens),
    maxPredictMs: Math.max(0, a.maxPredictMs),
    relatedFilesEnabled: Boolean(a.relatedFilesEnabled),
    relatedFilesTopK: Math.max(1, a.relatedFilesTopK),
    relatedFilesMaxCharacters: Math.max(0, a.relatedFilesMaxCharacters),
    retrievalStrategy: undefined,
    rerank: true
  };

  if (profile === 'quality') return base;
  if (profile === 'balanced') {
    return {
      ...base,
      maxTokens: Math.min(base.maxTokens, 80),
      maxPrefixCharacters: Math.min(base.maxPrefixCharacters, 9000),
      maxSuffixCharacters: Math.min(base.maxSuffixCharacters, 2500),
      relatedFilesTopK: Math.min(base.relatedFilesTopK, 2),
      relatedFilesMaxCharacters: Math.min(base.relatedFilesMaxCharacters, 6000),
      retrievalStrategy: 'bm25',
      rerank: false,
      maxPredictMs: base.maxPredictMs > 0 ? Math.max(base.maxPredictMs, 1800) : 0
    };
  }

  return {
    ...base,
    contextLinesBefore: Math.min(base.contextLinesBefore, 40),
    contextLinesAfter: Math.min(base.contextLinesAfter, 10),
    maxTokens: Math.min(base.maxTokens, 48),
    maxPrefixCharacters: Math.min(base.maxPrefixCharacters, 6000),
    maxSuffixCharacters: Math.min(base.maxSuffixCharacters, 1800),
    relatedFilesTopK: Math.min(base.relatedFilesTopK, 1),
    relatedFilesMaxCharacters: Math.min(base.relatedFilesMaxCharacters, 3000),
    retrievalStrategy: 'bm25',
    rerank: false,
    maxPredictMs: base.maxPredictMs > 0 ? Math.min(base.maxPredictMs, 1200) : 0
  };
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

module.exports = { LlamaInlineCompletionProvider, effectiveProfile };
