# Enhanced Classic Chat — v0.14.0

O **Classic Chat** continua abrindo em uma aba de editor separada, mas a partir da v0.14.0 deixa de ser apenas um fallback simples e passa a oferecer uma experiência completa de Chat/Agent.

Abra pela Command Palette:

```text
Llama.cpp: Open Enhanced Classic Chat
```

## Modos

- **Ask** — conversa normal com histórico opcional, arquivo atual, `@file` e RAG.
- **Fresh** — inferência isolada sem enviar o histórico anterior.
- **Research** — pesquisa detalhada na web usando o Tool Host controlado.
- **Agent** — Plan → Execute → Verify com ferramentas de workspace, diagnostics e terminal.

Agent e Research usam o mesmo `AgentController` da aba principal. Apenas uma sessão de Agent/Research pode executar por vez no Extension Host, evitando concorrência entre as diferentes interfaces.

## Interface

O cabeçalho mostra o provider/modelo atual e oferece ações para testar a conexão, abrir a aba principal e iniciar uma nova conversa.

O composer possui:

- auto-resize;
- Enter para enviar;
- Shift+Enter para inserir nova linha;
- tabs de modo;
- chip do arquivo atual;
- chip de histórico;
- status e reindexação do RAG;
- Cancelar, Rollback e Enviar.

Modo, toggles e rascunho são persistidos com `vscode.setState`.

## Ações das mensagens

Mensagens do usuário:

- **Copiar**;
- **Editar** — volta o texto/configuração para o composer;
- **Repetir** — executa novamente com as mesmas opções.

Respostas:

- **Copiar**;
- **Regenerar** — remove o último par correspondente do histórico quando aplicável e gera novamente.

Blocos de código possuem um botão independente de **Copiar**.

## Markdown

O renderer local suporta:

- headings;
- listas ordenadas e não ordenadas;
- task lists;
- blockquotes;
- links HTTP(S)/mailto;
- código inline;
- blocos de código;
- tabelas;
- negrito, itálico e strikethrough.

HTML arbitrário vindo do modelo não é executado.

## Empty state

Uma conversa vazia apresenta atalhos para:

- explicar o arquivo atual;
- revisar código;
- pesquisar documentação;
- iniciar uma tarefa no Agent Mode.

## Segurança

A mudança é de interface/orquestração. Agent/Research continuam usando o Tool Host controlado da extensão e as mesmas proteções existentes para paths, permissões, terminal, rede, backups, rollback e SSRF.
