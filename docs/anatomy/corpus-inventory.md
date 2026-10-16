# ANAT-04 — inventário e congelamento parcial do corpus

Origem: CLAUDE-COORD → GPT-EXEC. Registro documental em 16/10/2026, frente R2, coordenação na [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116). Este inventário prepara o corpus; não registra execução do motor, métricas ou aceite.

O [manifesto verificável](../../test/fixtures/anatomy/corpus-manifest.json) conserva as 30 identificações dos §§7.2–7.5 do desenho. **12/30 publicações têm entradas disponíveis e congeladas em 14 arquivos; 18/30 continuam sem os corpos oficiais originais. Nenhuma das 30 tem gold completo por spans UTF-16 revisado.** Não houve coleta, consulta ao banco ou uso do Railway nesta preparação.

## Entradas disponíveis

| IDs | Fonte | Entradas congeladas | Evidência |
|---|---|---|---|
| 01–02 | CONFAZ | Dois HTMLs sanitizados | SHA-256 conferido nos arquivos e igual ao resultado de SELECT fornecido anteriormente pelo Fábio |
| 03–09, 11–12 | DOU | Nove XMLs | Bytes e SHA-256 iguais ao manifesto DOU do snapshot backend `fb880354fbbbc90f681290e57dc905bde9ce9c08` |
| 10 | DOU | Três XMLs de uma única matéria | Mesma conferência; as três continuações não contam como três publicações |

Os arquivos em [inputs](../../test/fixtures/anatomy/inputs/) são cópias byte a byte, sem normalização de texto, redação ou alteração de quebras de linha. Cada entrada do manifesto informa caminho relativo, tamanho, SHA-256 e ponteiro de origem. As cópias e a conferência de hashes não executaram regras de anatomia.

Os HTMLs CONFAZ vieram das reproduções sanitizadas já existentes na frente ANAT-02. Hashes conferidos:

- 52/91: `bd035220215bf691ce6dd1c6f8c9d8b8e8c3180f9df43f97f0debd3a3ac1dd83`.
- 100/97: `fe90af8fb89645b2bf40e8e3f8f6cd2cb4c6c15ef044ce58f1683482de5999f7`.

A [prova Dashboard](https://github.com/fabiojuniort-cyber/tribusca-control/blob/c83f3c69958827ef69ecef9b54417693a6bd398d/docs/anat/anat-02-dashboard-resultado.json) comprova igualdade do HTML de apresentação persistido. Não comprova igualdade de `content_text`, seu hash, visibilidade de versões ou vigência jurídica. O texto canônico e seus spans precisam ser explicitamente definidos para a representação consumida pelo contrato; não se deve preencher silenciosamente a lacuna com um campo produtivo presumido.

## Entradas ausentes e variantes insuficientes

Os dez JSONs DOE-SP, IDs 13–22, e os oito JSONs RFB, IDs 23–30, lidos na elaboração do desenho não foram encontrados como corpos completos no workspace. O manifesto preserva os hashes esperados documentados no §7.3, marcando `actualSha256: null`, `availability: missing` e `inputs: []`. Um hash mencionado em documento não é um arquivo disponível nem prova de congelamento.

A fixture [doe-sp.fixtures.ts](../../test/doe-sp.fixtures.ts) contém variantes preexistentes, que não foram promovidas ao corpus original:

| ID | Estado da variante local |
|---|---|
| 13 | Decreto 70.843 truncado: artigos 1º e 7º presentes; artigos 2º–6º ausentes |
| 20 | Corpo derivado da Portaria SRE 43; não corresponde aos bytes JSON oficiais documentados |
| 21 | Corpo derivado do Comunicado Dicar 59; anexo PDF apenas referenciado |
| 22 | Retificação com redação de dados pessoais e tabela simplificada |
| 14–19 | Identificadores/metadados/excertos; não são corpos completos |

Os PDFs mínimos da fixture são sintéticos. Nenhuma variante recebeu o hash do JSON oficial, e não foram copiados dados pessoais para este relatório.

## Gold e reserva final

As [30 fichas ANAT-02](https://github.com/fabiojuniort-cyber/tribusca-control/blob/c83f3c69958827ef69ecef9b54417693a6bd398d/docs/anat/anat-02-fichas.md) são expectativas. A anotação ANAT-02 dos convênios contém literais, hierarquia proposta, XPath, tabelas e células do HTML **original**. Não fornece todos os spans UTF-16 das entradas sanitizadas congeladas. Não foi declarada como gold homologado nem convertida automaticamente em gabarito.

Continuam reservados os IDs **04, 06, 08, 09, 12, 14, 16, 18, 24 e 28**. Para as entradas reservadas disponíveis, houve apenas cópia e hash; nenhum resultado do motor foi produzido. A reserva não autoriza ajuste de regras após conhecer os resultados finais.

Antes de medir, cada publicação precisa de anotação completa por ocorrência e por parte, com ordem, pai, tipo, tabela/célula, domínio, exclusão, lacunas e intervalos `[início, fim)` em unidades UTF-16. A anotação precisa de revisão independente pelo GPT Astra. `Não identificado` deve permanecer distinguível de acerto. Todos os registros do manifesto estão com `gold.status: missing` e avaliação não executada.

## BLOCK restrito e recuperação

**`BLOCK_CORPUS_INPUTS_AND_GOLD`: não aferir nem anunciar os gates das 30 publicações enquanto faltarem os 18 corpos e o gold revisado.** O contrato verificável pode ser entregue independentemente; este inventário não libera a etapa de medição nem o uso jurídico do dossiê ANAT-03.

Passos de recuperação, sem coleta nova neste pacote:

1. Recuperar os arquivos originais já capturados, por cópia de um armazenamento existente, para os IDs 13–30. O manifesto identifica URL oficial e SHA-256 esperado do §7.3 para cada um.
2. Conferir os bytes recuperados contra o hash documentado. Se divergir, conservar a divergência e sua proveniência; não substituir a entrada silenciosamente nem afirmar que se trata da mesma captura. Uma nova obtenção de fonte fica dependente de autorização específica, respeitando a proibição atual de coleta.
3. Preservar e revisar a redação de dados pessoais dos atos de pessoal em uma representação própria, com hash distinto e transformação documentada. Não publicar dados pessoais em relatórios de teste nem confundir hash derivado com oficial.
4. Definir o texto canônico e a conversão de offsets, anotar integralmente os 30 atos e obter a revisão independente do GPT Astra.
5. Congelar gold, regras e partição antes da aferição. Executar a reserva final sem usar seus resultados para ajustar regras; eventual nova versão requer protocolo explícito de avaliação.

O manifesto não concede elegibilidade a qualquer trecho. A aplicação do dossiê continua no ANAT-06; testes de elegibilidade do ANAT-04 usam somente evidência aprovada em fixtures controladas.
