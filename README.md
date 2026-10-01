# llama.cpp Assistant para VS Code

Extensão para transformar o VS Code em um assistente de programação com suporte a **llama.cpp local/remoto** e à **API da OpenAI**. O projeto reúne Chat nativo, Agent Mode, pesquisa web controlada, sugestões inline, ações de edição, RAG, métricas de desempenho e controles semelhantes aos fluxos do GitHub Copilot.

## Principais recursos

- Chat nativo do VS Code com `@llama`.
- Provider alternável entre `llama.cpp` e OpenAI.
- Agent Mode com ferramentas controladas para arquivos, buscas, diagnósticos e terminal.
- Pesquisa detalhada na internet com Brave Search ou SearXNG.
- Sugestões inline por linguagem/tipo de arquivo.
- Edição, correção, refatoração, revisão e geração de testes.
- RAG com BM25, embeddings, busca híbrida e reranking opcional.
- Diff antes de alterações importantes, backups e rollback do agente.
- Métricas de TTFT, tokens/s e cache quando o backend fornece esses dados.
- Modo de **inferência sem histórico anterior** para reduzir contexto e obter uma resposta independente da conversa anterior.

## Requisitos

- VS Code `1.117.0` ou superior.
- Para modo local: `llama-server` disponível no sistema ou configurado em `llamaCpp.local.executable`.
- Para OpenAI: uma chave válida da API da OpenAI.
- Para pesquisa web: Brave Search API ou uma instância SearXNG configurada.

## Instalação

Baixe o arquivo `.vsix` da versão mais recente em **Releases** e instale pelo VS Code:

1. Abra a Command Palette com `Ctrl+Shift+P`.
2. Execute **Extensions: Install from VSIX...**.
3. Selecione `llama-cpp-assistant-<versão>.vsix`.
4. Execute **Developer: Reload Window** se necessário.

Para desenvolvimento, abra este repositório e use `Ctrl+F5` para iniciar um Extension Development Host sem pausar na primeira linha. `F5` inicia uma sessão de depuração e pode parar o Extension Host aguardando o debugger.

---

## Escolhendo o provider de IA

Execute:

```text
Llama.cpp: Manage Model Provider
```

Você pode escolher:

- **Use llama.cpp** — modelo local ou endpoint OpenAI-compatible baseado em llama.cpp.
- **Use OpenAI API** — usa a Responses API da OpenAI.

A opção também pode ser definida no `settings.json`:

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

Argumentos adicionais são enviados para o `llama-server` por `llamaCpp.local.args`.

Exemplo com contexto de 8192 tokens:

```json
{
  "llamaCpp.local.args": [
    "--ctx-size",
    "8192"
  ]
}
```

Use um tamanho compatível com o modelo e com a memória disponível.

### Conectando a um llama.cpp remoto

```json
{
  "llamaCpp.provider": "llamacpp",
  "llamaCpp.mode": "api",
  "llamaCpp.api.baseUrl": "http://127.0.0.1:8080/v1",
  "llamaCpp.api.model": ""
}
```

Se o endpoint exigir chave, execute:

```text
Llama.cpp: Set llama.cpp/API Key
```

A chave é armazenada no SecretStorage do VS Code.

---

## Configurando a API da OpenAI

1. Execute **Llama.cpp: Manage Model Provider**.
2. Escolha **Use OpenAI API**.
3. Execute **Llama.cpp: Set OpenAI API Key**.
4. Cole sua chave da API.

A chave fica no **VS Code SecretStorage** e não no `settings.json`.

Configuração equivalente:

```json
{
  "llamaCpp.provider": "openai",
  "llamaCpp.openai.baseUrl": "https://api.openai.com/v1",
  "llamaCpp.openai.model": "gpt-5.6-luna",
  "llamaCpp.openai.reasoningEffort": "low",
  "llamaCpp.openai.store": false
}
```

O provider OpenAI é usado por:

- Chat normal e streaming;
- Agent Mode;
- function calling do agente;
- pesquisa detalhada via ferramentas da extensão;
- ações de edição/revisão/refatoração/testes;
- seleção de modelos pelo model picker do VS Code.

### Controle de custos com OpenAI

Autocomplete e embeddings via OpenAI ficam desligados por padrão:

```json
{
  "llamaCpp.openai.useForAutocomplete": false,
  "llamaCpp.openai.useForEmbeddings": false,
  "llamaCpp.openai.embeddingModel": "text-embedding-3-small"
}
```

Isso evita chamadas pagas frequentes enquanto você digita ou indexa muitos arquivos.

---

## Chat nativo

Abra com:

```text
Llama.cpp: Open Native Chat
```

Depois use:

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

### Inferência sem usar a conversa anterior

A versão `0.10.1` adiciona uma forma explícita de responder sem enviar o histórico anterior ao modelo.

No Chat nativo:

```text
@llama /fresh explique esta função sem considerar nossa conversa anterior
```

`/fresh` ignora as mensagens anteriores **somente nessa inferência**. Arquivos anexados com **Add Context**, arquivo atual/RAG automático e o prompt atual continuam podendo ser enviados normalmente.

Também existe a configuração global:

```json
{
  "llamaCpp.chat.includeHistory": false
}
```

Com `false`, solicitações normais de Chat não enviam os turnos anteriores. Para voltar ao comportamento tradicional:

```json
{
  "llamaCpp.chat.includeHistory": true
}
```

No Chat clássico há um checkbox **Usar conversa anterior**. Ele permite alterar esse comportamento a cada prompt sem modificar permanentemente o `settings.json`.

> Desativar o histórico reduz o contexto, mas não desativa automaticamente arquivo atual, anexos ou RAG. Esses mecanismos são independentes.

### Controle de arquivo atual

No Chat clássico, o checkbox **Arquivo atual** controla o envio automático do arquivo/seleção ativa e editores visíveis.

Quando desligado:

- arquivo atual não é anexado automaticamente;
- editores visíveis não são anexados automaticamente;
- referências explícitas `@arquivo` continuam funcionando;
- o RAG evita recolocar automaticamente os arquivos visíveis que foram excluídos desse modo.

No Chat nativo, use **Add Context** para anexar arquivos e seleções explicitamente.

---

## Contexto e erro "request exceeds the available context size"

Se o `llama-server` mostrar algo como:

```text
request (5673 tokens) exceeds the available context size (4096 tokens)
```

significa que a soma de instruções + histórico + código + RAG + anexos ultrapassou a janela de contexto configurada no servidor.

As principais soluções são:

1. usar `/fresh` ou desligar `llamaCpp.chat.includeHistory`;
2. aumentar `--ctx-size` se o modelo suportar;
3. reduzir o contexto automático do Chat;
4. reduzir `rag.topK`;
5. anexar menos arquivos grandes.

Exemplo conservador para um servidor com apenas 4096 tokens:

```json
{
  "llamaCpp.chat.includeHistory": false,
  "llamaCpp.chat.maxTokens": 768,
  "llamaCpp.chat.maxContextCharacters": 9000,
  "llamaCpp.chat.workspaceContextCharacters": 6000,
  "llamaCpp.chat.maxVisibleContextCharacters": 5000,
  "llamaCpp.chat.mentionedFilesMaxCharacters": 8000,
  "llamaCpp.rag.topK": 3
}
```

Esses limites usam caracteres como aproximação em várias partes da extensão; o tokenizador real depende do modelo. Se continuar excedendo, reduza mais os valores ou aumente a janela do servidor.

---

## Agent Mode

Use:

```text
@llama /agent corrija os testes que estão falhando e valide a solução
```

O agente funciona em loop controlado:

```text
Pedido do usuário
↓
Modelo escolhe uma ferramenta
↓
A extensão valida e executa a ferramenta
↓
Resultado volta para o modelo
↓
Modelo escolhe a próxima ação
↓
Repete até concluir ou atingir o limite de passos
```

O LLM **não recebe acesso direto** ao sistema de arquivos, terminal ou socket de rede.

### Ferramentas do workspace

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

### Proteções do agente

- caminhos precisam ficar dentro da raiz do workspace;
- caminhos absolutos e traversal `..` são rejeitados;
- symlinks são verificados para impedir escape do projeto;
- operações perigosas exigem Workspace Trust e/ou confirmação;
- arquivos existentes precisam ser lidos antes de editar/mover/excluir;
- SHA-256 detecta alteração externa antes de sobrescrever;
- backups são mantidos por sessão;
- alterações retornam diff;
- a última sessão pode ser revertida;
- terminal possui timeout e limite de saída;
- número de passos do agente é limitado.

Rollback:

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
  "llamaCpp.agent.maxToolResultCharacters": 30000
}
```

A interface mostra apenas ações executadas, por exemplo:

```text
Procurando arquivos...
Lendo src/app.js...
Alterando src/app.js...
Executando testes...
Analisando erros...
Tarefa concluída.
```

O raciocínio privado do modelo não é exibido.

---

## Pesquisa detalhada na internet

O Agent Mode pode usar ferramentas controladas:

- `web_search` — encontra resultados e snippets;
- `fetch_url` — lê uma fonte HTTP(S) específica;
- `research_web` — pesquisa, diversifica domínios e lê múltiplas fontes.

Exemplo:

```text
@llama /research pesquise as mudanças mais recentes do llama.cpp server e responda com as fontes
```

Ou dentro do agente:

```text
@llama /agent pesquise a documentação atual da biblioteca usada neste projeto, compare com nosso código, atualize o necessário e execute os testes
```

### Brave Search

Execute:

```text
Llama.cpp: Set Web Search API Key
```

A chave fica no SecretStorage.

### SearXNG

```json
{
  "llamaCpp.agent.web.provider": "searxng",
  "llamaCpp.agent.web.searxngBaseUrl": "http://127.0.0.1:8888"
}
```

Configuração completa típica:

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

### Segurança da pesquisa web

A extensão controla a rede e aplica proteções como:

- HTTP(S) apenas;
- rejeição de credenciais embutidas na URL;
- validação de DNS;
- revalidação de redirects;
- bloqueio de localhost, redes privadas, link-local, reservadas e hosts comuns de metadata;
- allowlist/blocklist opcionais de domínios;
- conteúdo web marcado como dado externo não confiável.

O modelo é instruído a não obedecer comandos encontrados dentro das páginas pesquisadas.

---

## Sugestões inline

A Status Bar possui um menu no estilo de controle do Copilot para:

- ativar/desativar sugestões globalmente;
- ativar/desativar por linguagem do arquivo atual;
- remover override da linguagem;
- Snooze por 5, 15 ou 30 minutos;
- retomar sugestões;
- disparar autocomplete manualmente;
- abrir Chat, métricas e configurações.

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

Para llama.cpp, autocomplete pode usar FIM `/infill` ou endpoint OpenAI-compatible `/v1/completions`.

```json
{
  "llamaCpp.autocomplete.profile": "fast",
  "llamaCpp.autocomplete.maxTokens": 48,
  "llamaCpp.autocomplete.maxPredictMs": 1200,
  "llamaCpp.autocomplete.relatedFilesTopK": 1
}
```

---

## RAG do workspace

O RAG suporta:

- BM25;
- embeddings;
- busca vetorial;
- modo híbrido;
- reranking opcional;
- cache persistente;
- `@file` explícito;
- exclusão de diretórios comuns como `.git`, `node_modules`, `dist`, `build`, `venv`, `target` e outros.

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

OpenAI embeddings são opcionais e podem ser usados mesmo com outro provider de Chat, se explicitamente habilitados.

---

## Métricas de desempenho

Quando o backend fornece dados suficientes, o indicador mostra:

- TTFT — tempo até o primeiro token;
- velocidade de processamento do prompt;
- velocidade de geração;
- tokens reutilizados pelo prompt cache.

Abra os detalhes com:

```text
Llama.cpp: Show Performance Metrics
```

---

## Comandos úteis

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

## Desenvolvimento

Validação local:

```bash
npm run check
npm test
npx @vscode/vsce package
```

Para abrir o Extension Development Host sem debugger:

```text
Ctrl+F5
```

Para depurar:

```text
F5
```

Se aparecer `STOPPED on first line for debugging`, o Extension Host está aguardando o debugger continuar; isso acontece antes da ativação da extensão.

---

## Privacidade e credenciais

- chave OpenAI: VS Code SecretStorage;
- chave do endpoint llama.cpp/API-compatible: SecretStorage separado;
- chave Brave Search: SecretStorage separado;
- o Agent Mode não entrega acesso direto ao filesystem/terminal para o LLM;
- `llamaCpp.openai.store` é `false` por padrão.

## Licença

MIT
