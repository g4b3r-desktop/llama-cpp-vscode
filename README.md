# llama.cpp Assistant para VS Code

Extensão para transformar o VS Code em um assistente de programação com suporte a **llama.cpp local/remoto** e à **API da OpenAI**. O projeto reúne Chat nativo, Agent Mode, pesquisa web controlada, sugestões inline, ações de edição, RAG, rollback, métricas de desempenho e gerenciamento automático da janela de contexto.

## Principais recursos

- Chat nativo do VS Code com `@llama`.
- Provider alternável entre `llama.cpp` e OpenAI.
- **Context Budget Manager** para impedir prompts maiores que a janela disponível.
- Detecção automática de `n_ctx` em servidores llama.cpp atuais.
- Agent Mode com ferramentas controladas para arquivos, buscas, diagnósticos e terminal.
- Pesquisa detalhada na internet com Brave Search ou SearXNG.
- Modo `/fresh` para inferência sem histórico anterior.
- Sugestões inline por linguagem/tipo de arquivo.
- Edição, correção, refatoração, revisão e geração de testes.
- RAG com BM25, embeddings, busca híbrida e reranking opcional.
- Diff, backups e rollback de sessões do agente.
- Métricas de TTFT, tokens/s e cache quando o backend fornece esses dados.

## Requisitos

- VS Code `1.117.0` ou superior.
- Para modo local: `llama-server` disponível no sistema ou configurado em `llamaCpp.local.executable`.
- Para OpenAI: uma chave válida da API da OpenAI.
- Para pesquisa web: Brave Search API ou uma instância SearXNG configurada.

## Instalação

Baixe o `.vsix` da versão mais recente em **Releases** e instale pelo VS Code:

1. Abra a Command Palette com `Ctrl+Shift+P`.
2. Execute **Extensions: Install from VSIX...**.
3. Selecione `llama-cpp-assistant-<versão>.vsix`.
4. Execute **Developer: Reload Window** se necessário.

Para desenvolvimento, use `Ctrl+F5` para iniciar um Extension Development Host sem pausar na primeira linha. `F5` inicia depuração e pode deixar o Extension Host parado aguardando o debugger.

---

## Escolhendo o provider

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

# Context Budget Manager

A partir da **v0.11.0**, Chat e Agent Mode passam por um gerenciador de orçamento antes de cada inferência.

O objetivo é impedir erros como:

```text
request (5673 tokens) exceeds the available context size (4096 tokens)
```

Em servidores llama.cpp atuais, a extensão tenta descobrir automaticamente `n_ctx` através de `/props`. Quando o servidor também oferece contagem de tokens para Chat Completions, o plugin usa essa contagem antes de enviar a inferência. Em versões antigas, usa um fallback configurável e uma estimativa conservadora.

Para OpenAI, a extensão usa uma janela configurável localmente para montar o orçamento. Isso é um limite de segurança da extensão e deve ser ajustado de acordo com o modelo escolhido.

## Ordem de prioridade do contexto

O plugin preserva primeiro o que é essencial:

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
3. remover ciclos antigos completos do Agent Mode sem separar `tool_call` do respectivo resultado;
4. reduzir o final do contexto automático, RAG e anexos, mantendo o prompt atual;
5. reduzir o resumo inicial do workspace do agente;
6. diminuir a reserva de saída até `llamaCpp.context.minOutputTokens`;
7. se ainda não couber, retornar um erro claro **antes** de chamar o provider.

A extensão não deve cortar silenciosamente o texto essencial digitado pelo usuário apenas para forçar o prompt a caber.

## Configuração do orçamento

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

### `llamaCpp.context.windowTokens`

Override manual da janela. `0` significa automático/fallback.

Exemplo para forçar 8192:

```json
{
  "llamaCpp.context.windowTokens": 8192
}
```

### `llamaCpp.context.llamaCppFallbackTokens`

Usado quando um servidor llama.cpp não expõe a janela de contexto e ela não pode ser inferida da configuração local.

### `llamaCpp.context.openAIContextWindowTokens`

Limite usado pelo gerenciador para o provider OpenAI. Ajuste para o modelo utilizado se necessário.

### `llamaCpp.context.safetyMarginTokens`

Reserva para diferenças de tokenização/chat template e overhead do backend.

### `llamaCpp.context.minOutputTokens`

Quantidade mínima que o gerenciador tenta preservar para a resposta ou para a próxima decisão do agente.

### Exemplo: servidor com 4096 tokens

Com:

```json
{
  "llamaCpp.local.args": ["--ctx-size", "4096"],
  "llamaCpp.chat.maxTokens": 1024,
  "llamaCpp.context.safetyMarginTokens": 128,
  "llamaCpp.context.minOutputTokens": 256
}
```

o gerenciador tenta montar cada chamada respeitando os 4096 tokens. Se o histórico crescer, mensagens antigas são removidas antes de reduzir o contexto do pedido atual.

O comando `/fresh` continua útil para começar imediatamente sem histórico:

```text
@llama /fresh analise este erro
```

---

## Configurando llama.cpp local

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

Use um tamanho compatível com o modelo e com a memória disponível.

### llama.cpp remoto

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

## Configurando OpenAI

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

O provider OpenAI pode ser usado por Chat, Agent Mode, function calling, pesquisa controlada e ações de edição.

### Controle de custos

Autocomplete e embeddings por OpenAI ficam desligados por padrão:

```json
{
  "llamaCpp.openai.useForAutocomplete": false,
  "llamaCpp.openai.useForEmbeddings": false,
  "llamaCpp.openai.embeddingModel": "text-embedding-3-small"
}
```

---

# Chat

Abra:

```text
Llama.cpp: Open Native Chat
```

Uso normal:

```text
@llama explique este código
```

Comandos disponíveis:

```text
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

## Inferência sem histórico

```text
@llama /fresh explique esta função sem considerar nossa conversa anterior
```

`/fresh` ignora as mensagens anteriores somente nessa inferência. Anexos explícitos, arquivo atual e RAG continuam independentes.

Globalmente:

```json
{
  "llamaCpp.chat.includeHistory": false
}
```

No Chat clássico existe o checkbox **Usar conversa anterior** para alterar isso por solicitação.

## Arquivo atual e contexto explícito

No Chat clássico, **Arquivo atual** controla o envio automático do arquivo/seleção ativa e editores visíveis.

No Chat nativo, use **Add Context** para anexar arquivos ou seleções explicitamente.

Referências `@arquivo` continuam disponíveis no Chat clássico.

---

# Agent Mode

Use:

```text
@llama /agent corrija os testes que estão falhando e valide a solução
```

Fluxo:

```text
Pedido
  ↓
LLM solicita uma ferramenta
  ↓
Tool Host valida permissões/parâmetros
  ↓
Extensão executa
  ↓
Resultado volta ao modelo
  ↓
Próxima decisão
```

O LLM **não recebe acesso direto** ao filesystem, terminal ou socket de rede.

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
- limite máximo de passos;
- orçamento de contexto em cada iteração.

Rollback:

```text
Llama.cpp: Roll Back Last Agent Changes
```

Configuração:

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

Em janelas pequenas, o Context Budget Manager pode compactar resultados antigos de `read_file`, terminal, web e outras ferramentas antes da próxima decisão do modelo.

---

# Pesquisa detalhada na internet

Ferramentas:

- `web_search` — encontra resultados e snippets;
- `fetch_url` — lê uma fonte HTTP(S) específica;
- `research_web` — pesquisa e lê múltiplas fontes.

Exemplo:

```text
@llama /research pesquise as mudanças mais recentes do llama.cpp server e responda com as fontes
```

Ou:

```text
@llama /agent pesquise a documentação atual da biblioteca usada neste projeto, compare com nosso código, atualize o necessário e execute os testes
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

O Context Budget Manager atua **depois** da recuperação: se o RAG trouxer mais texto do que cabe no prompt, o material de menor prioridade no final da solicitação é reduzido antes da inferência.

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

Isso ajuda a diagnosticar quanto contexto foi mantido e qual limite foi detectado.

---

# Troubleshooting

## `request (...) exceeds the available context size`

Na v0.11.0, esse erro deve ser evitado no Chat/Agent Mode pelo orçamento automático.

Se ainda ocorrer:

1. confirme que `llamaCpp.context.enabled` está `true`;
2. confira o valor de `n_ctx` no Output Channel;
3. use `llamaCpp.context.windowTokens` se o servidor reportar um limite incorreto;
4. aumente `--ctx-size` se o modelo/hardware permitirem;
5. use `/fresh` para eliminar histórico imediatamente;
6. reduza RAG/anexos em modelos com contexto muito pequeno.

## Servidor antigo sem `/props`

Defina um fallback compatível com seu servidor:

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

## `STOPPED on first line for debugging`

Isso ocorre quando o Extension Host foi iniciado pausado pelo debugger. Para executar sem depuração use:

```text
Ctrl+F5
```

---

# Comandos úteis

```text
Llama.cpp: Open Native Chat
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
- `llamaCpp.openai.store` é `false` por padrão.

# Licença

MIT
