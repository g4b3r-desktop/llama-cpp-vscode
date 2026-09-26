# llama.cpp Assistant for VS Code

A VS Code extension that turns a local or remote `llama.cpp` server into a coding assistant with native VS Code Chat integration, autonomous agent tools, inline autocomplete, code actions, RAG, Markdown streaming, performance metrics, and Copilot-style inline suggestion controls.

## v0.8.0 highlights — local Agent Mode

Use the native Chat participant with:

```text
@llama /agent fix the failing tests and verify the solution
```

The agent works as a controlled tool loop: the model chooses an action, the extension executes it, returns the result, and the model decides the next action. The LLM never receives direct filesystem or shell access.

Built-in agent tools:

- `list_directory`
- `search_files`
- `search_text`
- `read_file`
- `create_file`
- `create_directory`
- `edit_file`
- `replace_in_file`
- `delete_file`
- `move_file`
- `run_terminal`
- `get_errors`

The agent discovers relevant files itself instead of sending the entire repository to the model. It starts with only a shallow workspace summary and tool schemas.

### Agent safety

- all paths are workspace-relative;
- absolute paths and `..` traversal are rejected;
- resolved symlinks are checked so they cannot escape the workspace;
- Workspace Trust is required for writes and terminal commands;
- existing files must be read before edit/move/delete;
- hashes detect external changes before overwrite;
- delete/move and terminal operations use approval controls;
- each task has a configurable maximum step count;
- backups are stored in VS Code extension storage;
- file writes return unified diffs;
- **Llama.cpp: Roll Back Last Agent Changes** restores the last session and detects post-agent external changes before overwriting them.

The UI only shows actions such as `Procurando arquivos...`, `Lendo src/app.js...`, `Alterando src/app.js...`, `Executando comando...`, and `Tarefa concluída.`. Private model reasoning is not displayed.

### Agent settings

```json
{
  "llamaCpp.agent.enabled": true,
  "llamaCpp.agent.maxSteps": 30,
  "llamaCpp.agent.maxTokensPerStep": 2048,
  "llamaCpp.agent.temperature": 0.1,
  "llamaCpp.agent.confirmFileWrites": false,
  "llamaCpp.agent.confirmTerminalCommands": true,
  "llamaCpp.agent.terminalTimeoutMs": 120000
}
```

For llama.cpp native function/tool calling, run a compatible `llama-server` configuration (current llama.cpp supports OpenAI-style tool calls, typically with Jinja chat templates enabled). The adapter also accepts llama.cpp responses where tool arguments are returned as either a JSON string or an object.

## v0.7.0 highlights

- **Copilot-style Status Bar menu** for inline suggestions.
- Status icon shows enabled, disabled, or temporarily snoozed state.
- Enable/disable inline suggestions globally or for the active VS Code language/file type.
- `llamaCpp.autocomplete.enable` uses `"*"` as the default with language-specific overrides.
- Snooze inline suggestions for 5, 15, or 30 minutes.
- Disabled languages are checked before RAG or llama.cpp calls.

## Native Chat

The extension integrates with VS Code's native AI surfaces.

- llama.cpp models returned by `GET /v1/models` can appear in the Chat model picker.
- Native `@llama` participant with `/agent`, `/explain`, `/fix`, `/review`, `/tests`, `/refactor`, and `/codebase`.
- Native VS Code Chat context attachments, Markdown streaming, and Chat history.
- Editor actions with diff preview before applying model-generated edits.

Run:

```text
Llama.cpp: Open Native Chat
```

Or start Agent Mode directly with:

```text
Llama.cpp: Run Agent
```

## Inline suggestions Status Bar menu

Click the llama.cpp Assistant icon in the VS Code Status Bar to enable/disable inline suggestions globally or for the current file type, reset a language override, snooze suggestions, trigger completion, or open Chat/settings/metrics.

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

## Autocomplete

Inline completion supports llama.cpp FIM `/infill` and OpenAI-compatible `/v1/completions`.

```json
{
  "llamaCpp.autocomplete.profile": "fast",
  "llamaCpp.autocomplete.maxTokens": 48,
  "llamaCpp.autocomplete.maxPredictMs": 1200,
  "llamaCpp.autocomplete.relatedFilesTopK": 1
}
```

## Context behavior

In native Chat, use VS Code's **Add Context** control to attach files or selections explicitly. The classic chat still has its **Current file** toggle; when off, current/visible files are not attached or rediscovered through automatic RAG.

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

## Performance metrics

The performance status item reports TTFT, prompt tokens/s, generation tokens/s, and prompt-cache state when available.

## Development

```bash
npm run check
npm test
npx @vscode/vsce package
```

Open the repository in VS Code and press `F5` to launch an Extension Development Host.

## License

MIT
