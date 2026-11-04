const vscode = require('vscode');
const path = require('path');

const VIEW_ID = 'llamaCpp.knowledgeSourcesView';

class KnowledgeSourcesViewProvider {
  constructor(manager, extensionUri, output) {
    this.manager = manager;
    this.extensionUri = extensionUri;
    this.output = output;
    this.view = undefined;
    this.ready = false;
    this.changeSubscription = manager.onDidChange(() => { void this.postState(); });
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => this.onMessage(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  post(message) {
    if (this.view && this.ready) void this.view.webview.postMessage(message);
  }

  async postState() {
    if (!this.view || !this.ready) return;
    try {
      const sources = await this.manager.listSources();
      this.post({ type: 'sources', sources });
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async onMessage(message) {
    try {
      if (message?.type === 'ready') {
        this.ready = true;
        await this.postState();
      } else if (message?.type === 'add') {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Adicionar documentação'
        });
        if (!selected?.[0]) { this.post({ type: 'notice', text: 'Adição cancelada.' }); return; }
        const suggested = path.basename(selected[0].fsPath);
        const name = await vscode.window.showInputBox({
          title: 'Nome da Knowledge Source',
          prompt: 'Informe um nome para esta documentação.',
          value: suggested,
          ignoreFocusOut: true,
          validateInput: value => String(value || '').trim() ? undefined : 'Informe um nome para a fonte.'
        });
        if (name === undefined) { this.post({ type: 'notice', text: 'Adição cancelada.' }); return; }
        const source = await this.manager.addSource(selected[0], name);
        this.post({ type: 'notice', text: 'Fonte adicionada. Iniciando indexação incremental…' });
        await this.manager.reindexSource(source.id, true);
        await this.postState();
      } else if (message?.type === 'toggle' && typeof message.id === 'string') {
        await this.manager.setEnabled(message.id, Boolean(message.enabled));
        await this.postState();
      } else if (message?.type === 'remove' && typeof message.id === 'string') {
        const source = (await this.manager.listSources()).find(item => item.id === message.id);
        if (!source) return;
        const choice = await vscode.window.showWarningMessage(
          'Remover a fonte "' + source.name + '" e seu índice local? A pasta original não será apagada.',
          { modal: true },
          'Remover fonte'
        );
        if (choice !== 'Remover fonte') return;
        await this.manager.removeSource(message.id);
        this.post({ type: 'notice', text: 'Fonte removida. A pasta original foi preservada.' });
        await this.postState();
      } else if (message?.type === 'filters' && typeof message.id === 'string') {
        const source = (await this.manager.listSources()).find(item => item.id === message.id);
        if (!source) return;
        const directories = await vscode.window.showInputBox({
          title: 'Diretórios da Knowledge Source',
          prompt: 'Informe caminhos relativos separados por vírgula. Vazio = toda a pasta. Ex.: docs, manual',
          value: (source.includeDirectories || []).join(', '),
          ignoreFocusOut: true
        });
        if (directories === undefined) return;
        const extensions = await vscode.window.showInputBox({
          title: 'Extensões da Knowledge Source',
          prompt: 'Informe extensões separadas por vírgula, com ou sem ponto. Vazio = todas. Ex.: html, md, js, ts',
          value: (source.extensions || []).join(', '),
          ignoreFocusOut: true
        });
        if (extensions === undefined) return;
        await this.manager.configureFilters(message.id, {
          includeDirectories: directories.split(',').map(value => value.trim()).filter(Boolean),
          extensions: extensions.split(',').map(value => value.trim()).filter(Boolean)
        });
        this.post({ type: 'notice', text: 'Filtros salvos. Reindexando somente os arquivos incluídos…' });
        await this.manager.reindexSource(message.id, true);
        await this.postState();
      } else if (message?.type === 'files' && typeof message.id === 'string') {
        const source = (await this.manager.listSources()).find(item => item.id === message.id);
        if (!source) return;
        const available = await this.manager.listAvailableFiles(message.id);
        const selected = source.selectedFiles === null ? null : new Set(source.selectedFiles || []);
        const items = available.files.map(filename => ({
          label: filename,
          description: selected === null || selected.has(filename) ? 'Incluído no RAG' : 'Excluído do RAG',
          picked: selected === null || selected.has(filename)
        }));
        const choice = await vscode.window.showQuickPick(items, {
          title: 'Arquivos usados pelo RAG · ' + source.name,
          placeHolder: 'Selecione os arquivos que a IA poderá consultar',
          canPickMany: true,
          ignoreFocusOut: true
        });
        if (!choice) return;
        const selectedFiles = choice.map(item => item.label);
        await this.manager.configureSelectedFiles(message.id, selectedFiles);
        this.post({ type: 'notice', text: selectedFiles.length + ' arquivo(s) selecionado(s). Reindexando a fonte…' });
        await this.manager.reindexSource(message.id, true);
        await this.postState();
      } else if (message?.type === 'reindex' && typeof message.id === 'string') {
        await this.manager.reindexSource(message.id, true);
        await this.postState();
      } else if (message?.type === 'reindexAll') {
        await this.manager.reindexAll(true);
        await this.postState();
      } else if (message?.type === 'open' && typeof message.id === 'string' && typeof message.filename === 'string') {
        await this.manager.openDocument(message.id, message.filename);
      }
    } catch (error) {
      this.output?.appendLine('[knowledge-sources:view] ' + (error instanceof Error ? error.stack || error.message : String(error)));
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      await this.postState();
    }
  }

  html(webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'knowledgeSources.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'knowledgeSources.js'));
    const csp = "default-src 'none'; style-src " + webview.cspSource + '; script-src ' + webview.cspSource;
    return '<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="' + csp + '"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><link rel="stylesheet" href="' + styleUri + '"/><title>Knowledge Sources</title></head><body><main id="app"><header><div><h1>Knowledge Sources</h1><p>Documentações locais consultadas pelo RAG.</p></div></header><section class="toolbar"><button id="add" class="primary">+ Adicionar fonte</button><button id="reindex-all" class="secondary">Reindexar todas</button></section><section id="summary" aria-live="polite"></section><section id="sources" aria-live="polite"><p class="empty">Carregando fontes…</p></section><p class="footnote">Os arquivos originais nunca são modificados. Desativar uma fonte a remove da busca, mas mantém seu índice.</p><div id="toast" role="status" class="toast hidden"></div></main><script src="' + scriptUri + '"></script></body></html>';
  }

  dispose() {
    this.changeSubscription?.dispose();
    this.view = undefined;
  }
}

module.exports = { KnowledgeSourcesViewProvider, VIEW_ID };
