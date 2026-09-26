# Changelog

## 0.5.0
- Added VS Code status-bar performance indicator for TTFT, prompt tok/s, generation tok/s, and prompt-cache hit/miss.
- Added `Llama.cpp: Show Performance Metrics` command.
- Added separate `fast`, `balanced`, and `quality` autocomplete profiles.
- Reduced default autocomplete prompt/output budgets for lower latency.
- Added immediate cancellation of stale autocomplete HTTP requests when typing continues.
- Added llama.cpp FIM `t_max_predict_ms` support through `llamaCpp.autocomplete.maxPredictMs`.
- Fast/balanced autocomplete no longer starts vector embedding or reranking work; it only consumes an already-loaded BM25 index for related files.
- Fixed **Current file** context control: when disabled, current and other visible editors are not automatically attached.
- Fixed RAG context leakage from visible editors while **Current file** is disabled; explicit `@file` references remain allowed.

## 0.4.0
- Markdown rendering in chat.
- Toggle to include or exclude the current VS Code file from model context.
- Explicit @file references remain supported.
- Hybrid RAG, embeddings, reranking, persistent cache, streaming chat, and FIM context.
