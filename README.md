# llama.cpp Assistant for VS Code

A VS Code extension that turns a local or remote `llama.cpp` server into a coding assistant with native VS Code Chat integration, inline autocomplete, code actions, RAG, Markdown streaming, and performance metrics.

## v0.6.0 highlights

The extension now integrates with VS Code's native AI surfaces instead of relying only on its custom Webview chat.

- **Native VS Code Chat model provider**: models returned by `GET /v1/models` can appear in the Chat model picker under **llama.cpp**.
- **Native `@llama` chat assistant** with slash commands:
  - `/explain`
  - `/fix`
  - `/review`
  - `/tests`
  - `/refactor`
  - `/codebase`
- **Native Chat context attachments**: file and selection references attached with VS Code's context picker are read and sent to llama.cpp.
- **Native Chat history and Markdown streaming** through the VS Code Chat UI.
- **Editor AI actions** in the editor context menu:
  - Inline Edit
  - Fix Selection
  - Refactor Selection
  - Ask About Selection
  - Review Selection
  - Generate Tests
- **Diff preview before applying edits**.
- Existing FIM autocomplete, hybrid RAG, embeddings, reranking, performance metrics, SecretStorage keys, and classic chat remain available.

## Requirements

- VS Code 1.117 or newer.
- A `llama-server` installed locally, **or** an OpenAI-compatible remote API.

## Native Chat

Run:

```text
Llama.cpp: Open Native Chat
```

The command opens VS Code Chat and pre-fills `@llama` when supported by the host.

You can also open Chat normally and type:

```text
@llama explain this project
```

Use slash commands for common workflows:

```text
@llama /review review the authentication flow
```

```text
@llama /codebase where is session validation implemented?
```

### Model picker

The extension contributes a **llama.cpp** model provider to VS Code. It discovers models from:

```text
GET /v1/models
```

Select one of the llama.cpp models in VS Code's Chat model picker. `llamaCpp.api.model` remains the default/fallback model.

## Context behavior

In native Chat, use VS Code's **Add Context** control to attach files or selections explicitly. The `@llama` participant reads supported file/selection references and sends their content to llama.cpp.

The classic chat still has its **Current file** toggle. When that toggle is off, current and other visible editor files are not automatically attached, and visible files are filtered out of automatic RAG retrieval. Explicit `@file` references still work.

## Inline editing and smart actions

Right-click code and open **llama.cpp Assistant**. Edit-producing actions generate a proposal and open a VS Code diff before offering **Apply**.

## Autocomplete

Inline completion supports llama.cpp FIM `/infill` and OpenAI-compatible `/v1/completions`.

Recommended low-latency settings:

```json
{
  "llamaCpp.autocomplete.profile": "fast",
  "llamaCpp.autocomplete.maxTokens": 48,
  "llamaCpp.autocomplete.maxPredictMs": 1200,
  "llamaCpp.autocomplete.relatedFilesTopK": 1
}
```

## API mode

```json
{
  "llamaCpp.mode": "api",
  "llamaCpp.api.baseUrl": "http://127.0.0.1:8080/v1",
  "llamaCpp.api.model": ""
}
```

Use **Llama.cpp: Set API Key** to store the key in VS Code SecretStorage.

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

## Workspace RAG

The extension supports BM25, vectors, hybrid retrieval, optional reranking, persistent caching, and explicit file context.

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

## Performance metrics

The status bar reports the latest request using values such as:

```text
Chat 720ms · P88.9 · G6.7 · C✓
```

- TTFT (time to first token)
- prompt tokens/s
- generation tokens/s
- prompt-cache hit state when the server reports it

Use **Llama.cpp: Show Performance Metrics** for details.

## Development

Open the repository in VS Code and press `F5` to launch an Extension Development Host.

Validate JavaScript:

```bash
npm run check
```

Package:

```bash
npx @vscode/vsce package
```

## License

MIT
