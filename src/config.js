const vscode = require('vscode');

function getConfig() {
  const c = vscode.workspace.getConfiguration('llamaCpp');
  return {
    mode: c.get('mode', 'local'),
    local: {
      executable: c.get('local.executable', 'llama-server'),
      modelPath: c.get('local.modelPath', ''),
      host: c.get('local.host', '127.0.0.1'),
      port: c.get('local.port', 8080),
      autoStart: c.get('local.autoStart', true),
      args: c.get('local.args', [])
    },
    api: {
      baseUrl: c.get('api.baseUrl', 'http://127.0.0.1:8080'),
      model: c.get('api.model', '')
    },
    autocomplete: {
      enabled: c.get('autocomplete.enabled', true),
      backend: c.get('autocomplete.backend', 'auto'),
      profile: c.get('autocomplete.profile', 'fast'),
      maxTokens: c.get('autocomplete.maxTokens', 48),
      temperature: c.get('autocomplete.temperature', 0.1),
      contextLinesBefore: c.get('autocomplete.contextLinesBefore', 40),
      contextLinesAfter: c.get('autocomplete.contextLinesAfter', 10),
      maxPrefixCharacters: c.get('autocomplete.maxPrefixCharacters', 6000),
      maxSuffixCharacters: c.get('autocomplete.maxSuffixCharacters', 1800),
      maxPredictMs: c.get('autocomplete.maxPredictMs', 1200),
      debounceMs: c.get('autocomplete.debounceMs', 140),
      relatedFilesEnabled: c.get('autocomplete.relatedFilesEnabled', true),
      relatedFilesTopK: c.get('autocomplete.relatedFilesTopK', 1),
      relatedFilesMaxCharacters: c.get('autocomplete.relatedFilesMaxCharacters', 3000)
    },
    chat: {
      maxTokens: c.get('chat.maxTokens', 1024),
      temperature: c.get('chat.temperature', 0.3),
      streaming: c.get('chat.streaming', true),
      includeEditorContext: c.get('chat.includeEditorContext', true),
      maxContextCharacters: c.get('chat.maxContextCharacters', 24000),
      includeVisibleEditors: c.get('chat.includeVisibleEditors', true),
      maxVisibleFiles: c.get('chat.maxVisibleFiles', 4),
      maxVisibleContextCharacters: c.get('chat.maxVisibleContextCharacters', 16000),
      workspaceContextCharacters: c.get('chat.workspaceContextCharacters', 24000),
      mentionedFilesMaxCharacters: c.get('chat.mentionedFilesMaxCharacters', 30000),
      maxMentionedFiles: c.get('chat.maxMentionedFiles', 6)
    },
    rag: {
      enabled: c.get('rag.enabled', true),
      strategy: c.get('rag.strategy', 'auto'),
      autoIndex: c.get('rag.autoIndex', true),
      watchWorkspace: c.get('rag.watchWorkspace', true),
      includeGlob: c.get('rag.includeGlob', '**/*.{js,jsx,ts,tsx,mjs,cjs,py,java,c,cc,cpp,h,hpp,cs,go,rs,php,rb,swift,kt,kts,scala,sh,bash,zsh,lua,vue,svelte,html,css,scss,less,json,jsonc,yaml,yml,toml,xml,md,mdx,sql,graphql,gql,proto}'),
      excludeGlob: c.get('rag.excludeGlob', '**/{node_modules,.git,dist,build,out,.next,.nuxt,.venv,venv,target,vendor,coverage,.cache}/**'),
      maxFiles: c.get('rag.maxFiles', 2000),
      maxFileBytes: c.get('rag.maxFileBytes', 524288),
      chunkLines: c.get('rag.chunkLines', 80),
      chunkOverlapLines: c.get('rag.chunkOverlapLines', 20),
      topK: c.get('rag.topK', 6),
      embedding: {
        enabled: c.get('rag.embedding.enabled', true),
        baseUrl: c.get('rag.embedding.baseUrl', ''),
        model: c.get('rag.embedding.model', ''),
        batchSize: c.get('rag.embedding.batchSize', 16),
        maxCharacters: c.get('rag.embedding.maxCharacters', 6000)
      },
      rerank: {
        enabled: c.get('rag.rerank.enabled', false),
        baseUrl: c.get('rag.rerank.baseUrl', ''),
        model: c.get('rag.rerank.model', ''),
        candidates: c.get('rag.rerank.candidates', 20)
      },
      cache: {
        enabled: c.get('rag.cache.enabled', true),
        maxMegabytes: c.get('rag.cache.maxMegabytes', 128)
      }
    },
    metrics: {
      showStatusBar: c.get('metrics.showStatusBar', true)
    },
    request: {
      timeoutMs: c.get('request.timeoutMs', 120000)
    }
  };
}

function configuredBaseUrl(config = getConfig()) {
  if (config.mode === 'local') return `http://${config.local.host}:${config.local.port}`;
  return String(config.api.baseUrl).trim().replace(/\/+$/, '');
}

function endpointFromBase(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/v1') && cleanPath.startsWith('/v1/')) return `${base}${cleanPath.slice(3)}`;
  return `${base}${cleanPath}`;
}

function openAiEndpoint(path, config = getConfig()) {
  return endpointFromBase(configuredBaseUrl(config), path);
}

function llamaCppEndpoint(path, config = getConfig()) {
  let base = configuredBaseUrl(config);
  if (base.endsWith('/v1')) base = base.slice(0, -3);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = { getConfig, configuredBaseUrl, endpointFromBase, openAiEndpoint, llamaCppEndpoint };
