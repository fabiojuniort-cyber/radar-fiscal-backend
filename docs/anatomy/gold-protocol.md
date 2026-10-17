# ANAT-04 — protocolo de anotação do gold

Origem: COORD → EXEC, ANAT-04, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244. Preparado em 17/10/2026.

**Este documento é um roteiro. Anotação preparada não é gold revisado nem homologação jurídica.** Todos os registros do manifesto continuam com `gold.status: missing`.

## 1. Texto canônico de referência

Os spans do gold precisam se referir ao mesmo `canonicalText` que o contrato ANAT→TAX v1 valida. Por isso o texto de referência é congelado **antes** da anotação:

1. A **preparação** é versionada por fonte (veja [official-structure.md](official-structure.md)):
   - CONFAZ: HTML sanitizado inalterado;
   - DOU: CDATA de `<Texto>`, com os vários arquivos unidos em uma única representação;
   - DOE-SP / RFB: definidas depois da recuperação.
2. O texto canônico é a saída textual do leitor sobre a representação preparada. O protocolo congela **somente o texto**: o SHA-256 dos bytes UTF-8 e o comprimento em UTF-16.
3. O anotador recebe apenas o texto canônico e a representação original. **Não recebe a árvore de partes, as entidades nem a elegibilidade do motor**, para não copiar a saída do motor como gabarito.
4. Mudar a preparação ou a extração de texto invalida o gold daquela entrada. A reancoragem é manual e precisa ser revisada; nunca é aplicada às cegas.

Os hashes provisórios das entradas de desenvolvimento disponíveis estão na tabela abaixo. Eles valem para a preparação provisória e só são congelados quando a preparação DOU estiver versionada.

| ID | Recurso | UTF-16 | SHA-256 do texto canônico (provisório) |
|---|---|---|---|
| 01 | CV052_91.sanitized.html | 194.470 | `465186b95fbd52e3d771257d80105c0408e77b61f7192860802907334ddfbeb8` |
| 02 | CV100_97.sanitized.html | 30.591 | `e8625c2705b652eaeec2551bf9fc9ab1aa6ed70047b159c687ca6aa1aa33e561` |
| 03 | 515_20260918_24377394.xml | 432 | `23794899b0461b3db2eed683daccbc968f918ff765e45845717a12d9496a18f1` |
| 05 | 515_20260918_24382400.xml | 1.098 | `e88748b6c9fd9a1168f01f8ce2b1388a10a07cb2434c03d21869bc324707a875` |
| 07 | 600_20260918_24382325.xml | 1.221 | `3b8925ea88e05cd8fdf61e135d44790e76943f9ae74fdd641b340740f7925394` |
| 10 | 602_…_24378456-1/-2/-3.xml | 11.628 / 7.247 / 4.368 | por arquivo; substituir pela representação única |
| 11 | 602_20260918_24380292.xml | 17.020 | `6e2faced42d1354bad8ca7adb369c8e489c0fd61d2e8459949918d8e7f679b1f` |

## 2. O que anotar, por entrada

Todos os intervalos são `[início, fim)` em unidades UTF-16, como `String.slice`. Nunca dividir um par substituto. Nenhuma normalização (NFC, acentos, espaços).

1. **Partes:** tipo (document, epigraph, summary, preamble, clause, article, paragraph, inciso, alinea, annex, table, row, cell, editorial_note, quoted_text, signature, unidentified), pai, ordem contígua entre irmãos e span.
2. **Tabelas:** linha, coluna, `rowSpan`, `columnSpan`, geometria (`original`, `uniquely_reconstructed` ou `unknown`) e cabeçalho de coluna, com o domínio do cabeçalho (NCM, CEST, SUS, CBO etc.).
3. **Contexto:** `operative_candidate`, `historical`, `prohibited` ou `unknown`, com motivo. O contexto vem da marcação textual ou estrutural, nunca da cor.
4. **Entidades:** literal exato, span e domínio (NCM, citação de ato, processo, data, CNPJ, CEP, código SUS/CBO/CID…), com os zeros iniciais preservados. NCM de 2 dígitos é só informativo.
5. **Faixas (M01) e exceções (M02):** operador, membros, alvo, escopo e condição. Os membros não são seleções positivas independentes.
6. **Exclusões e histórico:** ocorrências em redação anterior, citação, ementa ou nota ficam registradas com o contexto delas, não omitidas.
7. **Cobertura parcial:** anexo ausente, PDF não lido e trecho sem estrutura confiável são anotados como `unidentified` ou recurso ausente. "Não identificado" é diferente de acerto.
8. **Situação jurídica:** sempre `unknown` no gold estrutural. Vigência é uma camada separada, de evidência, e não faz parte deste gold.

Formato sugerido para cada arquivo: `test/fixtures/anatomy/gold/<id>.json`, com:
- `canonicalTextSha256`, `preparationVersion`, `annotator`, `annotatedAt`;
- `parts[]`, `entities[]`, `ranges[]`, `exceptions[]`, `gaps[]`;
- `review: { reviewer, status, notes }`.

O schema do gold deve ser validado do mesmo jeito que o contrato: forma estrita mais invariantes (partição, pais, ordem).

## 3. Particularidades conhecidas das entradas de desenvolvimento

- **01 (52/91):** 6 anexos com tabelas grandes, 4.682 células. Anotar o cabeçalho de cada coluna e propagar o histórico do título do anexo. As classes `Tabela*verde` não indicam situação jurídica.
- **02 (100/97):** citações do Conv. 99/04, Conv. 26/21 e Ato COTEPE 17/97. Os percentuais 60%, 30% e 4% aparecem em contextos distintos. Notas não geram tag.
- **03 (retificação MDHC):** os trechos "onde se lê" e "leia-se" ficam separados e ligados à Portaria 340/2026. O processo `2003.01.26732` não é NCM.
- **05 / 07:** anotar identificação, ementa, assinatura e cargo pelas classes oficiais, mesmo que o leitor atual não as reconheça.
- **10 (Portaria SAES/MS 4.940):** é uma única matéria em três arquivos, com cinco tabelas. Os códigos SUS, CBO e CID não são NCM (`09.09.01.005-6`, `2251-09`, `0009`). A vigência do art. 8º é efeito operacional, não situação jurídica.
- **11 (IN RFB 2.342):** IN que altera outra. Cada redação citada entre aspas, até `" (NR)`, é zona proibida. Conferir manualmente o fechamento das 25 marcas `(NR)`.

## 4. Revisão e reserva

1. O EXEC anota as entradas de desenvolvimento. Em seguida, o **GPT Astra** revisa de forma independente, conferindo spans, pais, ordem, domínios e lacunas, e registra divergências e resolução.
2. **Reservadas (04, 06, 08, 09, 12, 14, 16, 18, 24, 28):** a anotação segue um protocolo separado, feito por um anotador que **não** ajusta regras, e o resultado não é exposto ao EXEC. O EXEC conhece apenas id, hash e o status `annotated/reviewed`.
3. **Congelamento:** gold, regras, preparação e partição recebem hash juntos antes da medição. A reserva só é executada depois do congelamento aprovado pelo COORD, e seu resultado não realimenta as regras daquela versão.

## 5. Estado

| Partição | Disponíveis | Gold preparado | Gold revisado |
|---|---|---|---|
| Desenvolvimento (20) | 7 (01, 02, 03, 05, 07, 10, 11) | 0 (roteiro e hashes de texto provisórios) | 0 |
| Reserva (10) | 5 (04, 06, 08, 09, 12) | 0 | 0 |
| Ausentes | 18 (13–30) | — | — |

O `BLOCK_CORPUS_INPUTS_AND_GOLD` continua de pé.
