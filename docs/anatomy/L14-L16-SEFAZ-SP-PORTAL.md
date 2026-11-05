# ANAT-L14, L15 e L16 — portal de legislação consolidada da Sefaz-SP

**Decisões:** aprovadas pelo Fábio (tribusca-control#116, c.6647638485). Escopo R2: implementação e testes; sem merge, deploy, flags ou promoção.

## Fonte: portal Sefaz-SP ≠ DOE-SP
`legislacao.fazenda.sp.gov.br` é o **portal de legislação consolidada** (SharePoint), mantido pela Sefaz-SP, com notas e redações anteriores inseridas pelo próprio portal. O **DOE-SP** é o Diário Oficial (publicação original). A preparação registra `source: 'SEFAZ-SP-PORTAL'` e `sourceKind: 'consolidated_legislation_portal'` e recusa qualquer outro host (`not_portal_host`), inclusive o do DOE-SP. Nenhum identificador do DOE-SP é reaproveitado.

**Limite de contrato (não alterado):** o motor só aceita as fontes CONFAZ, DOU, DOE-SP e RFB. O HTML preparado é lido com as regras DOE-SP (`readerSource: 'DOE-SP'`). Criar uma fonte própria no contrato do motor e no banco seria mudança de contrato e **depende de decisão** (ver "Pendências").

## L14 — preparador (`src/modules/anatomy/sefaz-sp-preparation.ts`, `sefaz-sp-portal/0.1.0-provisional`)
- Seleciona **um único** `.ms-rtestate-field` dentro de **um único** `#areaComentario`, rotulado por `aria-labelledby` com o texto exato "Conteúdo da Página".
- Copia o HTML interno **sem alteração** para um invólucro neutro `<div data-sefaz-sp-portal="legislacao-consolidada">`. Registra `rawSpan`, `htmlSpan`, SHA-256 da região, da página bruta e do HTML preparado, além da URL. O snapshot bruto e o `.meta.json` do #279 não mudam.
- Falha controlada: host errado, região ausente, duplicada, sem o rótulo, fora de `#areaComentario`, sem fechamento explícito ou vazia.

## L15 — notas editoriais
Dentro do invólucro, `p.nota` → `editorial_note`, contexto `prohibited`, motivo `sefaz_sp_portal_nota`. Um bloco sem a classe que começa com "NOTA - V." → mesmo tipo, motivo `sefaz_sp_portal_nota_text`. O texto e os links ficam no texto canônico. `editorial_note` já é tipo proibido de seleção no contrato.

## L16 — redações anteriores
Dentro do invólucro, `p.revogado` (e `sefazElement-TextoRevogado`, a mesma marcação vista no Anexo II, art. 39) em um dispositivo reconhecido → contexto `historical`, motivo `sefaz_sp_portal_revogado`. **`legalStatus` continua `unknown`**: não se afirma revogação nem vigência. Precedências mantidas: citação/`blockquote` continua `prohibited`; bloco não identificado com a classe continua `unknown` (limitação `sefaz_sp_revogado_unidentified`). Fora do invólucro (HTML do DOE-SP diário) as classes não têm efeito.

## Identidade do motor
`5a432043…` → `dba9fc5e…` (`readers.ts` + novo preparador incluído na lista da identidade). Snapshot sintético inalterado. Lote RFB não é afetado (as mudanças só valem para DOE-SP com o invólucro).

## Antes × depois (amostras #279, `promoted:false`)
| | art. 7º antes | art. 7º depois | An. II art. 39 antes | An. II art. 39 depois |
|---|---|---|---|---|
| caracteres | 44.359 | 11.628 | 45.433 | 12.616 |
| não identificado (caracteres) | 20.065 | 103 | 18.519 | 68 |
| notas editoriais | 0 | 12 | 0 | 3 |
| partes `historical` (portal) | 0 | 1 | 0 | 14 |
| status | partial | partial | partial | partial |

Anexo II, art. 39, inciso II: a redação corrente fica `operative_candidate` e as duas anteriores ficam `historical`.

## Limitações
- 21 `p.revogado` no art. 39, mas só 14 viram `historical`: os demais estão em `blockquote` (alíneas) e continuam `prohibited` pela regra de citação, que não foi flexibilizada. O portal usa `blockquote` para recuo; tratar isso é outra decisão.
- Restos não identificados: blocos com caractere invisível U+200B (ex.: "​XV -", "§ 6º") e uma nota "NOTA - V." precedida desse caractere. Nada foi adivinhado.
- `promoted:false`, `urlStatus:candidate`, `verified:false` inalterados.

## Pendências (decisão do Fábio)
- Fonte própria `SEFAZ-SP-PORTAL` no contrato do motor/banco (hoje lida com regras DOE-SP).
- `blockquote` como recuo no portal (hoje = citação).
