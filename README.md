# llama.cpp Assistant para VS Code

Extensão para transformar o VS Code em um assistente de programação com suporte a **llama.cpp local/remoto** e à **API da OpenAI**. A interface principal fica em uma **aba própria na Activity Bar**, separada do Chat/Copilot, com Ask, Agent, Research e Fresh. O projeto também mantém integração opcional com o Chat nativo via `@llama`, Agent Mode com **Plan → Execute → Verify**, pesquisa web controlada, sugestões inline, ações de edição, RAG, rollback, métricas de desempenho e gerenciamento automático da janela de contexto.

## Principais recursos

- **Aba própria `llama.cpp` na Activity Bar**, independente do painel do Copilot.
- Modos **Ask**, **Agent**, **Research** e **Fresh** no mesmo painel.
- Chat nativo do VS Code com `@llama` mantido como opção compatível.
- Provider alternável entre `llama.cpp` e OpenAI.
- Agent Mode com plano operacional público, execução por etapas e verificação final.
- Tool Host controlado para arquivos, busca, diagnostics, terminal e internet.
- **Context Budget Manager** para impedir prompts maiores que a janela disponível.
- Detecção automática de `n_ctx` em servidores llama.cpp compatíveis.
- Pesquisa detalhada na internet com Brave Search ou SearXNG.
- Modo Fresh para inferência sem histórico anterior.
- Sugestões inline por linguagem/tipo de arquivo.
- Edição, correção, refatoração, revisão e geração de testes.
- RAG com BM25, embeddings, busca híbrida e reranking opcional.
- Diff, backups e rollback de sessões do agente.
- Métricas de TTFT, tokens/s e cache quando o backend fornece esses dados.

## Arquitetura de segurança

A regra principal do projeto é:

```text
LLM
 │
 │ solicita ferramenta estruturada
 ▼
Tool Host da extensão
 │
 ├─ valida parâmetros
 ├─ restringe ao workspace
 ├─ verifica permissões
 ├─ gera diff/backups
 ├─ controla terminal/rede
 └─ executa
```

O projeto **não** implementa:

```text
LLM → filesystem diretamente
```

O modelo também não recebe acesso direto ao terminal, VS Code Diagnostics ou socket de rede.

---

# Instalação

## Requisitos

- VS Code `1.117.0` ou superior.
- Para modo local: `llama-server` disponível no sistema ou configurado em `llamaCpp.local.executable`.
- Para OpenAI: uma chave válida da API da OpenAI.
- Para pesquisa web: Brave Search API ou uma instância SearXNG configurada.

## Instalar pelo VSIX

1. Baixe o `.vsix` da versão mais recente em **Releases**.
2. Abra `Ctrl+Shift+P`.
3. Execute **Extensions: Install from VSIX...**.
4. Selecione `llama-cpp-assistant-<versão>.vsix`.
5. Execute **Developer: Reload Window** se necessário.

Para desenvolvimento use `Ctrl+F5` para abrir um Extension Development Host sem pausar na primeira linha. `F5` inicia uma sessão de depuração.

---

# Aba própria na Activity Bar

A partir da **v0.13.0**, a experiência principal do llama.cpp Assistant não depende do painel do Copilot.

Clique no ícone **llama.cpp** na Activity Bar ou execute:

```text
Llama.cpp: Open Assistant Tab
```

O painel próprio oferece quatro modos:

- **Ask** — chat normal, com histórico opcional, arquivo atual, `@file`, RAG e Context Budget Manager.
- **Agent** — executa Analyze → Plan → Execute → Verify com as ferramentas controladas do projeto.
- **Research** — executa Agent Mode com pesquisa web detalhada e fontes.
- **Fresh** — inferência isolada sem enviar a conversa anterior.

O painel também inclui:

- indicador do provider/modelo atual;
- toggle de arquivo atual;
- toggle de histórico para Ask;
- plano operacional visual do Agent Mode;
- cancelar solicitação;
- reindexar RAG;
- limpar conversa;
- rollback da última sessão do agente;
- acesso rápido ao gerenciamento do provider.

O Chat nativo do VS Code continua disponível. Para abrir explicitamente:

```text
Llama.cpp: Open Native VS Code Chat (@llama)
```

ou use `@llama` diretamente no Chat do VS Code.

Mais detalhes: [`docs/ACTIVITY_BAR.md`](docs/ACTIVITY_BAR.md).

---

# Escolhendo o provider

Execute:

```text
Llama.cpp: Manage Model Provider
```

Opções:

- **Use llama.cpp** — servidor local ou endpoint remoto OpenAI-compatible baseado em llama.cpp.
- **Use OpenAI API** — usa a Responses API da OpenAI.

Também pode configurar diretamente:

```json
{
  "llamaCpp.provider": "llamacpp"
}
```

ou:

```json
{
  "llamaCpp.provider": "openai"
}
```

---

# Configurando llama.cpp local

Exemplo:

```json
{
  "llamaCpp.provider": "llamacpp",
  "llamaCpp.mode": "local",
  "llamaCpp.local.executable": "llama-server",
  "llamaCpp.local.modelPath": "/caminho/modelo.gguf",
  "llamaCpp.local.host": "127.0.0.1",
  "llamaCpp.local.port": 8080,
  "llamaCpp.local.autoStart": true
}
```

Argumentos adicionais são enviados por `llamaCpp.local.args`:

```json
{
  "llamaCpp.local.args": [
    "--ctx-size", "8192",
    "--flash-attn", "on"
  ]
}
```

Use um `--ctx-size` compatível com o modelo e com a memória disponível.

## llama.cpp remoto

```json
{
  "llamaCpp.provider": "llamacpp",
  "llamaCpp.mode": "api",
  "llamaCpp.api.baseUrl": "http://127.0.0.1:8080/v1",
  "llamaCpp.api.model": ""
}
```

Se o endpoint exigir chave:

```text
Llama.cpp: Set llama.cpp/API Key
```

A chave fica no SecretStorage do VS Code.

---

# Configurando OpenAI

1. Execute **Llama.cpp: Manage Model Provider**.
2. Escolha **Use OpenAI API**.
3. Execute **Llama.cpp: Set OpenAI API Key**.
4. Cole a chave da API.

A chave é armazenada no **VS Code SecretStorage**, não no `settings.json`.

Exemplo:

```json
{
  "llamaCpp.provider": "openai",
  "llamaCpp.openai.baseUrl": "https://api.openai.com/v1",
  "llamaCpp.openai.model": "gpt-5.6-luna",
  "llamaCpp.openai.reasoningEffort": "low",
  "llamaCpp.openai.store": false,
  "llamaCpp.context.openAIContextWindowTokens": 128000
}
```

O provider OpenAI pode ser usado por Ask, Agent, Research, Chat nativo, function calling e ações de edição.

## Controle de custos

Autocomplete e embeddings por OpenAI ficam desligados por padrão:

```json
{
  "llamaCpp.openai.useForAutocomplete": false,
  "llamaCpp.openai.useForEmbeddings": false,
  "llamaCpp.openai.embeddingModel": "text-embedding-3-small"
}
```

O Agent Mode com planejamento usa uma chamada adicional de modelo para criar o plano público antes de executar ferramentas. Se quiser evitar essa chamada, desative `llamaCpp.agent.planning.enabled`.

---

# Context Budget Manager

A partir da **v0.11.0**, Chat e Agent Mode passam por um gerenciador de orçamento antes de cada inferência.

Ele evita erros como:

```text
request (5673 tokens) exceeds the available context size (4096 tokens)
```

Em servidores llama.cpp compatíveis, a extensão tenta descobrir automaticamente `n_ctx` através de `/props`. Quando o servidor também oferece contagem de tokens para Chat Completions, o plugin usa essa contagem antes de enviar a inferência. Em versões antigas, usa um fallback configurável e uma estimativa conservadora.

Para OpenAI, a extensão usa uma janela configurável localmente para montar o orçamento. Ajuste esse limite conforme o modelo utilizado.

## Prioridade do contexto

```text
system prompt / regras do agente
        ↓
pedido atual do usuário
        ↓
schemas das ferramentas
        ↓
contexto opcional restante
```

Quando a solicitação está grande demais, o gerenciador tenta nesta ordem:

1. remover turnos antigos do Chat;
2. compactar resultados antigos e grandes de ferramentas do agente;
3. remover ciclos antigos completos do Agent Mode sem separar `tool_call` do resultado;
4. reduzir o final do contexto automático, RAG e anexos, mantendo o prompt atual;
5. reduzir o resumo inicial do workspace do agente;
6. diminuir a reserva de saída até `llamaCpp.context.minOutputTokens`;
7. se ainda não couber, retornar erro antes de chamar o provider.

Configuração:

```json
{
  "llamaCpp.context.enabled": true,
  "llamaCpp.context.windowTokens": 0,
  "llamaCpp.context.llamaCppFallbackTokens": 4096,
  "llamaCpp.context.openAIContextWindowTokens": 128000,
  "llamaCpp.context.safetyMarginTokens": 128,
  "llamaCpp.context.minOutputTokens": 256,
  "llamaCpp.context.charactersPerToken": 3
}
```

`llamaCpp.context.windowTokens: 0` significa detectar automaticamente ou usar o fallback.

Para forçar 8192:

```json
{
  "llamaCpp.context.windowTokens": 8192
}
```

---

# Chat e Ask

Na interface principal, abra a aba **llama.cpp** e selecione **Ask**.

Também pode executar:

```text
Llama.cpp: Open Assistant Tab
```

## Inferência sem histórico

Na aba própria, selecione **Fresh**.

No Chat nativo, o equivalente é:

```text
@llama /fresh explique esta função sem considerar nossa conversa anterior
```

Globalmente:

```json
{
  "llamaCpp.chat.includeHistory": false
}
```

Em Ask, o toggle **Usar conversa anterior** controla o histórico por solicitação.

## Arquivo atual e contexto explícito

O toggle **Arquivo atual** controla o envio automático do editor atual e contexto relacionado.

Referências `@arquivo` continuam disponíveis no painel próprio e no Chat clássico.

No Chat nativo, use **Add Context** para anexar arquivos ou seleções explicitamente.

## Chat nativo opcional

A integração anterior continua disponível:

```text
@llama explique este código
@llama /fresh
@llama /agent
@llama /research
@llama /explain
@llama /fix
@llama /review
@llama /tests
@llama /refactor
@llama /codebase
```

---

# Agent Mode — Plan → Execute → Verify

A partir da **v0.12.0**, o Agent Mode não começa alterando arquivos imediatamente. O fluxo padrão é:

```text
ANALYZE
   ↓
PLAN
   ↓
EXECUTE
   ↓
VERIFY
   ↓
DONE
```

Na aba própria, selecione **Agent** e descreva a tarefa, por exemplo:

```text
corrija os testes que estão falhando e valide a solução
```

O comando também abre a interface do agente:

```text
Llama.cpp: Run Agent
```

No Chat nativo, continua disponível:

```text
@llama /agent corrija os testes que estão falhando e valide a solução
```

## 1. Plan

O modelo recebe uma chamada sem ferramentas e retorna apenas um **plano operacional público** curto, por exemplo:

```text
Plano:
● Localizar a implementação afetada
○ Corrigir o comportamento
○ Atualizar os testes
○ Validar diagnostics e testes relevantes
```

Esse plano:

- é mostrado ao usuário na própria aba;
- contém apenas ações observáveis;
- não é chain-of-thought;
- não contém raciocínio privado do modelo;
- tem limite configurável de etapas;
- sempre termina em uma etapa de verificação.

Se o modelo não retornar JSON de plano válido, o host usa um plano seguro de fallback.

## 2. Execute

A extensão executa uma etapa por vez. Para cada etapa:

```text
etapa atual
   ↓
modelo solicita ferramenta
   ↓
Tool Host valida
   ↓
resultado volta ao modelo
   ↓
repete até a etapa terminar
```

Quando o modelo responde sem nova chamada de ferramenta, o host marca a etapa como concluída e avança.

Estados possíveis:

```text
○ pendente
● executando
✓ concluído
✗ falhou
```

## 3. Verify

Se algum arquivo foi alterado, verificações anteriores são invalidadas.

Antes de concluir, a extensão exige uma nova fase de verificação:

- coleta `get_errors` depois das últimas alterações;
- solicita teste/build/lint/typecheck relevante via `run_terminal` quando aplicável;
- se houver novas alterações durante a correção, a validação precisa ser feita novamente;
- se não existir comando aplicável, o modelo precisa declarar isso em vez de fingir que testes rodaram.

O host registra separadamente:

```text
workspaceChanged: true/false
diagnostics: true/false
command: true/false
```

Assim, “diagnostics verificados” e “testes executados” não são tratados como a mesma coisa.

## Resposta final

Por padrão, a resposta inclui o plano concluído:

```markdown
### Plano executado
- ✅ Localizar implementação
- ✅ Corrigir comportamento
- ✅ Atualizar testes
- ✅ Validar diagnostics e testes relevantes
```

Depois vem o resumo final do modelo com alterações e validação.

## Configuração do planejamento

```json
{
  "llamaCpp.agent.planning.enabled": true,
  "llamaCpp.agent.planning.maxPlanSteps": 6,
  "llamaCpp.agent.planning.requireVerification": true,
  "llamaCpp.agent.planning.showFinalPlan": true
}
```

### `llamaCpp.agent.planning.enabled`

Quando `true`, faz uma chamada separada para criar o plano antes da execução. Quando `false`, usa um plano mínimo de fallback sem uma chamada extra de planejamento.

### `llamaCpp.agent.planning.maxPlanSteps`

Limita o plano público entre 2 e 10 etapas.

### `llamaCpp.agent.planning.requireVerification`

Quando `true`, alterações no workspace exigem diagnostics atualizados e uma tentativa explícita de validação por teste/build/lint/typecheck quando aplicável.

### `llamaCpp.agent.planning.showFinalPlan`

Inclui o estado final do plano na resposta do agente.

## Ferramentas principais

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
- `web_search`
- `fetch_url`
- `research_web`

## Proteções

- caminhos restritos ao workspace;
- bloqueio de caminhos absolutos e traversal `..`;
- verificação de symlinks;
- Workspace Trust para operações sensíveis;
- leitura obrigatória antes de alterar/mover/excluir arquivos existentes;
- SHA-256 para detectar modificações externas;
- confirmação para operações perigosas;
- backup por sessão;
- diff das alterações;
- rollback da última sessão;
- timeout e limite de saída do terminal;
- limite máximo de iterações;
- orçamento de contexto em cada chamada;
- plano público sem exposição de raciocínio privado.

Rollback pode ser acionado pelo botão da aba ou pelo comando:

```text
Llama.cpp: Roll Back Last Agent Changes
```

Configuração principal:

```json
{
  "llamaCpp.agent.enabled": true,
  "llamaCpp.agent.maxSteps": 30,
  "llamaCpp.agent.maxTokensPerStep": 2048,
  "llamaCpp.agent.temperature": 0.1,
  "llamaCpp.agent.confirmFileWrites": false,
  "llamaCpp.agent.confirmTerminalCommands": true,
  "llamaCpp.agent.terminalTimeoutMs": 120000,
  "llamaCpp.agent.maxToolResultCharacters": 30000,
  "llamaCpp.agent.planning.enabled": true,
  "llamaCpp.agent.planning.requireVerification": true
}
```

Em janelas pequenas, o Context Budget Manager pode compactar resultados antigos de `read_file`, terminal, web e outras ferramentas antes da próxima decisão do modelo.

---

# Pesquisa detalhada na internet

Na aba própria, selecione **Research** e informe o assunto.

Ferramentas:

- `web_search` — encontra resultados e snippets;
- `fetch_url` — lê uma fonte HTTP(S) específica;
- `research_web` — pesquisa e lê múltiplas fontes.

Exemplo no painel próprio:

```text
pesquise as mudanças mais recentes do llama.cpp server e responda com as fontes
```

No Chat nativo:

```text
@llama /research pesquise as mudanças mais recentes do llama.cpp server e responda com as fontes
```

## Brave Search

```text
Llama.cpp: Set Web Search API Key
```

## SearXNG

```json
{
  "llamaCpp.agent.web.provider": "searxng",
  "llamaCpp.agent.web.searxngBaseUrl": "http://127.0.0.1:8888"
}
```

Configuração típica:

```json
{
  "llamaCpp.agent.web.enabled": true,
  "llamaCpp.agent.web.provider": "auto",
  "llamaCpp.agent.web.maxResults": 8,
  "llamaCpp.agent.web.maxSources": 5,
  "llamaCpp.agent.web.maxFetchCharacters": 20000,
  "llamaCpp.agent.web.maxResearchCharacters": 30000,
  "llamaCpp.agent.web.timeoutMs": 15000,
  "llamaCpp.agent.web.allowedDomains": [],
  "llamaCpp.agent.web.blockedDomains": []
}
```

## Segurança da web

A extensão controla a rede e aplica, entre outras proteções:

- somente HTTP(S);
- rejeição de credenciais embutidas em URL;
- validação de DNS;
- revalidação de redirects;
- bloqueio de localhost/redes privadas/link-local/reservadas/metadata;
- allowlist/blocklist opcionais;
- páginas tratadas como **dados externos não confiáveis**.

---

# Sugestões inline

A Status Bar permite:

- ativar/desativar sugestões globalmente;
- ativar/desativar por linguagem;
- remover override;
- Snooze por 5, 15 ou 30 minutos;
- retomar sugestões;
- disparar autocomplete;
- abrir Chat/configurações/métricas.

Exemplo:

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

Para llama.cpp, autocomplete pode usar `/infill` ou `/v1/completions`.

---

# RAG do workspace

Suporta:

- BM25;
- embeddings;
- busca vetorial;
- modo híbrido;
- reranking opcional;
- cache persistente;
- `@file` explícito;
- exclusão de diretórios comuns de build/dependências.

Exemplo:

```json
{
  "llamaCpp.rag.enabled": true,
  "llamaCpp.rag.strategy": "hybrid",
  "llamaCpp.rag.topK": 6,
  "llamaCpp.rag.embedding.enabled": true,
  "llamaCpp.rag.rerank.enabled": false
}
```

O Context Budget Manager atua depois da recuperação: se o RAG trouxer mais texto do que cabe, contexto opcional é reduzido antes da inferência.

---

# Métricas

Quando o backend fornece dados suficientes, o indicador pode mostrar:

- TTFT;
- prompt tokens/s;
- geração tokens/s;
- prompt cache.

Abra:

```text
Llama.cpp: Show Performance Metrics
```

O Output Channel `llama.cpp Assistant` também registra linhas como:

```text
[context:chat] n_ctx=4096 input=2310/2944 output=1024 source=llama.cpp /props trimmed=true
```

O Agent Mode registra também transições do plano:

```text
[agent:plan:plan] Plano: | ○ localizar implementação | ○ corrigir | ○ validar
[agent:plan:execute] Plano: | ● localizar implementação | ○ corrigir | ○ validar
[agent:plan:verify] Plano: | ✓ localizar implementação | ✓ corrigir | ● validar
```

---

# Troubleshooting

## A aba `llama.cpp` não aparece

1. confirme que a extensão instalada é v0.13.0 ou superior;
2. execute **Developer: Reload Window**;
3. abra `Ctrl+Shift+P` e execute **Llama.cpp: Open Assistant Tab**;
4. confira se o container `llama.cpp` não foi ocultado pelo menu de contexto da Activity Bar.

## `request (...) exceeds the available context size`

Se ocorrer:

1. confirme que `llamaCpp.context.enabled` está `true`;
2. confira o valor de `n_ctx` no Output Channel;
3. use `llamaCpp.context.windowTokens` se o servidor reportar limite incorreto;
4. aumente `--ctx-size` se modelo/hardware permitirem;
5. use Fresh para eliminar histórico imediatamente;
6. reduza RAG/anexos em modelos com contexto muito pequeno.

## Servidor antigo sem `/props`

```json
{
  "llamaCpp.context.llamaCppFallbackTokens": 4096
}
```

Ou informe diretamente:

```json
{
  "llamaCpp.context.windowTokens": 8192
}
```

## Agente termina sem executar testes

Veja o resumo/metadata de verificação. Se aparecer:

```text
diagnostics: true
command: false
```

significa que o host coletou diagnostics depois das mudanças, mas nenhum teste/build/lint/typecheck reconhecido foi executado. Isso pode ser legítimo em projetos sem comando aplicável; o agente deve explicar o motivo.

## `STOPPED on first line for debugging`

Isso ocorre quando o Extension Host foi iniciado pausado pelo debugger. Para executar sem depuração use:

```text
Ctrl+F5
```

---

# Comandos úteis

```text
Llama.cpp: Open Assistant Tab
Llama.cpp: Focus Assistant Tab
Llama.cpp: Open Native VS Code Chat (@llama)
Llama.cpp: Open Classic Chat
Llama.cpp: Run Agent
Llama.cpp: Roll Back Last Agent Changes
Llama.cpp: Manage Model Provider
Llama.cpp: Set OpenAI API Key
Llama.cpp: Set llama.cpp/API Key
Llama.cpp: Set Web Search API Key
Llama.cpp: Test Connection
Llama.cpp: Reindex Workspace (RAG)
Llama.cpp: Show RAG Index Status
Llama.cpp: Show Performance Metrics
Llama.cpp: Configure Inline Suggestions
```

---

# Desenvolvimento

```bash
npm run check
npm test
npx @vscode/vsce package
```

Sem debugger:

```text
Ctrl+F5
```

Com debugger:

```text
F5
```

---

# Privacidade e credenciais

- chave OpenAI: VS Code SecretStorage;
- chave llama.cpp/API-compatible: SecretStorage separado;
- chave Brave Search: SecretStorage separado;
- Agent Mode não entrega acesso direto ao filesystem/terminal para o LLM;
- planos públicos não incluem chain-of-thought;
- `llamaCpp.openai.store` é `false` por padrão.

# Licença

MIT