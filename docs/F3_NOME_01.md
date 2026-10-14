# F3-NOME-01 / correção F3-NOME-02

Governança: tribusca-control#108; PR #227. Sem merge/deploy até OK do COORD no SHA aprovado.

`collectionFilterActName` extrai o Nome **somente do título da publicação**: primeira linha, corte de número/data/complemento/parênteses e identificador final órgão-UF. Regras, aliases e escopos de termos salvos recebem **somente** `normalizeCollectionFilterType`; nunca o extrator. Números e palavras das regras permanecem nos padrões. Assim, `EXTRATO DO 4 TERMO ADITIVO` não vira `EXTRATO DO`, nem `AVISO DE DISPENSA ELETRONICA UASG 988675` perde sua UASG. Entrada de nova regra e prévia também só recebem normalização lexical. Identidades salvas, modos e revisão não são regravados.

O motor DOU/DOE-SP escolhe o prefixo de palavra inteira com mais palavras; empate de decisão mantém, desconhecido mantém. Tipo oficial é metadado. EXCLUDE_ALWAYS e bloqueios de empresa/match/outra origem permanecem nos caminhos existentes. Tokens de prévia foram alterados para F3-NOME-02, evitando reaproveitar prévia calculada com padrões antigos.

## Inventário em segundo plano

`loadCollectionFilterActNameInventory` é o construtor de leitura, executado **fora do request HTTP**. O cache em memória por instância de banco mantém um snapshot concluído, indexado por identidade/revisão da política, última atualização de coleta DOU/DOE-SP e epoch de visibilidade. Um único trabalho assíncrono verifica a chave e reconstrói quando necessário; timer de 15 segundos após o primeiro acesso administrativo. Não varre o acervo a cada request. Reinício do processo exige novo aquecimento; não há migration ou escrita de cache em produção.

Cada reconstrução usa transação REPEATABLE READ/READ ONLY e contexto administrativo, preservando os guardas SQL. A chave é conferida antes/depois; deriva descarta o resultado parcial, falha preserva o último snapshot e informa FAILED. Fechamento do app cancela o timer e aguarda o trabalho antes de fechar o pool. A construção é paginada e conta publicações distintas por fonte/seção/Nome; as até três amostras nunca extrapolam contagem.

`GET /state` e `GET /new-types?status=OPEN` retornam metadado aditivo `inventory:{status,key}`. Estados WARMING/READY/REFRESHING/FAILED distinguem cache frio de fila vazia. O web #112 só acrescenta a apresentação desses estados e consulta a cada três segundos enquanto prepara/atualiza; nenhuma mudança no fluxo de salvar/excluir. IDs da fila continuam de apresentação, com `queue_basis=ARCHIVE_ACT_NAME`. Regras e fila legada não são alteradas pela reconstrução.

## Fonte usada para carregar o runtime

O construtor agora resolve explicitamente `sources.id WHERE code='dou'` (UUID cadastrado, não fixo). Antes, `ORDER BY code` entre DOU/DOE-SP escolhia DOE-SP. `loadApprovedCollectionFilterRuntime(...,{readOnly:true})` carrega o **mesmo documento global aprovado**, com regras de todas as fontes, sem filtro pelo source_id. O inventário usa apenas `runtime.policy`; avalia cada item com seu próprio `source_code` e seção. Portanto, trocar a fonte que carrega a política não altera a decisão. A integração PG18 compara as duas políticas sobre os mesmos itens DOU e DOE-SP. O source_id não é usado para registrar descarte ou desconhecido nesta projeção.

## Impacto e validação

Relatório real: [f3-nome-02/RELATORIO.md](f3-nome-02/RELATORIO.md), JSON e corpus congelados no mesmo diretório. Snapshot da política revisão 225: 2.352 regras/75 termos. 3.958 títulos oficiais recentes: 55 MANTER→DESCARTAR, 256 DESCARTAR→MANTER, lista integral e URLs no relatório. Comparação por títulos/tipos oficiais, sem corpos completos; modos condicionais mantidos conservadoramente e sem previsão de purge produtivo. Relatório sintético anterior continua separado e não comprova impacto produtivo.

Testes incluem padrões salvos numéricos, aliases e termos não truncados; exemplos de Nome do ato; especificidade/desconhecido; cache frio/quente/single-flight/invalidação/deriva/falha; integração PG18 com tempos HTTP <3s, inclusive corpus sintético de 120 mil documentos. CI deve passar no SHA final antes da parada para o COORD.

Proibidos salvar regras, confirmar exclusões, apagar publicações ou publicar taxonomia em produção. #111 suspenso e intocado.
