# Changelog

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
