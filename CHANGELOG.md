# Changelog

## 0.12.0
- Adicionado fluxo **Plan → Execute → Verify** ao Agent Mode.
- O agente agora gera primeiro um plano operacional público curto, sem expor chain-of-thought, e executa as etapas uma por vez.
- Estados do plano (`pending`, `running`, `completed`, `failed`) são enviados como progresso para o Chat nativo e incluídos opcionalmente na resposta final.
- A etapa final de verificação é garantida mesmo quando o modelo não a inclui no plano inicial.
- Após qualquer alteração no workspace, a verificação exige diagnostics atualizados e solicita um comando relevante de teste/build/lint/typecheck quando aplicável.
- `get_errors` pode ser executado automaticamente pelo host na fase de verificação, mantendo o LLM sem acesso direto ao VS Code Diagnostics.
- Alterações posteriores invalidam verificações anteriores, obrigando nova validação antes da conclusão.
- Chamadas de planejamento não recebem ferramentas e agora são suportadas corretamente tanto pelo llama.cpp quanto pela OpenAI Responses API.
- Adicionadas configurações `llamaCpp.agent.planning.enabled`, `maxPlanSteps`, `requireVerification` e `showFinalPlan`.
- O metadata do Chat nativo agora inclui o plano final e o estado de verificação da sessão.
- Adicionados testes unitários para parsing/fallback do plano, limite de etapas, estados públicos e classificação de ferramentas de mutação/verificação.

## 0.11.0
- Adicionado `ContextBudgetManager` compartilhado por Chat e Agent Mode para impedir requisições maiores que a janela de contexto disponível.
- O provider llama.cpp agora tenta detectar automaticamente `n_ctx` por `GET /props` e usa `--ctx-size`/fallback configurável quando a detecção não está disponível.
- Quando suportado pelo llama-server, a extensão usa `/v1/chat/completions/input_tokens` para medir o prompt real antes da inferência; versões antigas usam uma estimativa conservadora.
- O Chat remove primeiro turnos antigos, depois reduz apenas contexto automático/RAG/anexos no final do prompt e preserva a solicitação atual do usuário.
- O Agent Mode compacta resultados grandes de ferramentas e pode descartar ciclos antigos completos sem separar `tool_call` do respectivo resultado.
- A reserva de saída só é reduzida depois da compactação do contexto opcional, respeitando `llamaCpp.context.minOutputTokens`.
- Se system prompt + prompt essencial + schemas de ferramentas ainda não couberem, a extensão retorna um erro claro em vez de enviar uma requisição inválida ao provider.
- Adicionadas configurações `llamaCpp.context.*` para override de janela, fallbacks por provider, margem de segurança, saída mínima e estimativa de caracteres por token.
- Adicionados testes unitários para descoberta de `n_ctx`, orçamento com schemas de ferramentas, remoção de histórico, redução de RAG/anexos, compactação de resultados do agente e rejeição segura de prompts essenciais grandes demais.
- `npm run check` agora também valida `src/context/ContextBudgetManager.js` e `src/terminal/commandPolicy.js`.

## 0.10.1
- Adicionada a configuração `llamaCpp.chat.includeHistory` para permitir inferências sem enviar o histórico anterior da conversa.
- Adicionado o comando nativo `@llama /fresh` para ignorar o histórico somente naquela solicitação, preservando prompt atual, anexos e contexto/RAG configurados.
- Adicionado ao Chat clássico o checkbox **Usar conversa anterior**, persistido na interface e aplicável por prompt.
- O metadata do Chat clássico agora informa se histórico e arquivo atual foram incluídos na solicitação.
- README totalmente revisado e traduzido para português, com instalação, llama.cpp, OpenAI, Agent Mode, pesquisa web, sugestões inline, RAG, segurança, troubleshooting e desenvolvimento.
- Adicionada documentação específica para erros de janela de contexto do llama.cpp, incluindo uso de `/fresh`, `--ctx-size` e limites de contexto/RAG.

## 0.10.0
- Added OpenAI as a first-class model provider alongside local/remote llama.cpp.
- Added `llamaCpp.provider` with `llamacpp` and `openai` options plus a provider picker in **Llama.cpp: Manage Model Provider**.
- Added a dedicated OpenAI API key stored separately in VS Code SecretStorage.
- Added OpenAI Responses API support for normal Chat, streaming Chat, editor actions, and Agent Mode.
- Added OpenAI function calling support while preserving the application's controlled `ToolRegistry`; OpenAI never receives direct filesystem or terminal access.
- Added OpenAI model discovery through `/v1/models` and integration with the VS Code model picker.
- Added configurable OpenAI model, reasoning effort, API base URL, and response storage setting (`store` defaults to false).
- Added optional OpenAI embeddings for hybrid RAG; disabled by default unless explicitly enabled.
- Added optional OpenAI-powered inline autocomplete; disabled by default to avoid unexpected high-volume API usage/cost.
- Added unit tests for Responses API message/tool conversion, response text extraction, and function-call extraction.
- Existing llama.cpp local/API modes remain the default and continue to work unchanged.

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
