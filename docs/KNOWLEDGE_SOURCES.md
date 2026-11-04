# Knowledge Sources

Knowledge Sources registra diretórios locais de documentação e os disponibiliza ao RAG em tempo de inferência. Não há treinamento, fine-tuning nem alteração dos pesos do LLM.

## Uso

1. Abra a view **Knowledge Sources** na Activity Bar.
2. Clique em **Adicionar fonte**.
3. Selecione a pasta da documentação e informe um nome.
4. Aguarde a primeira indexação.
5. Mantenha a fonte ativa para que Ask, Fresh e @llama possam recuperá-la automaticamente.

A view mostra estatísticas reais, estado, avisos e documentos indexados. Os arquivos podem ser abertos diretamente no VS Code. Remover uma fonte elimina apenas seu catálogo e índice; a pasta original permanece intacta.

Para o Agent e Research, a ferramenta search_knowledge_base permite pesquisa explícita e filtragem opcional por source_ids.

## Formatos e chunking

| Formato | Tratamento |
|---|---|
| HTML/HTM | Remove scripts, estilos e blocos de navegação comuns; extrai título, cabeçalhos e links |
| Markdown/MDX | Preserva hierarquia de cabeçalhos e blocos de código |
| TXT | Agrupa parágrafos e aplica sobreposição |
| JSON | Reformatado quando válido e dividido em chunks |
| JSONC | Preserva o texto e divide por linhas |
| JavaScript/TypeScript e outras linguagens | Divisão por linhas, com metadados de linha |
| CSS/XML/YAML | Conteúdo textual dividido por linhas/parágrafos |

PDF e DOCX ainda não têm extratores implementados. Eles não são indexados nesta versão. Os extratores poderão ser adicionados em módulos opcionais sem tornar os formatos textuais dependentes deles.

## Persistência e atualização

Os catálogos e índices ficam em ExtensionContext.globalStorageUri/knowledge-sources, permitindo reutilização entre workspaces. O cache de cada fonte é independente do cache do Workspace RAG.

Cada documento recebe SHA-256. Em uma reindexação, todos os arquivos incluídos são verificados por hash, mas documentos sem mudança reutilizam chunks e embeddings existentes. Somente documentos novos ou alterados são reprocessados e recebem novos embeddings; documentos removidos ou excluídos pelos filtros deixam de fazer parte do índice. Falhas de leitura preservam a versão indexada anteriormente e são reportadas na view.

Os embeddings são processados em lotes com concorrência limitada. Cada lote concluído é acrescentado a um diário de checkpoints JSONL, sem reescrever o índice completo a cada lote. No próximo início, os vetores válidos são reaplicados aos chunks e o processamento continua apenas nos chunks sem vetor. Quando todos os vetores são consolidados no índice principal, o diário é removido. Isso também limita a perda de progresso em caso de cancelamento ou encerramento inesperado ao último lote ainda não persistido.

A alteração da configuração de chunking invalida o parser fingerprint e provoca reconstrução dos chunks. A alteração do fingerprint de embeddings invalida apenas os vetores; o texto e os chunks permanecem disponíveis para reconstruir os embeddings. Alterações nos filtros invalidam o fingerprint de filtros e reindexam o escopo selecionado.

## Configurações

- llamaCpp.rag.knowledgeSources.enabled: habilita a recuperação de fontes externas.
- llamaCpp.rag.knowledgeSources.autoIndex: permite indexar fontes pendentes/desatualizadas automaticamente quando consultadas.
- llamaCpp.rag.knowledgeSources.watch: monitora mudanças nas pastas.
- llamaCpp.rag.knowledgeSources.maxFiles: limite de arquivos por fonte.
- llamaCpp.rag.knowledgeSources.maxFileBytes: tamanho máximo por arquivo.
- llamaCpp.rag.knowledgeSources.maxCacheMegabytes: limite de tamanho do índice persistido das fontes externas.
- llamaCpp.rag.knowledgeSources.chunkLines e chunkOverlapLines: chunking por linhas.
- llamaCpp.rag.knowledgeSources.chunkCharacters e chunkOverlapCharacters: chunking por caracteres/parágrafos.
- llamaCpp.rag.embedding.batchSize: quantidade de textos por requisição; o padrão conservador é 4.
- llamaCpp.rag.embedding.concurrency: lotes simultâneos; o padrão é 1 para limitar pressão na VRAM.
- llamaCpp.rag.embedding.maxCharacters: limite de caracteres por texto enviado ao modelo de embeddings.

Cada fonte possui o botão **Filtros**. Informe diretórios relativos separados por vírgula (por exemplo, `docs, manual`); vazio inclui todas as pastas. Informe também as extensões aceitas (por exemplo, `html, htm, md, mdx`). As extensões precisam estar entre os formatos textuais suportados pela extensão. Os filtros são salvos por fonte e aplicados na indexação e no watcher.

O botão **Arquivos** abre a lista de documentos encontrados dentro desses filtros. Selecione individualmente os arquivos que poderão alimentar o RAG. A seleção é persistida por fonte; arquivos não selecionados são removidos do índice ativo e não entram na recuperação. Para voltar a usar todos os arquivos compatíveis, selecione todos na lista. A seleção também limita a preservação de documentos durante reindexações parciais.

A interface mostra a fase atual, arquivos lidos, embeddings concluídos, lotes e concorrência. A concorrência é limitada a 4 pelo código e deve ser aumentada gradualmente; em GPUs com pouca VRAM, mantenha 1.

A estratégia BM25/vector/hybrid, embeddings, reranking e Context Budget Manager continuam sendo os controles compartilhados de llamaCpp.rag.

## Segurança e limitações

As fontes precisam ser selecionadas explicitamente pelo usuário e exigem workspace confiável do VS Code. Pastas de sistema, arquivos binários e nomes de arquivos associados a segredos são ignorados. Cada caminho é validado por realpath; symlinks que escapem da pasta cadastrada não são indexados. A ferramenta de abertura de documentos repete a validação antes de abrir o arquivo.

O conteúdo recuperado é dado não confiável. Instruções contidas nas documentações não podem alterar as instruções do sistema, solicitar permissões ou controlar ferramentas.

A busca combinada limita a quantidade de resultados por origem para reduzir a dominação de uma única fonte. O RAG continua sujeito ao orçamento de contexto já aplicado pelo ContextBudgetManager.
