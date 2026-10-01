# Changelog

## 0.9.0
- Added controlled Agent Mode web tools: `web_search`, `fetch_url`, and `research_web`.
- Added detailed multi-source research through native Chat with `@llama /research`.
- Added Brave Search API support with a dedicated API key stored in VS Code SecretStorage.
- Added configurable SearXNG JSON API support, including local/self-hosted instances.
- Added `auto` web provider selection: Brave when a search key exists, otherwise SearXNG.
- Added SSRF protections for fetched sources: HTTP(S)-only URLs, no embedded credentials, DNS validation, pinned validated IPs, redirect revalidation, and blocking of localhost/private/link-local/reserved/metadata addresses.
- Added optional domain allowlists and blocklists plus result/source/character/timeout limits.
- Web page contents are marked as untrusted data and the agent is instructed to ignore instructions or tool requests embedded in sources.
- Detailed research asks the model to corroborate important claims and include source URLs in its final answer.
- Increased the default tool-result context limit to 30,000 characters for multi-source research.
- Added unit tests for URL/domain/IP safety rules.

## 0.8.0
- Added autonomous local Agent Mode via `@llama /agent` and **Llama.cpp: Run Agent**.
- Added a provider-agnostic `AgentModel` interface and llama.cpp tool-calling adapter.
- Added `ToolRegistry` with controlled tools for listing/searching/reading files, creating/editing/replacing/moving/deleting files, running terminal commands, and collecting VS Code diagnostics.
- Added workspace path guards that reject absolute paths, traversal, and symlink escapes.
- Existing files must be read before modification; SHA-256 hashes detect external changes before overwrite.
- Added Workspace Trust checks and confirmation controls for file/terminal operations.
- Added persistent per-session backups, unified diffs, and **Llama.cpp: Roll Back Last Agent Changes**.
- Added step limits, terminal timeout/output limits, and bounded tool-result context.
- Added progress events for the native Chat UI without exposing private model reasoning.
- Added unit tests for path safety, ToolRegistry validation/execution, and diff generation.
- GitHub Actions now runs both `npm run check` and `npm test` before packaging or publishing a release.

## 0.7.0
- Added a Copilot-style llama.cpp Assistant Status Bar menu for inline suggestion controls.
- Added enabled, disabled, and snoozed Status Bar states.
- Added global inline suggestion enable/disable from the Status Bar.
- Added per-language/file-type inline suggestion controls using VS Code language IDs.
- Added `llamaCpp.autocomplete.enable`, an object setting with `"*"` fallback and language-specific overrides similar to `github.copilot.enable`.
- Added one-click reset of a language override back to the global default.
- Added 5, 15, and 30 minute autocomplete snooze controls with resume support.
- Added quick actions for triggering a suggestion, opening native Chat, performance metrics, and autocomplete settings.
- Autocomplete now checks language policy and snooze state before RAG retrieval or any llama.cpp request.

## 0.6.0
- Added a native VS Code Language Model Chat Provider for llama.cpp models discovered from `/v1/models`.
- Added native `@llama` Chat integration with Markdown streaming and VS Code Chat history.
- Added `/explain`, `/fix`, `/review`, `/tests`, `/refactor`, and `/codebase` native slash commands.
- Added support for native VS Code Chat file/selection references as llama.cpp context.
- Added editor smart actions for inline editing, fixing, refactoring, review, tests, and asking about a selection.
- Added diff preview and explicit confirmation before applying model-generated edits.
- Preserved the classic chat as a fallback and kept the v0.5 context-isolation fix.
- Added model override support to chat requests so the VS Code model picker can select a llama.cpp model.
- Updated GitHub Actions packaging to create a GitHub Release for explicit release commits.

## 0.5.0
- Added low-latency autocomplete profiles and aggressive cancellation.
- Added TTFT, prompt tok/s, generation tok/s, and cache-hit performance indicators.
- Fixed Current file off mode so visible editors are not automatically sent or rediscovered through RAG.

## 0.4.0
- Markdown rendering in classic chat.
- Toggle to include or exclude automatic editor context.
- Explicit @file references remain supported.
- Hybrid RAG, embeddings, reranking, persistent cache, streaming chat, and FIM context.
