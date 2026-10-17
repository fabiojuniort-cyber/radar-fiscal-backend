# ANAT-04-DOU-01 — preparação versionada do DOU e congelamento do texto canônico

Origem: COORD → EXEC, autorização ANAT-04-DOU-01, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Feito em 17/10/2026.

Aqui tudo é offline: sem acesso a fontes, banco ou Railway e sem alteração de taxonomia ou classificação. As entradas reservadas não são abertas.

## Preparação `dou-xml-cdata/1.0.0`

O módulo é `src/modules/anatomy/dou-preparation.ts`, e a função principal é `prepareDouRepresentation(resources)`.

**Entrada e saída:** recebe os bytes de um ou mais XML do INLABS de uma mesma matéria e devolve um único HTML para `readAnatomyInput({ source: 'DOU' })`.

**Decodificação:**
- UTF-8 estrito; byte inválido gera `invalid_utf8`;
- o BOM é removido e registrado em `bomPresent`;
- todos os offsets estão em UTF-16 sobre o XML já decodificado.

**Corpo:**
- o CDATA de `<Texto>` é copiado **sem alteração**;
- exige exatamente um bloco `<Texto>` e um `<article>`, e falha de modo fechado em qualquer ambiguidade.

**Proveniência sem duplicar conteúdo.** Cada recurso registra:
- `resourceId`, SHA-256 e tamanho dos bytes;
- `name` e `partNumber`;
- `numberPage` e `pdfPage`;
- `cdataSpan`, o intervalo no XML;
- `htmlSpan`, o intervalo no HTML preparado.

`locateDouHtmlSpan` converte um intervalo do HTML preparado de volta para o XML de origem.

**Metadados excluídos do texto.** São registrados somente por hash e comprimento, sem copiar o valor:
- `artNotes`: nota interna de diagramação, com motivo `internal_layout_note`;
- `Identifica`, `Data`, `Ementa`, `Titulo` e `SubTitulo`: duplicados do corpo, com motivo `metadata_duplicate`.

Os atributos não textuais (`artType`, `artCategory`, `pubName`, `pubDate`, `editionNumber`) ficam em `metadata`.

**Matéria em vários arquivos:**
- todos os arquivos precisam ter o mesmo `idMateria`, senão gera `id_materia_mismatch`;
- todo `name` precisa terminar em `_NNN`, senão gera `part_number_missing`;
- a sequência precisa ser contígua a partir de `_001`, senão gera `part_sequence_gap`;
- a ordem dos arquivos na entrada não altera o resultado;
- cada parte é envolvida por um `<div data-dou-part>` neutro, que não acrescenta caracteres e impede que o texto de arquivos diferentes se funda.

**Identidade:** `htmlSha256` é o hash do HTML preparado. `preparationId` é o hash da versão, do `idMateria`, dos hashes dos recursos e do `htmlSha256`.

## Perfil DOU no leitor

Classes oficiais aplicadas ao próprio bloco. Todas indicam **posição**, nunca situação jurídica, e ficam em zona proibida com `legalStatus: unknown`:

| Marcação | Parte | Motivo |
|---|---|---|
| `p.identifica` | `epigraph` | `dou_identifica` |
| `p.ementa` | `summary` | `dou_ementa` |
| `p.assina` | `signature` | `dou_assina` |
| `p.cargo` | `signature` | `dou_cargo` |
| bloco iniciado por "Onde se lê" | `quoted_text` | `dou_rectification_original` |
| bloco iniciado por "Leia-se" | `quoted_text` | `dou_rectification_corrected` |

Nas retificações, tanto o trecho original quanto o corrigido citam outro ato, então nenhum deles alimenta seleção positiva. A expressão "onde se lê" no meio de um parágrafo não abre bloco de retificação. As regras valem só para `source: 'DOU'`; o CONFAZ continua com o perfil próprio. A classe `anexo` já era coberta pelo marcador `ANEXO …`.

## Texto canônico congelado: somente desenvolvimento

O arquivo é `test/fixtures/anatomy/canonical/development.json` e é gerado por `node node_modules/tsx/dist/cli.mjs ops/anatomy/dev-canonical.ts --write`. Sem `--write`, o script só verifica. O teste `test/anatomy.dev-canonical.unit.test.ts` falha se a preparação ou o leitor mudarem o texto.

O arquivo guarda apenas hash e comprimento, nunca o texto. Entradas `reserved-final` são puladas antes de qualquer leitura.

| ID | Preparação | UTF-16 | SHA-256 do texto canônico |
|---|---|---|---|
| 01 | `confaz-sanitized-html/1.0.0` | 194.470 | `465186b95fbd52e3d771257d80105c0408e77b61f7192860802907334ddfbeb8` |
| 02 | `confaz-sanitized-html/1.0.0` | 30.591 | `e8625c2705b652eaeec2551bf9fc9ab1aa6ed70047b159c687ca6aa1aa33e561` |
| 03 | `dou-xml-cdata/1.0.0` | 433 | `c9af5e182931961d75e6ae1cc1b4dab158e82b0bbbdc2428ee69a31d800b9d41` |
| 05 | `dou-xml-cdata/1.0.0` | 1.099 | `7dc6c74fc357f2ff303cf84fcc8f31b003969795235e871ee2d27f24266b9276` |
| 07 | `dou-xml-cdata/1.0.0` | 1.222 | `6f9fd606a8ec136ff6ce14edb3353608b5ccfe2accc861c0580967d7a1bf48e2` |
| 10 | `dou-xml-cdata/1.0.0` (3 arquivos → 1) | 23.246 | `525a7604c9344e6b1ee7895c3ca382e1a184492e1bffa97be23f75e35a3f94b1` |
| 11 | `dou-xml-cdata/1.0.0` | 17.021 | `f34ce3ce4ede15770ba1420763f80c3a83e76d252f6326b19920fde4a65a17ef` |

Estes hashes **substituem** os provisórios do DOU listados antes em [gold-protocol.md](gold-protocol.md). Os do CONFAZ não mudaram.

## Pacote de anotação

**Schema do gold:** `src/modules/anatomy/gold.ts` (`ANAT-GOLD/1.0.0`). A validação é estrita, e `validateAnatomyGold(gold, canonicalText)` verifica:
- hash e comprimento do texto;
- uma única raiz `document`;
- pai antes do filho e filho dentro do pai;
- ordem contígua e sem sobreposição entre irmãos;
- células com geometria;
- nenhum par substituto dividido;
- literal de cada entidade igual a `text.slice(span)`;
- relações apontando para entidades existentes;
- `reviewed` só com revisão aprovada por outra pessoa que não o anotador.

O schema aceita somente a partição `development`.

**Esqueletos:** `test/fixtures/anatomy/gold/{01,02,03,05,07,10,11}.json`, todos com `status: not_started`. Foram gerados por `ops/anatomy/annotation-pack.ts --skeletons`, que nunca sobrescreve um arquivo existente.

**Texto para o anotador:** `ops/anatomy/annotation-pack.ts --out <dir>` exporta `<id>.canonical.txt` **fora do repositório**. O pacote contém só o texto canônico, sem partes, entidades ou elegibilidade do motor.

**Revisão:** depois da anotação (`status: prepared`), o GPT Astra revisa de forma independente. Só depois dessa revisão o gold pode ser marcado `reviewed`. A reserva segue o protocolo separado descrito em [gold-protocol.md](gold-protocol.md#4-revisão-e-reserva).

## Estado

| Item | Situação |
|---|---|
| Preparação DOU versionada | Entregue |
| Perfil DOU (classes oficiais, retificação) | Entregue |
| Consolidação multiarquivo (ID 10) | Entregue |
| Texto canônico de 7 entradas de desenvolvimento | Congelado |
| Gold anotado / revisado | 0 / 0 (esqueletos e ferramentas prontos) |
| Reserva | Não aberta |
| 18 originais DOE-SP/RFB | Ausentes; recaptura aguarda autorização do Fábio |

`BLOCK_CORPUS_INPUTS_AND_GOLD` continua de pé. Anotação preparada não é gold revisado nem homologação jurídica.
