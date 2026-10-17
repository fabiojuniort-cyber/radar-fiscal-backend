# ANAT-04 — leitores isolados de snapshots

Origem: CLAUDE-COORD → GPT-EXEC. Implementação R2 isolada; não integrada ao coletor, à classificação ou à taxonomia existentes.

`readAnatomyInput` recebe fonte (`CONFAZ`, `DOU`, `DOE-SP`, `RFB`), identificador da representação, HTML e/ou texto e a lista de recursos ausentes. Retorna texto canônico, árvore ordenada, mapa de origem, cobertura exclusiva, limitações e estado. Não acessa rede, arquivos, banco ou Railway. Todos os testes deste leitor usam documentos sintéticos; não executam o corpus real nem a reserva final.

## Texto e origem

HTML é decodificado pelo `htmlparser2` com entidades preservadas no mapa de origem. O texto mantém caracteres, acentos, combinações Unicode e espaços originais. O leitor insere uma quebra de linha após blocos/células/linhas e em `br`; essas quebras têm localizador `/separator` e `sourceSpan: null`, pois são separadores derivados, não caracteres literais do HTML.

Cada segmento do mapa cobre um intervalo `[start, end)` do texto canônico em unidades UTF-16 e aponta para o recurso, caminho DOM determinístico e intervalo da string HTML de entrada, também em UTF-16. Esses intervalos **não são offsets em bytes UTF-8**. Entidades como `&amp;` e `&#x1f600;` podem ocupar tamanhos diferentes na origem e no resultado; nenhum deslocamento linear é presumido. O mapa particiona todo o texto canônico uma única vez.

Se ambos os campos forem fornecidos, o HTML é a representação consumida; o campo `text` não é tratado como confirmação independente do texto persistido. Sem HTML, o texto original fica integralmente em parte `unidentified`, com cobertura contabilizada e estado parcial. A ausência de estrutura confiável não é um acerto de identificação.

## Partes e contexto

O perfil CONFAZ reconhece classes legais preservadas pela sanitização: epígrafe, ementa, notas, texto e redações históricas. Marcadores no início de bloco reconhecem anexos, cláusulas, artigos, parágrafos, incisos e alíneas. Uma referência a artigo ou anexo no meio da prosa não abre uma parte.

O histórico de um título de anexo alcança tabelas, linhas e células seguintes, mesmo quando a célula não tem classe histórica. Um novo título de anexo inicia outro contexto. Classes históricas próprias da célula também são preservadas. Notas editoriais não substituem a hierarquia por mencionarem uma cláusula. Ementa, epígrafe, preâmbulo reconhecido e citações em blocos de redação ficam em zona proibida; aspas abertas entre parágrafos são tratadas conservadoramente como redação citada. Texto não reconhecido permanece desconhecido.

O contexto DOM também é herdado: classe histórica em `div`, `table`, `tbody` ou `tr` protege os descendentes sem depender de uma classe na própria célula. `blockquote` e `q` tornam proibidas as partes descendentes, inclusive tabelas. Quando uma citação inline está misturada com texto próprio em um parágrafo ou célula, o leitor exclui conservadoramente o bloco/célula inteiro e registra `inline_quote_conservative_exclusion`, tornando a saída parcial. Não tenta recuperar uma seleção positiva da parcela fora das aspas. Histórico de uma linha não é propagado para uma linha irmã sem aquela marca.

No DOU, as classes oficiais `identifica`, `ementa`, `assina` e `cargo` do próprio bloco e os blocos de retificação "Onde se lê"/"Leia-se" são reconhecidos como posições em zona proibida (ver [dou-preparation.md](dou-preparation.md)). O XML do INLABS passa antes pela preparação versionada `prepareDouRepresentation`. Fora isso, os leitores DOU, DOE-SP e RFB usam apenas esses marcadores textuais inequívocos e a estrutura HTML genérica. Não simulam cobertura completa de articulação, XML multipart, segmentos da API RFB ou anexos. Quem prepara a entrada precisa declarar recursos ausentes. Os arquivos XML do corpus não devem ser passados como se fossem HTML de publicação; a preparação da representação e seu gold continuam uma etapa própria.

**Todas as partes saem com `legalStatus: unknown`.** `operative_candidate` descreve apenas a posição estrutural possível. Classe, ordem ou versão atual não aprovam vigência nem elegibilidade.

## Tabelas e domínio NCM

Tabelas mantêm árvore de tabela → linha → célula, inclusive tabelas aninhadas dentro de células. Cada célula tem linha, coluna, `rowSpan`, `columnSpan` e geometria. A ocupação por mesclagem determina a coluna das próximas linhas. Atributos inválidos ou colisões preservam a célula e geram geometria desconhecida/estado parcial; o leitor não inventa reconstrução.

`identifyNcmPartIds(result)` devolve células sob um cabeçalho explícito `NCM`, `CÓDIGO NCM` ou `NCM/SH`, com coluna única e geometria conhecida. Cabeçalhos genéricos `CÓDIGO`, `NBM`, `SH` e `TIPI` não abrem o domínio. Um cabeçalho de outro domínio encerra a associação NCM daquela coluna. Essa associação de coluna não valida códigos nem concede seleção; o extrator de entidades e a camada de evidência são independentes.

## Limites e cobertura

Limites fixos: 2 MiB de entrada UTF-8, profundidade 128, 50.000 nós e localizador de origem de até 4.096 caracteres. Excesso ou falha do parser preserva a representação original inteira como texto bruto não identificado; o estado fica parcial, sem truncamento silencioso. Não se considera HTML bruto um texto jurídico reconhecido.

`script`, `style`, `noscript`, `template`, `iframe` e `object` são excluídos do texto legível com limitação explícita. O cabeçalho `head` é metadado de apresentação e não integra o corpo. Imagem sem OCR, recurso ausente, geometria incerta, texto não reconhecido e ausência de corpo legível também tornam a saída parcial. O original permanece apontado como fonte; o leitor não executa conteúdo coletado.

A cobertura divide o texto canônico em segmentos exclusivos. Os intervalos de contêineres e descendentes não são somados duas vezes. Trechos sem dono estrutural ficam contabilizados como não identificados. `recognizedLength` não inclui esses trechos. Esses contadores não equivalem às métricas de precisão/recall do corpus, que continuam bloqueadas até congelamento e revisão independente do gold.

## Verificação

`test/anatomy.readers.unit.test.ts` verifica decodificação e origem UTF-16, hierarquia e zonas, propagação histórica a células e por ancestrais DOM, mesclagens e geometrias incertas, proteção de colunas não NCM, fallback das três fontes, citações no meio de prosa, redações entre aspas e inline, tabelas dentro de citações, anexos ausentes, conteúdo executável, limites e determinismo. Os resultados sintéticos completos são validados pelo contrato ANAT→TAX v1. Não há alegação de aceite das 30 publicações.
