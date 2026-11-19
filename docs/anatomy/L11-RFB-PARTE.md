# ANAT-L11 — tipo RFB `parte` como agrupamento estrutural

**Decisão:** aprovada pelo Fábio (tribusca-control#116, c.6647638485). Escopo R2: implementação e testes; sem merge, deploy, flags ou promoção.

## O que muda
- Quando o **próprio documento RFB** declara, na tabela `tiposSegmento`, a sigla `parte` para um segmento, e a gramática do texto deixou esse bloco não identificado, o leitor o reconhece como `group` de nível `part` (motivo `rfb_declared_group_part`).
- Nível: acima de Livro (a tabela da IN 2.121 declara `hierarquiaTipoSegmento` parte 0 < livro 1 < título 2 < capítulo 3 < seção 4; LC 95/98, art. 10, VIII). Rank 2,05, entre anexo (2) e livro (2,1).
- A gramática de texto livre **não** reconhece "PARTE": sem tipo declarado, o bloco continua não identificado.
- Mudança só em `readers.ts` (mapa de tipos RFB + nível `PARTE`). A preparação (`rfb-api-original/0.2.0`) não muda.

## O que não muda (testes negativos em `test/anatomy.rfb-parte.unit.test.ts`)
- Tipo 999 ("não identificado" pela fonte): continua não identificado, com limitação.
- Tipo ausente, desconhecido na tabela do documento ou em conflito na tabela: limitação, sem adivinhação.
- Conflito com a gramática (ex.: texto de artigo declarado como parte): mantém a gramática e registra conflito.
- Tachado: contexto `historical` com `rfb_tachado_source`. Citação: continua `prohibited`. `legalStatus` sempre `unknown`.
- Outras fontes (DOU, SP): atributos `data-rfb-*` ignorados.

## Identidade do motor
`5a432043…` → `525e9466…` (`build-identity.mjs --write`; guarda do teste de integração atualizada). Snapshot sintético: sem alteração.

## Antes × depois (lote oficial RFB, `docs/anatomy/official-lot-rfb.json`)
**Correção R1-L11-DOC-01 (revisão COORD c.6648168530):** os **cinco** `outputHash` mudam, porque o `outputHash` inclui a identidade do motor (`5a432043` → `525e9466`). A mudança **estrutural** fica só na IN 2.121/2022 (127905). Provas, separadas do `outputHash`:

1. **Baseline do lote, sem o `outputHash`** (`57df900f` × `be36d7f4`): nas INs 108391, 115131, 133898 e 141910, **nenhum campo** difere (status, caracteres, não identificados, tipos de parte, limitações, históricos, anexos, preparação). Na 127905 diferem só `unidentifiedChars`, `partTypes` e `limitations`.
2. **Saída completa do leitor** (`readAnatomyInput`, que não contém identidade: texto canônico, partes, mapa de origem, cobertura e limitações), com SHA-256 do JSON calculado nos dois commits:

| idAto | `outputHash` antes → depois | Leitor em `57df900f` | Leitor em `be36d7f4` |
|---|---|---|---|
| 108391 | `601d3d00` → `9ec36c91` | `d0b30141a3810736` | `d0b30141a3810736` (igual) |
| 115131 | `c54e3819` → `c208bdc5` | `4da42f18b9b531a0` | `4da42f18b9b531a0` (igual) |
| 127905 | `2bace097` → `18044fb9` | `86fd6219a68e16f8` | `7ebad3a81e549479` (**muda**) |
| 133898 | `44c02e21` → `65e6400e` | `061fa137291fb2bd` | `061fa137291fb2bd` (igual) |
| 141910 | `57bd0ca8` → `1ef5296c` | `5126448b1f8f30b7` | `5126448b1f8f30b7` (igual) |

| IN 2.121 | Antes | Depois |
|---|---|---|
| group | 647 | 652 |
| unidentified (partes) | 6 | 1 |
| caracteres não identificados | 437 | 14 |
| `rfb_segment_type_unmapped` | 5 | 0 |
| `rfb_segment_type_unidentified_by_source` | 1 | 1 |
| status | partial | partial |

Hierarquia verificada: PARTE I → LIVRO I → TÍTULO I → Art. 6º.

## Limitações
- **PARTE VI** ("DISPOSIÇÕES GERAIS E FINAIS", segmento 4410) fica dentro de uma citação aberta antes dele e permanece `quoted_text`/`prohibited`. A precedência de citação não foi flexibilizada; a citação aberta é um achado a investigar à parte.
- Os 14 caracteres restantes são o segmento 433 ("Novo segmento"), declarado tipo 999 pela fonte.
- Lote baseado no #289 (`57df900f`), ainda pendente de recheck.
