# llama.cpp Assistant for VS Code

A VS Code extension that turns a local or remote `llama.cpp` server into a coding assistant with native VS Code Chat integration, inline autocomplete, code actions, RAG, Markdown streaming, performance metrics, and Copilot-style inline suggestion controls.

## v0.7.0 highlights

- **Copilot-style Status Bar menu** for inline suggestions.
- Status icon shows three states: enabled, disabled, or temporarily snoozed.
- Enable/disable inline suggestions globally.
- Enable/disable inline suggestions for the active VS Code language/file type.
- Language overrides use `llamaCpp.autocomplete.enable`, with `"*"` as the default, similar to `github.copilot.enable`.
- Reset a language override so it inherits the global default again.
- Snooze inline suggestions for 5, 15, or 30 minutes without changing settings.
- Trigger an inline suggestion, open Chat, open performance metrics, or open autocomplete settings directly from the Status Bar menu.
- Disabled languages are checked before RAG or llama.cpp calls, so no autocomplete request is sent for those files.

## Native Chat

The extension integrates with VS Code's native AI surfaces.

- llama.cpp models returned by `GET /v1/models` can appear in the Chat model picker.
- Native `@llama` participant with `/explain`, `/fix`, `/review`, `/tests`, `/refactor`, and `/codebase`.
- Native VS Code Chat context attachments.
- Native Markdown streaming and Chat history.
- Editor actions with diff preview before applying model-generated edits.

Run:

```text
Llama.cpp: Open Native Chat
```

Or use:

```text
@llama /codebase where is session validation implemented?
```

## Inline suggestions Status Bar menu

A small llama.cpp Assistant icon is shown in the VS Code Status Bar. Click it to configure autocomplete for the current editor.

The menu includes:

- enable/disable inline suggestions globally;
- enable/disable the current file type/language;
- reset the current language override;
- snooze suggestions temporarily;
- trigger a suggestion immediately;
- open Chat, metrics, or settings.

The active file type is resolved through the VS Code language mode. For example, a `.py` file normally uses the `python` language ID and a `.ts` file uses `typescript`.

The equivalent settings JSON is:

```json
{
  "llamaCpp.autocomplete.enabled": true,
  "llamaCpp.autocomplete.enable": {
    "*": true,
    "plaintext": false,
    "markdown": false,
    "python": true,
    "typescript": true,
    "yaml": false
  }
}
```

A language-specific value overrides `"*"`. The master `llamaCpp.autocomplete.enabled` switch disables all inline suggestions when set to `false`.

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

## Context behavior

In native Chat, use VS Code's **Add Context** control to attach files or selections explicitly.

The classic chat still has its **Current file** toggle. When that toggle is off, current and other visible editor files are not automatically attached, and visible files are filtered out of automatic RAG retrieval. Explicit `@file` references still work.

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

The performance status item reports the latest request using values such as:

```text
Chat 720ms · P88.9 · G6.7 · C✓
```

It reports TTFT, prompt tokens/s, generation tokens/s, and prompt-cache state when the server exposes it.

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
