# llama.cpp Assistant for VS Code

VS Code extension for local or remote llama.cpp with inline autocomplete, Markdown chat, streaming, workspace RAG, hybrid retrieval, reranking and explicit `@file` context.

## Features

- Inline autocomplete via llama.cpp FIM or OpenAI-compatible completions
- Chat with streaming responses
- Markdown rendering in chat
- Per-request toggle to include or exclude the current VS Code file from model context
- Explicit `@file` and `@"path with spaces"` references
- Workspace indexing and RAG
- Hybrid BM25 + vector retrieval
- Optional embeddings and reranking endpoints
- Persistent workspace cache
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

The chat UI includes a **Current file** toggle. When disabled, the active editor file is not attached automatically and is also excluded from automatic RAG retrieval for that request. Explicit `@file` references still work.

Examples:

```text
Explain @src/server.ts
```

```text
Compare @src/server.ts with @src/api/router.ts
```

## License

MIT
