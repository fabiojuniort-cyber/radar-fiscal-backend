# ANAT-D04 — tipos de segmento declarados pela RFB (P1, P1b, P2, P3)

Aprovado expressamente pelo Fábio (via COORD, tribusca-control#116). PR próprio, branch `claude/anat-d04-rfb-types`.

**Dependências explícitas:** base é a integração #285 @ `2c41fbab` (#280, #281, #283, #284, #279 @ `c6eade59` e #282), mais o merge do #279 @ `e724e956` (ANAT-D03, aprovado @ `103639d8`). **O #285 não é alterado.**

## Mudança
- **Preparação** (`prepareRfbRepresentation`, versão `rfb-api-original/0.2.0-provisional`):
  - cada segmento recebe `data-rfb-type`, com a sigla resolvida pela tabela **`tiposSegmento` do próprio documento** (nenhum número é presumido universal), e `data-rfb-tachado="true"` quando for o caso;
  - tipo ausente, desconhecido na tabela ou com conflito na tabela gera `data-rfb-type-issue` e é registrado em `segmentTypes`;
  - nenhum caractere de texto é inserido ou alterado; a ordem continua dada por `ordemSegmentoAto`.
- **Leitor** (`readers.ts`), **só para a fonte RFB** (atributos `data-rfb-*` de outras fontes são ignorados):
  - a gramática de texto continua tendo prioridade;
  - o tipo declarado só preenche bloco que a gramática deixou `unidentified`: artigo, parágrafo, inciso, alínea, item, capítulo, seção, subseção, título e livro viram `group` com nível; ementa vira `summary` e fecho vira `signature`;
  - tipo declarado em conflito com a gramática gera `rfb_segment_type_conflict`, e o resultado da gramática é mantido;
  - geram limitação explícita, sem nenhuma adivinhação: tipo ausente, desconhecido ou em conflito na tabela, sigla sem mapeamento e o tipo `nao identificado` declarado **pela própria fonte**;
  - **tachado** passa o contexto `operative_candidate` para `historical`, com o motivo `rfb_tachado_source`, e os filhos herdam. **`legalStatus` continua `unknown`:** nenhuma vigência, revogação ou efeito é inferido.
- **Vínculo:** a recusa de amostra com tachado (D03-R1-01) continua igual. As 4 INs seguem `promoted:false`.

## Antes e depois nas 4 INs (mesmos bytes, mesmo texto)
| IN | Não identificado antes (ramo D03) | Depois | Reconhecidos a mais | Partes `historical` por tachado | Limitações D04 | Status do leitor |
|---|---|---|---|---|---|---|
| 2.237/2024 | 12.271 | **11.279** | 15 agrupamentos, 2 itens, ementa, assinatura | 10 | 85 × `rfb_segment_type_unidentified_by_source` | partial |
| 2.005/2021 | 1.015 | 0 | 22 agrupamentos, ementa, assinatura | 342 | — | complete |
| 2.162/2023 | 511 | 0 | ementa, assinatura | 19 | — | complete |
| 1.932/2020 | 325 | 0 | ementa, assinatura | 0 | — | complete |

- **P1 não resolve os incisos da IN 2.237:** os 85 incisos sem travessão estão declarados **pelo próprio portal** com o tipo 999 (`nao identificado`). Pela regra aprovada (não adivinhar), continuam `unidentified`, agora com uma limitação explícita por bloco. Resolver isso exigiria inferir pelo texto, o que fica fora do escopo aprovado.
- **"complete" é o status do leitor** (sem limitações abertas). **Não** é prova de completude estrutural nem jurídica: anexos referenciados continuam sem conteúdo, e a visão multivigente continua sendo a representação do portal.

## Identidade do motor
`512073f7` (#285/#284) → **`e7afa9f0`**, com a guarda da base-migration atualizada. Snapshots sintéticos (`synthetic-equivalence`, B2) **sem delta**: nenhuma amostra sintética é RFB com tipos.
