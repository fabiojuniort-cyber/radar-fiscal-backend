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

## R1 (revisão do COORD no HEAD `adec6abc`)
- **D04-R1-01, corrigido:** tabela dentro de segmento tachado não recebia o contexto histórico, porque o caminho de tabela era tratado antes do estado RFB. Agora o estado do segmento é lido antes, e a tabela entra como zona `historical` (conteúdo `prohibited` continua `prohibited`). Tabela, linhas e células recebem `rfb_tachado_source`. As células passam a ter a exclusão `context_historical` na elegibilidade; a mesma tabela não tachada continua operativa; a fonte DOU com os mesmos atributos não é afetada.
  - **Antes/depois:** os 2 testes novos falham antes da correção e passam depois. O caso é isolado: artigo vigente com tabela tachada, para não haver herança de um pai tachado.
- **D04-R1-02, NÃO aplicado: depende do contrato.** O contrato da anatomia (`contract.ts`, regra "Unidentified part cannot assert operative context") exige `context: unknown` para toda parte `unidentified`. Com `historical`, o motor **rejeita a análise inteira** (reproduzido). Por isso, um bloco tachado de tipo não identificado mantém `unidentified`/`unknown` e carrega a evidência como motivo `rfb_tachado_source` (comportamento coberto por teste, e o motor aceita). Dar contexto `historical` a esses blocos exige mudar o contrato e fica para decisão.
- **Identidade:** `e7afa9f0` → **`ae26c438`**. Snapshots sintéticos sem delta. As 4 INs ficam sem mudança numérica (não têm tabela tachada).

## ANAT-D05 — contrato: `unidentified` + `historical` com evidência (aprovado pelo Fábio)
- **Contrato** (`contract.ts`): uma parte `unidentified` só pode ter contexto diferente de `unknown` quando:
  - o contexto é `historical`;
  - **e** tem o motivo `rfb_tachado_source`;
  - **e** existe o registro `rfb_tachado_evidence` com o **mesmo `partId` e o mesmo span**.

  Ficam recusados: motivo sem evidência, evidência de outra parte ou de outro span, evidência sem motivo, `operative_candidate` (mesmo com evidência) e `prohibited`. `legalStatus` não muda.
- **Leitor:** o bloco tachado não identificado mantém o tipo `unidentified` (sem adivinhação), passa a `historical` e grava o registro de evidência, que só é criado a partir do atributo de tachado da fonte RFB. Citação continua `prohibited`. Blocos não tachados e outras fontes continuam `unknown`.
- **Consumidor** (`config/view.ts`): a parte `unidentified` com tachado evidenciado aparece como "Histórico". Os novos motivos e limitações RFB têm rótulos em português.
- **4 INs, pelo motor completo:** todas aceitas.
  - IN 2.237: 4 dos 85 blocos não identificados são tachados e passam a `historical` com evidência; os outros 81 continuam `unknown`.
  - As demais não mudam.
- **Identidade:** `ae26c438` → **`5a432043`**. Snapshots sintéticos sem delta.
