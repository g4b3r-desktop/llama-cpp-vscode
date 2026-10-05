# Aba própria do llama.cpp Assistant

A partir da v0.13.0, a interface principal do projeto fica em uma aba própria da **Activity Bar** do VS Code, separada do painel de Chat/Copilot.

## Abrir

Clique no ícone **llama.cpp** na Activity Bar ou execute:

```text
Llama.cpp: Open Assistant Tab
```

O `@llama` continua disponível no Chat nativo do VS Code para compatibilidade. Para abri-lo explicitamente:

```text
Llama.cpp: Open Native VS Code Chat (@llama)
```

## Modos

A aba própria oferece quatro modos no seletor acima do campo de prompt:

- **Ask** — chat normal, com histórico opcional, arquivo atual e RAG.
- **Agent** — executa o fluxo Analyze → Plan → Execute → Verify com ferramentas controladas.
- **Research** — usa o Agent Mode com pesquisa web detalhada e fontes.
- **Fresh** — inferência isolada, sem histórico anterior.

## Contexto

O toggle **Arquivo atual** controla o envio automático do editor atual/contexto recuperado. Referências explícitas `@arquivo` continuam disponíveis.

Em **Ask**, o toggle **Usar conversa anterior** controla o histórico enviado ao modelo. Agent, Research e Fresh não reutilizam automaticamente o histórico do chat.

## Agent Mode

Durante uma tarefa do agente, a aba mostra o plano operacional público e atualiza os estados:

```text
○ pendente
● executando
✓ concluído
✗ falhou
```

Resultados de terminal, filesystem, diagnostics e web continuam passando pelo Tool Host da extensão. O LLM não recebe acesso direto ao filesystem, terminal ou rede.

Depois de alterações no workspace, a fase Verify mostra se diagnostics e um comando de teste/build/lint/typecheck foram executados.

## Provider

O cabeçalho da aba mostra o provider atual (`llama.cpp` ou OpenAI). Use o botão de engrenagem ou:

```text
Llama.cpp: Manage Model Provider
```

## Rollback

O botão **Rollback** desfaz a última sessão do Agent Mode usando os backups controlados pela extensão.
