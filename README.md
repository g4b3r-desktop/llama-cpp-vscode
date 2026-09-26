# llama.cpp Assistant for VS Code

VS Code extension for local or remote llama.cpp with low-latency inline autocomplete, Markdown chat, streaming, workspace RAG, hybrid retrieval, reranking, explicit `@file` context, and performance telemetry.

## Features

- Inline autocomplete via llama.cpp FIM or OpenAI-compatible completions
- Separate autocomplete latency profiles: `fast`, `balanced`, and `quality`
- Immediate cancellation of stale autocomplete requests while typing
- Small FIM prompt budgets and optional `t_max_predict_ms` generation budget
- Fast/balanced autocomplete avoids embeddings/reranking and only uses an already-loaded local BM25 index for related files
- Chat with streaming responses and Markdown rendering
- Per-request **Current file** toggle controlling automatic editor context
- When **Current file** is off, neither the active file nor other visible editors are attached automatically, and visible files are filtered out of RAG results for that request
- Explicit `@file` and `@"path with spaces"` references always remain available
- Workspace indexing and RAG
- Hybrid BM25 + vector retrieval
- Optional embeddings and reranking endpoints
- Persistent workspace cache
- VS Code status-bar performance indicator with TTFT, prompt tok/s, generation tok/s, and cache hit/miss
- Local `llama-server` auto-start or remote API mode
- API keys stored in VS Code SecretStorage

## Install from source

Open this repository in VS Code and press `F5` to launch an Extension Development Host.

## Package

Install `@vscode/vsce` and run:

```bash
vsce package
```

or use the included GitHub Actions workflow, which produces a VSIX artifact on pushes to `main`.

## Basic API mode

```json
{
  "llamaCpp.mode": "api",
  "llamaCpp.api.baseUrl": "http://127.0.0.1:8080/v1",
  "llamaCpp.api.model": ""
}
```

Use the command `Llama.cpp: Set API Key` to store the key securely.

## Local mode

```json
{
  "llamaCpp.mode": "local",
  "llamaCpp.local.executable": "llama-server",
  "llamaCpp.local.modelPath": "/path/to/model.gguf",
  "llamaCpp.local.port": 8080,
  "llamaCpp.local.autoStart": true
}
```

## Low-latency autocomplete

The default `fast` profile is intentionally much smaller than the chat profile:

```json
{
  "llamaCpp.autocomplete.profile": "fast",
  "llamaCpp.autocomplete.maxTokens": 48,
  "llamaCpp.autocomplete.contextLinesBefore": 40,
  "llamaCpp.autocomplete.contextLinesAfter": 10,
  "llamaCpp.autocomplete.maxPrefixCharacters": 6000,
  "llamaCpp.autocomplete.maxSuffixCharacters": 1800,
  "llamaCpp.autocomplete.maxPredictMs": 1200,
  "llamaCpp.autocomplete.debounceMs": 140,
  "llamaCpp.autocomplete.relatedFilesTopK": 1,
  "llamaCpp.autocomplete.relatedFilesMaxCharacters": 3000
}
```

Profiles:

- `fast`: smallest prompt, max 48 output tokens, local BM25 related-file lookup only when the workspace index is already loaded, no embedding/reranking request.
- `balanced`: moderate prompt/output budget and up to two BM25 related files.
- `quality`: uses the configured autocomplete budgets and the full RAG pipeline.

Set `llamaCpp.autocomplete.maxPredictMs` to `0` if you do not want a llama.cpp FIM generation time budget.

## Performance indicator

After a chat or autocomplete request, the VS Code status bar shows a compact sample similar to:

```text
Chat 720ms · P88.9 · G6.7 · C✓
```

Where:

- first value = TTFT / time to first streamed token; for non-streaming autocomplete it is the response latency
- `P` = prompt processing tokens/second
- `G` = generation tokens/second
- `C✓` = prompt cache hit, `C×` = known miss, `C?` = API did not report cache information

Hover the indicator for details or run `Llama.cpp: Show Performance Metrics`. Disable it with:

```json
{
  "llamaCpp.metrics.showStatusBar": false
}
```

Remote OpenAI-compatible servers that do not expose llama.cpp timing/cache fields will show unavailable metrics instead of fabricated server speeds.

## RAG

```json
{
  "llamaCpp.rag.enabled": true,
  "llamaCpp.rag.strategy": "hybrid",
  "llamaCpp.rag.embedding.enabled": true,
  "llamaCpp.rag.embedding.baseUrl": "http://127.0.0.1:8081/v1",
  "llamaCpp.rag.rerank.enabled": true,
  "llamaCpp.rag.rerank.baseUrl": "http://127.0.0.1:8082/v1",
  "llamaCpp.rag.cache.enabled": true
}
```

## Chat context

The chat UI includes a **Current file** toggle.

When enabled, the current file/selection can be attached, and `llamaCpp.chat.includeVisibleEditors` may also attach other visible editors.

When disabled:

- the active file is not attached;
- other visible editors are not attached;
- visible editor files are filtered from automatic RAG results for that request;
- explicit `@file` references still work.

Examples:

```text
Explain @src/server.ts
```

```text
Compare @src/server.ts with @src/api/router.ts
```

## License

MIT
