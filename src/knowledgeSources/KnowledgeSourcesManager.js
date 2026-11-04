const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('../config');
const { parseDocument } = require('./KnowledgeDocumentParser');
const { tokenize } = require('../workspaceIndex');
const { isValidSourceId, isBlockedRoot, isSensitiveFilename, isInside, normalizeRelative, isSafeDocumentPath, looksBinary, sha256, DEFAULT_SOURCE_EXTENSIONS, normalizeSourceExtensions, normalizeSourceDirectories, buildSourceIncludeGlob, sourceFiltersFingerprint, matchesSourceFilter, normalizeSelectedFiles, matchesSelectedFile, normalizeSourceTags, matchesRetrievalScope } = require('./sourceUtils');
const { runEmbeddingBatches } = require('./embeddingQueue');

const INDEX_VERSION = 1;
const INCLUDE_GLOB = '**/*.{html,htm,md,mdx,txt,json,jsonc,js,jsx,mjs,cjs,ts,tsx,py,java,c,cc,cpp,h,hpp,cs,go,rs,php,rb,swift,kt,kts,scala,sh,bash,zsh,lua,vue,svelte,css,scss,less,xml,yaml,yml,sql,graphql,gql,proto}';
const EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,out,target,vendor,.venv,venv,.next,.nuxt,coverage,.cache}/**';

class KnowledgeSourcesManager {
  constructor(client, output, storageUri) {
    this.client = client;
    this.output = output;
    this.storageUri = storageUri;
    this.sources = new Map();
    this.indexes = new Map();
    this.documents = new Map();
    this.watchers = new Map();
    this.watchTimers = new Map();
    this.pendingRefresh = new Set();
    this.indexing = new Map();
    this.embeddingRefresh = new Map();
    this.embeddingRefreshControllers = new Map();
    this.checkpointReady = new Set();
    this.controllers = new Map();
    this.catalogWrite = Promise.resolve();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.ready = this.load();
  }

  async load() {
    if (!this.storageUri) return [];
    const root = vscode.Uri.joinPath(this.storageUri, 'knowledge-sources');
    await vscode.workspace.fs.createDirectory(root);
    const catalog = vscode.Uri.joinPath(root, 'sources.json');
    try {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(catalog)));
      if (raw?.version !== INDEX_VERSION || !Array.isArray(raw.sources)) throw new Error('Invalid Knowledge Sources catalog version.');
      for (const item of raw.sources) {
        try {
          if (!isValidSourceId(item?.id) || typeof item.rootUri !== 'string') continue;
          const storedUri = vscode.Uri.parse(item.rootUri);
          if (storedUri.scheme !== 'file') continue;
          let rootPath = storedUri.fsPath;
          let rootError = null;
          try {
            rootPath = await fs.realpath(rootPath);
            const stat = await fs.stat(rootPath);
            if (!stat.isDirectory() || isBlockedRoot(rootPath)) throw new Error('The stored source folder is not an allowed documentation directory.');
          } catch (error) {
            rootError = 'Source folder unavailable or not allowed: ' + (error instanceof Error ? error.message : String(error));
          }
          const source = {
            id: item.id,
            name: String(item.name || 'Knowledge Source').trim().slice(0, 120) || 'Knowledge Source',
            type: 'local-folder',
            rootUri: vscode.Uri.file(rootPath).toString(),
            rootPath,
            enabled: !rootError && item.enabled !== false,
            includeDirectories: normalizeSourceDirectories(item.includeDirectories || []),
            extensions: normalizeSourceExtensions(item.extensions || DEFAULT_SOURCE_EXTENSIONS),
            selectedFiles: normalizeSelectedFiles(item.selectedFiles),
            tags: normalizeSourceTags(item.tags),
            rerankEnabled: item.rerankEnabled !== false,
            progress: null,
            needsFilterRefresh: false,
            createdAt: item.createdAt || new Date().toISOString(),
            updatedAt: item.updatedAt || new Date().toISOString(),
            lastIndexedAt: item.lastIndexedAt || null,
            status: rootError ? 'error' : 'pending',
            files: Number(item.files || 0),
            chunks: Number(item.chunks || 0),
            vectors: Number(item.vectors || 0),
            error: rootError,
            errors: []
          };
          this.sources.set(source.id, source);
          if (!rootError && source.enabled) await this.loadIndex(source);
        } catch (error) {
          this.output?.appendLine('[knowledge-sources] skipped invalid catalog entry: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.output?.appendLine('[knowledge-sources] catalog load failed: ' + error.message);
    }
    for (const source of this.sources.values()) this.setupWatcher(source);
    return this.listSourcesSync();
  }

  async persistCatalog() {
    const write = async () => {
      if (!this.storageUri) return;
      const root = vscode.Uri.joinPath(this.storageUri, 'knowledge-sources');
      await vscode.workspace.fs.createDirectory(root);
      const catalog = {
        version: INDEX_VERSION,
        updatedAt: new Date().toISOString(),
        sources: [...this.sources.values()].map(source => ({
          id: source.id,
          name: source.name,
          type: source.type,
          rootUri: source.rootUri,
          enabled: source.enabled,
          includeDirectories: source.includeDirectories || [],
          extensions: source.extensions || DEFAULT_SOURCE_EXTENSIONS,
          selectedFiles: source.selectedFiles === null ? null : (source.selectedFiles || []),
          tags: normalizeSourceTags(source.tags),
          rerankEnabled: source.rerankEnabled !== false,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          lastIndexedAt: source.lastIndexedAt,
          files: source.files,
          chunks: source.chunks,
          vectors: source.vectors
        }))
      };
      const target = vscode.Uri.joinPath(root, 'sources.json');
      const temporary = vscode.Uri.joinPath(root, 'sources.tmp.json');
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(catalog, null, 2)));
      await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    };
    this.catalogWrite = this.catalogWrite.catch(() => {}).then(write);
    return this.catalogWrite;
  }

  cacheUri(sourceId) {
    if (!this.storageUri) return undefined;
    return vscode.Uri.joinPath(this.storageUri, 'knowledge-sources', sourceId + '.index.json');
  }

  checkpointUri(sourceId) {
    if (!this.storageUri) return undefined;
    return vscode.Uri.joinPath(this.storageUri, 'knowledge-sources', sourceId + '.embeddings.jsonl');
  }

  checkpointHeader(source) {
    return {
      type: 'meta',
      version: 1,
      sourceId: source.id,
      rootUri: source.rootUri,
      embeddingFingerprint: embeddingFingerprint(),
      parserFingerprint: parserFingerprint(),
      filtersFingerprint: sourceFiltersFingerprint(source)
    };
  }

  async ensureEmbeddingCheckpoint(source) {
    if (this.checkpointReady.has(source.id)) return;
    const uri = this.checkpointUri(source.id);
    if (!uri) return;
    const expected = this.checkpointHeader(source);
    let valid = false;
    try {
      const firstLine = (await fs.readFile(uri.fsPath, 'utf8')).split(/\r?\n/, 1)[0];
      const current = JSON.parse(firstLine);
      valid = current?.type === 'meta'
        && current.sourceId === expected.sourceId
        && current.rootUri === expected.rootUri
        && current.embeddingFingerprint === expected.embeddingFingerprint
        && current.parserFingerprint === expected.parserFingerprint
        && current.filtersFingerprint === expected.filtersFingerprint;
    } catch (error) {
      if (error.code !== 'ENOENT') this.output?.appendLine('[knowledge-sources] checkpoint header read failed: ' + error.message);
    }
    if (!valid) {
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, JSON.stringify(expected) + '\n', 'utf8');
    }
    this.checkpointReady.add(source.id);
  }

  async loadEmbeddingCheckpoint(source, documents) {
    const uri = this.checkpointUri(source.id);
    if (!uri) return 0;
    let content;
    try {
      content = await fs.readFile(uri.fsPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.output?.appendLine('[knowledge-sources] checkpoint read failed for ' + source.name + ': ' + error.message);
      return 0;
    }
    // Ignore a trailing partial JSONL record left by a process crash; all earlier newline-terminated records remain reusable.
    const lastNewline = content.lastIndexOf('\n');
    const completeContent = lastNewline >= 0 ? content.slice(0, lastNewline) : '';
    if (lastNewline < 0 || lastNewline < content.length - 1) {
      // Remove a truncated final write so the next append starts on a fresh JSONL line.
      await fs.writeFile(uri.fsPath, lastNewline >= 0 ? content.slice(0, lastNewline + 1) : '', 'utf8');
    }
    const lines = completeContent.split(/\r?\n/);
    let header;
    try { header = JSON.parse(lines.shift() || ''); } catch { header = null; }
    const expected = this.checkpointHeader(source);
    const validHeader = header?.type === 'meta'
      && header.sourceId === expected.sourceId
      && header.rootUri === expected.rootUri
      && header.embeddingFingerprint === expected.embeddingFingerprint
      && header.parserFingerprint === expected.parserFingerprint
      && header.filtersFingerprint === expected.filtersFingerprint;
    if (!validHeader) {
      await this.clearEmbeddingCheckpoint(source.id);
      return 0;
    }

    const chunksById = new Map();
    for (const document of Object.values(documents)) {
      for (const chunk of document.chunks || []) chunksById.set(chunk.id, chunk);
    }
    let applied = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        for (const item of Array.isArray(record?.items) ? record.items : []) {
          const target = chunksById.get(item?.id);
          const vector = item?.vector;
          if (!target || !Array.isArray(vector) || !vector.length || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) continue;
          if (source.embeddingDimension && vector.length !== source.embeddingDimension) continue;
          target.vector = vector;
          if (!source.embeddingDimension) source.embeddingDimension = vector.length;
          applied += 1;
        }
      } catch (error) {
        this.output?.appendLine('[knowledge-sources] ignoring incomplete embedding checkpoint line: ' + error.message);
      }
    }
    this.checkpointReady.add(source.id);
    return applied;
  }

  async appendEmbeddingCheckpoint(source, items) {
    if (!Array.isArray(items) || !items.length) return;
    await this.ensureEmbeddingCheckpoint(source);
    const uri = this.checkpointUri(source.id);
    if (!uri) return;
    await fs.appendFile(uri.fsPath, JSON.stringify({ items }) + '\n', 'utf8');
  }

  async clearEmbeddingCheckpoint(sourceId) {
    const uri = this.checkpointUri(sourceId);
    this.checkpointReady.delete(sourceId);
    if (uri) await fs.unlink(uri.fsPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async loadIndex(source) {
    const uri = this.cacheUri(source.id);
    if (!uri) return false;
    try {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      if (raw?.version !== INDEX_VERSION || raw.sourceId !== source.id || raw.rootUri !== source.rootUri || !raw.documents || typeof raw.documents !== 'object') return false;
      const documents = Object.create(null);
      let chunks = [];
      for (const [filename, document] of Object.entries(raw.documents)) {
        if (!isSafeDocumentPath(filename) || isSensitiveFilename(filename)) continue;
        if (!document || !/^[a-f0-9]{64}$/i.test(document.hash || '') || !Array.isArray(document.chunks)) continue;
        const safeChunks = document.chunks.filter(chunk => chunk && typeof chunk.text === 'string').map(chunk => ({
          ...chunk,
          vector: Array.isArray(chunk.vector) && chunk.vector.length && chunk.vector.every(value => typeof value === 'number' && Number.isFinite(value))
            ? chunk.vector
            : undefined
        }));
        const legacyMtime = typeof document.mtime === 'number' ? document.mtime : Date.parse(String(document.mtime || ''));
        const storedMtimeMs = Number(document.mtimeMs);
        const mtimeMs = Number.isFinite(storedMtimeMs) ? storedMtimeMs : Number.isFinite(legacyMtime) ? legacyMtime : 0;
        const safeDocument = { hash: document.hash, size: Number(document.size || 0), mtimeMs, chunks: safeChunks };
        documents[filename] = safeDocument;
        for (const chunk of safeChunks) chunks.push(this.toSearchChunk(source, filename, chunk, safeDocument.hash, safeDocument.mtimeMs));
      }
      const currentFingerprint = embeddingFingerprint();
      source.needsFilterRefresh = raw.filtersFingerprint !== sourceFiltersFingerprint(source);
      const vectors = chunks.filter(chunk => chunk.vector?.length);
      const dimensions = new Set(vectors.map(chunk => chunk.vector.length));
      const refreshVectors = raw.embeddingFingerprint !== currentFingerprint || dimensions.size > 1;
      source.embeddingDimension = refreshVectors ? undefined : (dimensions.size === 1 ? [...dimensions][0] : Number(raw.embeddingDimension || 0) || undefined);
      source.needsRechunk = raw.parserFingerprint !== parserFingerprint();
      if (refreshVectors) {
        for (const chunk of chunks) delete chunk.vector;
        for (const document of Object.values(documents)) for (const chunk of document.chunks || []) delete chunk.vector;
        await this.clearEmbeddingCheckpoint(source.id);
      } else if (source.needsRechunk || source.needsFilterRefresh) {
        await this.clearEmbeddingCheckpoint(source.id);
      } else {
        await this.loadEmbeddingCheckpoint(source, documents);
        chunks = this.flattenDocuments(source, documents);
      }
      this.documents.set(source.id, documents);
      this.indexes.set(source.id, chunks);
      source.files = Object.keys(documents).length;
      source.chunks = chunks.length;
      source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
      source.lastIndexedAt = raw.indexedAt || source.lastIndexedAt;
      source.status = 'stale';
      source.error = null;
      source.needsEmbedding = chunks.some(chunk => !chunk.vector?.length) && getConfig().rag.embedding.enabled && getConfig().rag.strategy !== 'bm25';
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') this.output?.appendLine('[knowledge-sources] cache load failed for ' + source.name + ': ' + error.message);
      return false;
    }
  }

  async saveIndex(source) {
    const uri = this.cacheUri(source.id);
    if (!uri) return;
    const documents = this.documents.get(source.id) || {};
    const payload = {
      version: INDEX_VERSION,
      sourceId: source.id,
      rootUri: source.rootUri,
      indexedAt: source.lastIndexedAt,
      embeddingFingerprint: embeddingFingerprint(),
      parserFingerprint: parserFingerprint(),
      filtersFingerprint: sourceFiltersFingerprint(source),
      embeddingDimension: source.embeddingDimension || null,
      documents
    };
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const maxBytes = Math.max(16, Number(getConfig().rag.knowledgeSources.maxCacheMegabytes || 1024)) * 1024 * 1024;
    if (data.byteLength > maxBytes) {
      throw new Error('Knowledge Source cache exceeds llamaCpp.rag.knowledgeSources.maxCacheMegabytes. Increase the limit or reduce the source size.');
    }
    const temporary = vscode.Uri.joinPath(this.storageUri, 'knowledge-sources', source.id + '.index.tmp');
    await vscode.workspace.fs.writeFile(temporary, data);
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  }

  async addSource(folderUri, name) {
    await this.ready;
    if (!folderUri || folderUri.scheme !== 'file') throw new Error('Knowledge Sources currently require a local file folder.');
    const rootPath = await fs.realpath(folderUri.fsPath);
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) throw new Error('The selected Knowledge Source is not a directory.');
    if (isBlockedRoot(rootPath)) throw new Error('Select a documentation folder, not a system root directory.');
    for (const item of this.sources.values()) {
      if (path.resolve(item.rootPath) === path.resolve(rootPath)) throw new Error('This folder is already registered as a Knowledge Source.');
    }
    const id = crypto.randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    const source = {
      id,
      name: String(name || '').trim().slice(0, 120) || path.basename(rootPath) || 'Knowledge Source',
      type: 'local-folder',
      rootUri: vscode.Uri.file(rootPath).toString(),
      rootPath,
      enabled: true,
      includeDirectories: [],
      extensions: [...DEFAULT_SOURCE_EXTENSIONS],
      selectedFiles: null,
      tags: [],
      rerankEnabled: true,
      progress: null,
      needsFilterRefresh: false,
      createdAt: now,
      updatedAt: now,
      lastIndexedAt: null,
      status: 'pending',
      files: 0,
      chunks: 0,
      vectors: 0,
      error: null,
      errors: []
    };
    this.sources.set(id, source);
    this.indexes.set(id, []);
    this.documents.set(id, {});
    this.setupWatcher(source);
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  async setEnabled(sourceId, enabled) {
    await this.ready;
    const source = this.requireSource(sourceId);
    const nextEnabled = Boolean(enabled);
    if (nextEnabled) {
      const rootPath = await fs.realpath(source.rootPath);
      const stat = await fs.stat(rootPath);
      if (!stat.isDirectory() || isBlockedRoot(rootPath)) throw new Error('The source folder is not an allowed documentation directory.');
      source.rootPath = rootPath;
      source.rootUri = vscode.Uri.file(rootPath).toString();
      if (!this.indexes.has(source.id)) {
        const loaded = await this.loadIndex(source);
        if (!loaded) source.status = 'pending';
      }
      if (source.status === 'error') source.status = 'stale';
      source.enabled = true;
      this.setupWatcher(source);
    } else {
      source.enabled = false;
      this.disposeWatcher(source.id);
      this.controllers.get(source.id)?.abort();
      this.embeddingRefreshControllers.get(source.id)?.abort();
    }
    source.updatedAt = new Date().toISOString();
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  async configureFilters(sourceId, options = {}) {
    await this.ready;
    const source = this.requireSource(sourceId);
    source.includeDirectories = normalizeSourceDirectories(options.includeDirectories || []);
    source.extensions = normalizeSourceExtensions(options.extensions || []);
    if (Array.isArray(source.selectedFiles)) {
      source.selectedFiles = normalizeSelectedFiles(source.selectedFiles.filter(filename => matchesSourceFilter(filename, source)));
    }
    await this.clearEmbeddingCheckpoint(source.id);
    source.needsFilterRefresh = true;
    source.status = 'stale';
    source.error = null;
    source.updatedAt = new Date().toISOString();
    this.disposeWatcher(source.id);
    this.setupWatcher(source);
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  async listAvailableFiles(sourceId) {
    await this.ready;
    const source = this.requireSource(sourceId);
    const rootUri = vscode.Uri.parse(source.rootUri);
    const include = new vscode.RelativePattern(rootUri, buildSourceIncludeGlob(source));
    const exclude = new vscode.RelativePattern(rootUri, EXCLUDE_GLOB);
    const limit = Math.max(1, Number(getConfig().rag.knowledgeSources.maxFiles || 2000));
    const found = await vscode.workspace.findFiles(include, exclude, limit + 1);
    const rootReal = await fs.realpath(source.rootPath);
    const files = [];
    for (const uri of found.slice(0, limit)) {
      const filename = normalizeRelative(path.relative(source.rootPath, uri.fsPath));
      if (!filename || !isSafeDocumentPath(filename) || isSensitiveFilename(filename)
        || !matchesSourceFilter(filename, source)) continue;
      try {
        const realPath = await fs.realpath(uri.fsPath);
        if (!isInside(rootReal, realPath)) continue;
        const stat = await fs.stat(realPath);
        if (stat.isFile() && stat.size <= getConfig().rag.knowledgeSources.maxFileBytes) files.push(filename);
      } catch {}
    }
    return { files: files.sort(), truncated: found.length > limit };
  }

  async configureSelectedFiles(sourceId, selectedFiles) {
    await this.ready;
    const source = this.requireSource(sourceId);
    const normalized = normalizeSelectedFiles(selectedFiles);
    if (normalized !== null) {
      const available = await this.listAvailableFiles(sourceId);
      const allowed = new Set(available.files);
      const invalid = normalized.filter(filename => !allowed.has(filename) || !matchesSourceFilter(filename, source));
      if (invalid.length) throw new Error('Selected files are outside the source filters or unavailable: ' + invalid.slice(0, 5).join(', '));
    }
    source.selectedFiles = normalized;
    await this.clearEmbeddingCheckpoint(source.id);
    source.needsFilterRefresh = true;
    source.status = 'stale';
    source.error = null;
    source.updatedAt = new Date().toISOString();
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  async removeSource(sourceId) {
    await this.ready;
    const source = this.requireSource(sourceId);
    this.controllers.get(sourceId)?.abort();
    this.embeddingRefreshControllers.get(sourceId)?.abort();
    this.disposeWatcher(sourceId);
    const active = this.indexing.get(sourceId);
    if (active) await active.catch(() => {});
    const activeEmbeddingRefresh = this.embeddingRefresh.get(sourceId);
    if (activeEmbeddingRefresh) await activeEmbeddingRefresh.catch(() => {});
    this.sources.delete(sourceId);
    this.indexes.delete(sourceId);
    this.documents.delete(sourceId);
    const cache = this.cacheUri(sourceId);
    if (cache) await vscode.workspace.fs.delete(cache, { useTrash: false }).catch(() => {});
    await this.clearEmbeddingCheckpoint(sourceId);
    await this.persistCatalog();
    this.emitChanged();
    return { removed: sourceId };
  }

  async reindexSource(sourceId, showProgress = false, externalToken) {
    await this.ready;
    const source = this.requireSource(sourceId);
    if (this.indexing.has(sourceId)) return this.indexing.get(sourceId);
    const run = async (progress, token) => this.performReindex(source, progress, externalToken || token);
    const promise = showProgress
      ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Knowledge Sources: ' + source.name, cancellable: true }, run)
      : run(undefined, undefined);
    this.indexing.set(sourceId, promise);
    try {
      return await promise;
    } finally {
      this.indexing.delete(sourceId);
      this.controllers.delete(sourceId);
      this.emitChanged();
      if (this.pendingRefresh.delete(sourceId) && this.sources.has(sourceId)) this.scheduleRefresh(sourceId);
    }
  }

  async reindexAll(showProgress = true) {
    await this.ready;
    const sources = [...this.sources.values()].filter(source => source.enabled);
    const run = async (progress, token) => {
      const results = [];
      for (let index = 0; index < sources.length; index += 1) {
        if (token?.isCancellationRequested) throw new Error('Knowledge Sources reindex cancelled.');
        const source = sources[index];
        progress?.report({ message: 'Indexando ' + source.name + ' (' + (index + 1) + '/' + sources.length + ')…' });
        try { results.push(await this.reindexSource(source.id, false, token)); }
        catch (error) { results.push({ id: source.id, name: source.name, status: 'error', error: error instanceof Error ? error.message : String(error) }); }
      }
      return results;
    };
    return showProgress
      ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Knowledge Sources: reindexando todas', cancellable: true }, run)
      : run(undefined, undefined);
  }

  async performReindex(source, progress, token) {
    const config = getConfig();
    if (!vscode.workspace.isTrusted) throw new Error('Knowledge Sources require a trusted VS Code workspace.');
    const controller = new AbortController();
    this.controllers.set(source.id, controller);
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const signal = controller.signal;
    const checkCancelled = () => { if (signal.aborted) throw new Error('Knowledge Source indexing cancelled.'); };
    source.status = 'indexing';
    source.error = null;
    source.errors = [];
    source.progress = { phase: 'scan', current: 0, total: 0, completedItems: 0, totalItems: 0 };
    this.emitChanged();
    try {
      const rootUri = vscode.Uri.parse(source.rootUri);
      const rootReal = await fs.realpath(source.rootPath);
      const include = new vscode.RelativePattern(rootUri, buildSourceIncludeGlob(source));
      const exclude = new vscode.RelativePattern(rootUri, EXCLUDE_GLOB);
      const maxFiles = Math.max(1, Number(config.rag.knowledgeSources.maxFiles || 2000));
      const found = await vscode.workspace.findFiles(include, exclude, maxFiles + 1);
      const truncated = found.length > maxFiles;
      const files = found.slice(0, maxFiles);
      const previous = this.documents.get(source.id) || {};
      const nextDocuments = Object.create(null);
      const changed = [];
      if (truncated) source.errors.push({ file: '', message: 'Source exceeded maxFiles; additional documents were not scanned.' });
      source.progress = { phase: 'scan', current: 0, total: files.length, completedItems: 0, totalItems: 0 };
      let processed = 0;
      for (const uri of files) {
        checkCancelled();
        processed += 1;
        if (processed % 50 === 0 || processed === files.length) {
          source.progress = { phase: 'scan', current: processed, total: files.length, completedItems: 0, totalItems: 0 };
          progress?.report({ message: 'Lendo ' + processed + '/' + files.length + ' arquivos…' });
          this.emitChanged();
        }
        const filename = normalizeRelative(path.relative(source.rootPath, uri.fsPath));
        if (!filename || filename.startsWith('../') || isSensitiveFilename(filename)
          || !matchesSelectedFile(filename, source)) continue;
        try {
          const realPath = await fs.realpath(uri.fsPath);
          if (!isInside(rootReal, realPath)) {
            source.errors.push({ file: filename, message: 'Resolved path escapes the selected source folder.' });
            continue;
          }
          const stat = await fs.stat(realPath);
          if (!stat.isFile() || stat.size > config.rag.knowledgeSources.maxFileBytes) {
            if (stat.isFile() && stat.size > config.rag.knowledgeSources.maxFileBytes) {
              source.errors.push({ file: filename, message: 'File exceeds maxFileBytes and was skipped.' });
            }
            continue;
          }
          const old = previous[filename];
          const oldMtimeMs = Number.isFinite(Number(old?.mtimeMs)) ? Number(old.mtimeMs) : Number(old?.mtime || 0);
          if (old?.hash && Array.isArray(old.chunks) && !source.needsRechunk
            && Number(old.size) === stat.size && oldMtimeMs === stat.mtimeMs) {
            // Metadata is unchanged: reuse the persisted hash, chunks and vectors without reading file contents.
            nextDocuments[filename] = old;
            continue;
          }
          const bytes = await fs.readFile(realPath);
          if (looksBinary(bytes)) continue;
          const hash = sha256(bytes);
          if (old?.hash === hash && Array.isArray(old.chunks) && !source.needsRechunk) {
            nextDocuments[filename] = old;
            continue;
          }
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          const parsed = parseDocument(filename, text, config.rag.knowledgeSources);
          const reusableVectors = new Map();
          for (const oldChunk of old?.chunks || []) {
            if (!Array.isArray(oldChunk.vector) || !oldChunk.vector.length) continue;
            const key = oldChunk.embeddingHash || this.embeddingHashForChunk(source, filename, oldChunk);
            reusableVectors.set(key, oldChunk.vector);
          }
          const doc = {
            hash,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            chunks: parsed.map((chunk, index) => {
              const item = {
                id: source.id + ':' + hash.slice(0, 12) + ':' + index,
                title: chunk.title || '',
                section: chunk.section || '',
                startLine: Number.isInteger(chunk.startLine) ? chunk.startLine : null,
                endLine: Number.isInteger(chunk.endLine) ? chunk.endLine : null,
                text: chunk.text
              };
              item.embeddingHash = this.embeddingHashForChunk(source, filename, item);
              item.vector = reusableVectors.get(item.embeddingHash);
              return item;
            })
          };
          nextDocuments[filename] = doc;
          changed.push(filename);
        } catch (error) {
          if (previous[filename] && matchesSourceFilter(filename, source)) nextDocuments[filename] = previous[filename];
          source.errors.push({ file: filename, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (truncated) {
        for (const [filename, document] of Object.entries(previous)) {
          if (!Object.prototype.hasOwnProperty.call(nextDocuments, filename) && matchesSourceFilter(filename, source)
            && matchesSelectedFile(filename, source)) nextDocuments[filename] = document;
        }
      }
      checkCancelled();

      source.needsFilterRefresh = false;
      let chunks = this.flattenDocuments(source, nextDocuments);
      const vectorEnabled = config.rag.embedding.enabled && config.rag.strategy !== 'bm25';
      let embeddingFailed = false;

      // Publish and persist the text index before generating vectors. A restart can resume missing vectors.
      this.documents.set(source.id, nextDocuments);
      this.indexes.set(source.id, chunks);
      source.files = Object.keys(nextDocuments).length;
      source.chunks = chunks.length;
      source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
      const pending = vectorEnabled ? chunks.filter(chunk => !chunk.vector?.length) : [];
      const batchSize = Math.max(1, Number(config.rag.embedding.batchSize || 4));
      const concurrency = Math.max(1, Math.min(4, Number(config.rag.embedding.concurrency || 1)));
      source.progress = {
        phase: pending.length ? 'embedding' : 'complete',
        current: source.vectors,
        total: chunks.length,
        completedItems: 0,
        totalItems: pending.length,
        batchesCompleted: 0,
        batchesTotal: Math.ceil(pending.length / batchSize),
        concurrency
      };
      await this.saveIndex(source);
      await this.persistCatalog();
      this.emitChanged();

      if (pending.length) {
        try {
          const maxCharacters = Math.max(256, Number(config.rag.embedding.maxCharacters || 4000));
          const checkpointQueue = [];
          await this.ensureEmbeddingCheckpoint(source);
          await runEmbeddingBatches(pending, {
            batchSize,
            concurrency,
            signal,
            processBatch: batch => this.client.embed(
              this.embeddingInput(source, chunk.filename, chunk, maxCharacters),
              signal
            ),
            onBatchSuccess: (batch, vectors) => {
              if (!Array.isArray(vectors) || vectors.length !== batch.length) {
                throw new Error('Embedding endpoint returned ' + (Array.isArray(vectors) ? vectors.length : 0) + ' vectors for ' + batch.length + ' chunks.');
              }
              for (let index = 0; index < batch.length; index += 1) {
                const vector = vectors[index];
                if (!Array.isArray(vector) || !vector.length) throw new Error('Embedding endpoint returned an empty vector.');
                if (source.embeddingDimension && vector.length !== source.embeddingDimension) {
                  throw new Error('Embedding dimension changed from ' + source.embeddingDimension + ' to ' + vector.length + '. Rebuild this source using a consistent embedding model.');
                }
                const document = nextDocuments[batch[index].filename];
                const target = document?.chunks?.find(item => item.id === batch[index].id);
                if (target) {
                  target.vector = vector;
                  checkpointQueue.push({ id: target.id, vector });
                }
                if (!source.embeddingDimension) source.embeddingDimension = vector.length;
              }
            },
            onWaveComplete: async batchProgress => {
              // Append only the completed vectors; do not rewrite the full multi-megabyte index per batch.
              await this.appendEmbeddingCheckpoint(source, checkpointQueue.splice(0));
              chunks = this.flattenDocuments(source, nextDocuments);
              this.indexes.set(source.id, chunks);
              source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
              source.progress = {
                phase: 'embedding',
                current: source.vectors,
                total: chunks.length,
                completedItems: batchProgress.completedItems,
                totalItems: batchProgress.totalItems,
                batchesCompleted: batchProgress.completedBatches,
                batchesTotal: batchProgress.totalBatches,
                concurrency: batchProgress.concurrency
              };
              if (batchProgress.completedBatches % 4 === 0 || batchProgress.completedBatches === batchProgress.totalBatches) {
                this.emitChanged();
                progress?.report({
                  message: 'Embeddings ' + source.vectors + '/' + chunks.length +
                    ' · lotes ' + batchProgress.completedBatches + '/' + batchProgress.totalBatches
                });
              }
            }
          });
        } catch (error) {
          if (signal.aborted) throw error;
          source.error = 'Embeddings indisponíveis; busca BM25 permanece disponível: ' + (error instanceof Error ? error.message : String(error));
          embeddingFailed = true;
          this.output?.appendLine('[knowledge-sources] ' + source.name + ': ' + source.error);
        }
      }

      chunks = this.flattenDocuments(source, nextDocuments);
      const dimensions = new Set(chunks.filter(chunk => chunk.vector?.length).map(chunk => chunk.vector.length));
      if (dimensions.size > 1) throw new Error('Embedding vectors have inconsistent dimensions; the previous index was preserved.');
      this.documents.set(source.id, nextDocuments);
      this.indexes.set(source.id, chunks);
      source.embeddingDimension = dimensions.size === 1 ? [...dimensions][0] : source.embeddingDimension;
      source.needsRechunk = false;
      source.needsEmbedding = vectorEnabled && chunks.some(chunk => !chunk.vector?.length);
      source.files = Object.keys(nextDocuments).length;
      source.chunks = chunks.length;
      source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
      source.lastIndexedAt = new Date().toISOString();
      source.status = 'indexed';
      source.progress = {
        phase: embeddingFailed ? 'paused' : 'complete',
        current: source.vectors,
        total: chunks.length,
        completedItems: source.vectors,
        totalItems: chunks.length,
        batchesCompleted: source.progress?.batchesCompleted || 0,
        batchesTotal: source.progress?.batchesTotal || 0,
        concurrency
      };
      if (source.errors.length && !source.error) source.error = source.errors.length + ' file(s) could not be indexed.';
      source.updatedAt = source.lastIndexedAt;
      await this.saveIndex(source);
      if (!source.needsEmbedding) await this.clearEmbeddingCheckpoint(source.id);
      await this.persistCatalog();
      this.output?.appendLine('[knowledge-sources] Indexed ' + source.name + ': ' + source.files + ' files / ' + source.chunks + ' chunks / ' + source.vectors + ' vectors; updated ' + changed.length + ' file(s).');
      progress?.report({ message: 'Concluído: ' + source.files + ' arquivos, ' + source.chunks + ' chunks, ' + source.vectors + ' embeddings.' });
      return this.summarize(source);
    } catch (error) {
      source.status = signal.aborted ? 'cancelled' : 'error';
      source.error = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) this.output?.appendLine('[knowledge-sources:error] ' + source.name + ': ' + source.error);
      await this.persistCatalog().catch(() => {});
      throw error;
    } finally {
      cancellation?.dispose();
      this.controllers.delete(source.id);
      this.emitChanged();
    }
  }

  async getChunks(options = {}) {
    await this.ready;
    const config = getConfig();
    if (config.rag.enabled === false || config.rag.knowledgeSources.enabled === false) return [];
    const output = [];
    const selectedIds = Array.isArray(options.sourceIds) && options.sourceIds.length ? new Set(options.sourceIds.map(String)) : null;
    for (const source of this.sources.values()) {
      if (!source.enabled || (selectedIds && !selectedIds.has(source.id))) continue;

      const cachedChunks = this.indexes.get(source.id) || [];
      const hasCachedIndex = cachedChunks.length > 0;
      const isStale = source.status !== 'indexed' || source.needsRechunk || source.needsFilterRefresh;
      let indexingInBackground = false;
      if (isStale && config.rag.knowledgeSources.autoIndex) {
        if (!hasCachedIndex || source.needsFilterRefresh) {
          // No usable cache (or filters changed): do not answer from an index that violates the configured scope.
          try {
            await this.reindexSource(source.id, false);
          } catch (error) {
            this.output?.appendLine('[knowledge-sources] automatic indexing skipped for ' + source.name + ': ' + error.message);
          }
        } else if (!this.indexing.has(source.id)) {
          // Use the persisted index immediately; validate/update it in the background instead of blocking Chat.
          indexingInBackground = true;
          void this.reindexSource(source.id, false).catch(error => {
            this.output?.appendLine('[knowledge-sources] background index refresh failed for ' + source.name + ': ' + error.message);
          });
        }
      }
      if (source.needsFilterRefresh && !config.rag.knowledgeSources.autoIndex) continue;

      if (source.needsEmbedding && config.rag.knowledgeSources.autoIndex
        && !source.error?.startsWith('Embeddings indisponíveis')
        && !indexingInBackground && !this.indexing.has(source.id) && !this.embeddingRefresh.has(source.id)) {
        const refreshController = new AbortController();
        this.embeddingRefreshControllers.set(source.id, refreshController);
        const task = Promise.resolve()
          .then(() => this.refreshCachedEmbeddings(source, refreshController.signal))
          .catch(error => {
            source.needsEmbedding = false;
            source.progress = { ...(source.progress || {}), phase: 'paused' };
            source.error = 'Embeddings indisponíveis; busca BM25 permanece disponível: ' + (error instanceof Error ? error.message : String(error));
            this.output?.appendLine('[knowledge-sources] background embedding refresh failed for ' + source.name + ': ' + error.message);
            this.emitChanged();
          })
          .finally(() => {
            this.embeddingRefresh.delete(source.id);
            this.embeddingRefreshControllers.delete(source.id);
            this.emitChanged();
          });
        this.embeddingRefresh.set(source.id, task);
        this.emitChanged();
      }

      const sourceChunks = this.indexes.get(source.id) || [];
      output.push(...sourceChunks.filter(chunk => matchesRetrievalScope(chunk, options)));
    }
    return output;
  }

  async refreshCachedEmbeddings(source, signal) {
    const config = getConfig();
    const documents = this.documents.get(source.id) || {};
    let chunks = this.flattenDocuments(source, documents);
    const pending = chunks.filter(chunk => !chunk.vector?.length);
    if (!config.rag.embedding.enabled || config.rag.strategy === 'bm25' || !pending.length) {
      source.needsEmbedding = false;
      return;
    }

    const batchSize = Math.max(1, Number(config.rag.embedding.batchSize || 4));
    const concurrency = Math.max(1, Math.min(4, Number(config.rag.embedding.concurrency || 1)));
    const maxCharacters = Math.max(256, Number(config.rag.embedding.maxCharacters || 4000));
    const checkpointQueue = [];
    await this.ensureEmbeddingCheckpoint(source);
    source.progress = {
      phase: 'embedding',
      current: chunks.filter(chunk => chunk.vector?.length).length,
      total: chunks.length,
      completedItems: 0,
      totalItems: pending.length,
      batchesCompleted: 0,
      batchesTotal: Math.ceil(pending.length / batchSize),
      concurrency
    };
    this.emitChanged();

    await runEmbeddingBatches(pending, {
      batchSize,
      concurrency,
      signal,
      processBatch: batch => this.client.embed(
        this.embeddingInput(source, chunk.filename, chunk, maxCharacters),
        signal
      ),
      onBatchSuccess: (batch, vectors) => {
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
          throw new Error('Embedding endpoint returned an unexpected number of vectors.');
        }
        for (let index = 0; index < batch.length; index += 1) {
          const vector = vectors[index];
          if (!Array.isArray(vector) || !vector.length) throw new Error('Embedding endpoint returned an empty vector.');
          if (source.embeddingDimension && vector.length !== source.embeddingDimension) {
            throw new Error('Embedding dimension changed from ' + source.embeddingDimension + ' to ' + vector.length + '.');
          }
          const target = documents[batch[index].filename]?.chunks?.find(item => item.id === batch[index].id);
          if (target) {
            target.vector = vector;
            checkpointQueue.push({ id: target.id, vector });
          }
          if (!source.embeddingDimension) source.embeddingDimension = vector.length;
        }
      },
      onWaveComplete: async batchProgress => {
        await this.appendEmbeddingCheckpoint(source, checkpointQueue.splice(0));
        chunks = this.flattenDocuments(source, documents);
        this.indexes.set(source.id, chunks);
        source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
        source.needsEmbedding = chunks.some(chunk => !chunk.vector?.length);
        source.progress = {
          phase: 'embedding',
          current: source.vectors,
          total: chunks.length,
          completedItems: batchProgress.completedItems,
          totalItems: batchProgress.totalItems,
          batchesCompleted: batchProgress.completedBatches,
          batchesTotal: batchProgress.totalBatches,
          concurrency: batchProgress.concurrency
        };
        if (batchProgress.completedBatches % 4 === 0 || batchProgress.completedBatches === batchProgress.totalBatches) this.emitChanged();
      }
    });

    chunks = this.flattenDocuments(source, documents);
    const dimensions = new Set(chunks.filter(chunk => chunk.vector?.length).map(chunk => chunk.vector.length));
    if (dimensions.size > 1) throw new Error('Embedding vectors have inconsistent dimensions.');
    this.indexes.set(source.id, chunks);
    source.vectors = chunks.filter(chunk => chunk.vector?.length).length;
    source.embeddingDimension = dimensions.size === 1 ? [...dimensions][0] : source.embeddingDimension;
    source.needsEmbedding = chunks.some(chunk => !chunk.vector?.length);
    source.progress = { phase: 'complete', current: source.vectors, total: chunks.length, completedItems: pending.length, totalItems: pending.length, batchesCompleted: source.progress?.batchesTotal || 0, batchesTotal: source.progress?.batchesTotal || 0, concurrency };
    source.error = null;
    await this.saveIndex(source);
    if (!source.needsEmbedding) await this.clearEmbeddingCheckpoint(source.id);
    await this.persistCatalog();
    this.emitChanged();
  }

  embeddingInput(source, filename, chunk, maxCharacters = getConfig().rag.embedding.maxCharacters) {
    return ('source: ' + source.name + '\nfile: ' + filename + '\nsection: ' + (chunk.section || '') + '\n' + chunk.text).slice(0, Math.max(256, Number(maxCharacters) || 4000));
  }

  embeddingHashForChunk(source, filename, chunk) {
    const maxCharacters = getConfig().rag.embedding.maxCharacters;
    return sha256(embeddingFingerprint() + '|' + maxCharacters + '|' + this.embeddingInput(source, filename, chunk, maxCharacters));
  }

  async configureTags(sourceId, tags) {
    await this.ready;
    const source = this.requireSource(sourceId);
    source.tags = normalizeSourceTags(tags);
    source.updatedAt = new Date().toISOString();
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  async setRerankEnabled(sourceId, enabled) {
    await this.ready;
    const source = this.requireSource(sourceId);
    source.rerankEnabled = Boolean(enabled);
    source.updatedAt = new Date().toISOString();
    await this.persistCatalog();
    this.emitChanged();
    return this.summarize(source);
  }

  flattenDocuments(source, documents) {
    const chunks = [];
    for (const [filename, document] of Object.entries(documents)) {
      for (const chunk of document.chunks || []) chunks.push(this.toSearchChunk(source, filename, chunk, document.hash, document.mtimeMs));
    }
    return chunks;
  }

  toSearchChunk(source, filename, chunk, documentHash, documentMtimeMs = 0) {
    const uri = vscode.Uri.file(path.join(source.rootPath, filename));
    const searchablePath = source.name + ' ' + filename + ' ' + (chunk.title || '') + ' ' + (chunk.section || '');
    const content = String(chunk.text || '');
    return {
      id: chunk.id,
      uri,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: 'local-folder',
      filename: normalizeRelative(filename),
      displayFilename: source.name + '/' + normalizeRelative(filename),
      title: chunk.title || '',
      section: chunk.section || '',
      startLine: Number.isInteger(chunk.startLine) ? chunk.startLine : null,
      endLine: Number.isInteger(chunk.endLine) ? chunk.endLine : null,
      text: content,
      hash: documentHash,
      vector: Array.isArray(chunk.vector) ? chunk.vector : undefined,
      embeddingHash: chunk.embeddingHash || this.embeddingHashForChunk(source, filename, chunk),
      tags: normalizeSourceTags(source.tags),
      rerankEnabled: source.rerankEnabled !== false,
      mtimeMs: Number(documentMtimeMs || 0),
      tokens: tokenize(searchablePath + ' ' + content),
      pathTokens: new Set(tokenize(searchablePath))
    };
  }

  setupWatcher(source) {
    if (!source.enabled || this.watchers.has(source.id) || getConfig().rag.knowledgeSources.watch === false) return;
    try {
      const pattern = new vscode.RelativePattern(vscode.Uri.parse(source.rootUri), buildSourceIncludeGlob(source));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = () => this.scheduleRefresh(source.id);
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.watchers.set(source.id, watcher);
    } catch (error) {
      this.output?.appendLine('[knowledge-sources] watcher unavailable for ' + source.name + ': ' + error.message);
    }
  }

  scheduleRefresh(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source || source.status === 'error' || source.status === 'cancelled') return;
    const previous = this.watchTimers.get(sourceId);
    if (previous) clearTimeout(previous);
    this.watchTimers.set(sourceId, setTimeout(() => {
      this.watchTimers.delete(sourceId);
      if (this.indexing.has(sourceId)) { this.pendingRefresh.add(sourceId); return; }
      this.reindexSource(sourceId, false).catch(error => this.output?.appendLine('[knowledge-sources] watcher refresh failed: ' + error.message));
    }, 700));
  }

  disposeWatcher(sourceId) {
    this.watchers.get(sourceId)?.dispose();
    this.watchers.delete(sourceId);
    const timer = this.watchTimers.get(sourceId);
    if (timer) clearTimeout(timer);
    this.watchTimers.delete(sourceId);
  }

  async listSources() {
    await this.ready;
    return this.listSourcesSync();
  }

  listSourcesSync() {
    return [...this.sources.values()].map(source => this.summarize(source));
  }

  summarize(source) {
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      rootUri: source.rootUri,
      rootPath: source.rootPath,
      enabled: source.enabled,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      lastIndexedAt: source.lastIndexedAt,
      status: source.status,
      files: source.files,
      chunks: source.chunks,
      vectors: source.vectors,
      error: source.error,
      errors: (source.errors || []).slice(0, 30),
      documents: Object.keys(this.documents.get(source.id) || {}).slice(0, 20),
      includeDirectories: source.includeDirectories || [],
      extensions: source.extensions || DEFAULT_SOURCE_EXTENSIONS,
      selectedFiles: source.selectedFiles === null ? null : (source.selectedFiles || []),
      selectedFileCount: source.selectedFiles === null ? null : (source.selectedFiles || []).length,
      tags: normalizeSourceTags(source.tags),
      rerankEnabled: source.rerankEnabled !== false,
      progress: source.progress || null,
      indexing: this.indexing.has(source.id) || this.embeddingRefresh.has(source.id)
    };
  }

  async openDocument(sourceId, filename) {
    await this.ready;
    const source = this.requireSource(sourceId);
    const relative = normalizeRelative(filename);
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Invalid source document path.');
    const absolute = path.resolve(source.rootPath, relative);
    if (!isInside(source.rootPath, absolute)) throw new Error('Document path escapes its source folder.');
    const real = await fs.realpath(absolute);
    if (!isInside(await fs.realpath(source.rootPath), real)) throw new Error('Document symlink escapes its source folder.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(real));
    await vscode.window.showTextDocument(document, { preview: false });
    return { filename: relative };
  }

  requireSource(sourceId) {
    const source = this.sources.get(String(sourceId || ''));
    if (!source) throw new Error('Knowledge Source not found.');
    return source;
  }

  emitChanged() {
    this.emitter.fire({ sources: this.listSourcesSync() });
  }

  handleConfigurationChange(event) {
    this.updateWatchers();
    const parserKeys = ['chunkLines', 'chunkOverlapLines', 'chunkCharacters', 'chunkOverlapCharacters'];
    const scanKeys = ['maxFiles', 'maxFileBytes'];
    const parserChanged = parserKeys.some(key => event.affectsConfiguration('llamaCpp.rag.knowledgeSources.' + key));
    const scanChanged = scanKeys.some(key => event.affectsConfiguration('llamaCpp.rag.knowledgeSources.' + key));
    if (parserChanged || scanChanged) {
      for (const source of this.sources.values()) {
        source.status = 'stale';
        if (parserChanged) source.needsRechunk = true;
      }
      this.emitChanged();
    }
  }

  updateWatchers() {
    for (const source of this.sources.values()) {
      if (getConfig().rag.knowledgeSources.watch === false || !source.enabled) this.disposeWatcher(source.id);
      else this.setupWatcher(source);
    }
  }

  dispose() {
    for (const sourceId of [...this.watchers.keys()]) this.disposeWatcher(sourceId);
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.embeddingRefreshControllers.values()) controller.abort();
    this.emitter.dispose();
  }
}

function embeddingFingerprint() {
  const config = getConfig();
  return [
    config.provider, config.mode, config.api.baseUrl, config.api.model,
    config.local.host, config.local.port, config.local.modelPath,
    config.rag.embedding.baseUrl, config.rag.embedding.model,
    config.openai.embeddingModel, config.openai.useForEmbeddings,
    config.rag.embedding.enabled
  ].join('|');
}
function parserFingerprint() {
  const options = getConfig().rag.knowledgeSources;
  return [INDEX_VERSION, options.chunkLines, options.chunkOverlapLines, options.chunkCharacters, options.chunkOverlapCharacters].join('|');
}
module.exports = { KnowledgeSourcesManager, embeddingFingerprint, parserFingerprint, isSafeDocumentPath, INCLUDE_GLOB, EXCLUDE_GLOB };
