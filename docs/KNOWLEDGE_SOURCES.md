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

As métricas de desempenho são registradas no canal **Output → llama.cpp Assistant**, com linhas `[rag:metrics]` em JSON. A indexação registra descoberta/leitura/chunking, embeddings e persistência; a busca registra carregamento das Knowledge Sources, BM25, embedding da consulta, ranking vetorial e reranking. Cada registro inclui duração em milissegundos e contagens relevantes (arquivos, chunks, vetores, candidatos e resultados). Isso permite comparar o custo de cada etapa antes de alterar concorrência ou tamanho de lote.

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
- llamaCpp.rag.embedding.batchSize: quantidade de textos por requisição; o padrão atual é 8.
- llamaCpp.rag.embedding.concurrency: lotes simultâneos; o padrão é 2 para equilibrar velocidade e consumo de VRAM.
- llamaCpp.rag.rerank.enabled: habilitado por padrão para documentação, melhorando a ordem de resultados sem depender de um ajuste manual.
- llamaCpp.rag.embedding.maxCharacters: limite de caracteres por texto enviado ao modelo de embeddings.

Cada fonte possui o botão **Pastas e tipos**. Informe diretórios relativos separados por vírgula (por exemplo, `docs, manual`); vazio inclui todas as pastas. Em seguida, marque em uma lista as extensões que devem ser indexadas (por exemplo, `.html`, `.md`, `.js`, `.ts`). A lista contém somente os formatos textuais suportados pela extensão e permite selecionar vários tipos ao mesmo tempo. Essa configuração é independente para cada Knowledge Source e é aplicada na descoberta de arquivos, indexação e watcher. Se os tipos forem alterados, a seleção individual de arquivos é mantida somente para os caminhos que continuam compatíveis.

O botão **Tags** permite associar rótulos à fonte (por exemplo, `threejs`, `api`, `loaders`). A ferramenta `search_knowledge_base` aceita `source_ids`, `directories`, `tags` e `recent_days` para restringir cada consulta antes do ranking BM25/vetorial. Diretórios são prefixos relativos do caminho do arquivo; tags usam correspondência OR; `recent_days` considera a data de modificação do arquivo.

O botão **Rerank** vem ativado por padrão em novas fontes e permite habilitar/desabilitar reranking individualmente, sem alterar a política do Workspace RAG. Para fontes, a chamada só é feita quando `llamaCpp.rag.rerank.baseUrl` aponta explicitamente para um servidor de reranking (por exemplo, um serviço llama-server iniciado com suporte a reranking); a extensão não envia acidentalmente essa chamada ao servidor principal de chat. O modelo opcional é definido em `llamaCpp.rag.rerank.model`. Se a URL não estiver configurada ou o endpoint falhar, a busca mantém os resultados BM25/vetoriais.

O botão **Arquivos** abre a lista de documentos encontrados dentro desses filtros. Selecione individualmente os arquivos que poderão alimentar o RAG. A seleção é persistida por fonte; arquivos não selecionados são removidos do índice ativo e não entram na recuperação. Para voltar a usar todos os arquivos compatíveis, marque **Todos os arquivos compatíveis** na lista. A seleção também limita a preservação de documentos durante reindexações parciais.

A interface mostra a fase atual, arquivos lidos, embeddings concluídos, lotes e concorrência. A concorrência é limitada a 4 pelo código e deve ser aumentada gradualmente; em GPUs com pouca VRAM, mantenha 1.

O cache incremental identifica chunks pelo hash do texto efetivamente enviado ao modelo de embeddings, incluindo contexto de fonte/arquivo/seção e fingerprint do modelo. Quando um documento muda, chunks idênticos reutilizam seus vetores e somente os chunks novos ou alterados são re-embedados. O formato JSON/JSONL existente permanece compatível; documentos antigos recebem o hash de chunk durante a leitura e continuam válidos.

A estratégia BM25/vector/hybrid e o Context Budget Manager continuam compartilhados. O reranking do Workspace RAG permanece controlado por `llamaCpp.rag.rerank.enabled`; a opção individual das Knowledge Sources não ativa reranking para o workspace.

## Segurança e limitações

As fontes precisam ser selecionadas explicitamente pelo usuário e exigem workspace confiável do VS Code. Pastas de sistema, arquivos binários e nomes de arquivos associados a segredos são ignorados. Cada caminho é validado por realpath; symlinks que escapem da pasta cadastrada não são indexados. A ferramenta de abertura de documentos repete a validação antes de abrir o arquivo.

O conteúdo recuperado é dado não confiável. Instruções contidas nas documentações não podem alterar as instruções do sistema, solicitar permissões ou controlar ferramentas.

A busca combinada limita a quantidade de resultados por origem para reduzir a dominação de uma única fonte. O RAG continua sujeito ao orçamento de contexto já aplicado pelo ContextBudgetManager.
