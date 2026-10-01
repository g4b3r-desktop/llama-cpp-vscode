# llama.cpp Assistant for VS Code

A VS Code extension that turns a local or remote `llama.cpp` server into a coding assistant with native VS Code Chat integration, autonomous agent tools, controlled web research, inline autocomplete, code actions, RAG, Markdown streaming, performance metrics, and Copilot-style inline suggestion controls.

## v0.9.0 highlights — detailed web research

Agent Mode can now research the public internet without giving the LLM unrestricted network access. The model can choose only controlled tools exposed by the extension:

- `web_search` — discover current web results and snippets;
- `fetch_url` — safely read one public HTTP(S) source;
- `research_web` — search, diversify domains, read multiple sources, and return evidence plus URLs.

Use the native Chat command:

```text
@llama /research pesquise as mudanças mais recentes do llama.cpp server, compare várias fontes e responda com links
```

You can also use normal Agent Mode and let the model decide when web research is necessary:

```text
@llama /agent verifique na documentação atual se esta API mudou e atualize meu código se necessário
```

### Search providers

Two providers are supported:

1. **Brave Search API** — run **Llama.cpp: Set Web Search API Key**. The key is stored in VS Code SecretStorage and sent only to Brave Search.
2. **SearXNG** — set `llamaCpp.agent.web.searxngBaseUrl` to your instance. JSON output must be enabled by that SearXNG instance.

`provider: "auto"` uses Brave when a web-search key exists; otherwise it uses SearXNG.

```json
{
  "llamaCpp.agent.web.enabled": true,
  "llamaCpp.agent.web.provider": "auto",
  "llamaCpp.agent.web.searxngBaseUrl": "http://127.0.0.1:8888",
  "llamaCpp.agent.web.maxResults": 8,
  "llamaCpp.agent.web.maxSources": 5,
  "llamaCpp.agent.web.maxFetchCharacters": 20000,
  "llamaCpp.agent.web.maxResearchCharacters": 30000,
  "llamaCpp.agent.web.timeoutMs": 15000,
  "llamaCpp.agent.web.allowedDomains": [],
  "llamaCpp.agent.web.blockedDomains": []
}
```

### Web safety

The LLM never receives a raw network socket. `fetch_url` is implemented by the extension and enforces HTTP(S), rejects URL credentials, validates DNS, pins the validated IP for the connection, revalidates redirects, and blocks localhost, private/link-local/reserved networks and common cloud metadata hosts. Optional domain allow/block lists can further restrict research.

Fetched pages are explicitly marked as **untrusted external data**. The system prompt instructs the model to ignore instructions, tool requests, credential prompts, or policy overrides embedded in web pages and use source content only as evidence. Detailed research is instructed to cite the URLs it used and corroborate important claims where practical.

## v0.8.0 highlights — local Agent Mode

Use the native Chat participant with:

```text
@llama /agent fix the failing tests and verify the solution
```

The agent works as a controlled tool loop: the model chooses an action, the extension executes it, returns the result, and the model decides the next action. The LLM never receives direct filesystem, shell, or network access.

Built-in workspace/terminal tools:

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

The UI only shows actions such as `Procurando arquivos...`, `Pesquisando na web...`, `Lendo fonte web...`, `Alterando src/app.js...`, `Executando comando...`, and `Tarefa concluída.`. Private model reasoning is not displayed.

### Agent settings

```json
{
  "llamaCpp.agent.enabled": true,
  "llamaCpp.agent.maxSteps": 30,
  "llamaCpp.agent.maxTokensPerStep": 2048,
  "llamaCpp.agent.temperature": 0.1,
  "llamaCpp.agent.confirmFileWrites": false,
  "llamaCpp.agent.confirmTerminalCommands": true,
  "llamaCpp.agent.terminalTimeoutMs": 120000,
  "llamaCpp.agent.maxToolResultCharacters": 30000
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
- Native `@llama` participant with `/agent`, `/research`, `/explain`, `/fix`, `/review`, `/tests`, `/refactor`, and `/codebase`.
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

Use **Llama.cpp: Set API Key** to store the model API key in VS Code SecretStorage. Web-search credentials use the separate **Llama.cpp: Set Web Search API Key** command.

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
