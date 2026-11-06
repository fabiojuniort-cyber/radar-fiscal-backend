# ANAT-L2/L12 — anexo HTML embutido no JSON RFB, lido como recurso separado

**Decisão:** autorizada pelo Fábio (tribusca-control#116 c.6673604188). Desenho: #293 §13.2/§14.2. **Base:** #298 @ `47d166b4` (lote de 7 INs). Branch própria, isolada da COMPOSE-02 (#299).

## O que faz (`src/modules/anatomy/rfb-inline-attachments.ts`, `rfb-inline-attachment/0.1.0-provisional`)
- Para cada `arquivoBinario` de um ato RFB, lê o conteúdo embutido (`/…/arquivoBinario/arquivoBinario`, base64) como um **recurso separado**: `resourceId = rfb:<idAto>:anexo:<idArquivoBinario>`, numa passada própria do leitor.
- **Preparação principal intocada:** `json-preparation.ts` não muda. O HTML principal, os pieces e os hashes (`rfb-api-original/0.2.0`) ficam idênticos. A cadeia de reconciliação de capturas desde a **0.1.0** (IN 2.121: tirar só os atributos D04 reproduz `8fc9f206`) continua valendo sem regra nova.
- **Isolamento:** um anexo malformado (tags abertas, `</section>`, comentário aberto) não altera o ato. O teste compara o JSON com e sem o anexo: HTML principal, pieces, texto canônico, partes e `sourceMap` do ato são **idênticos**. O texto do anexo nunca entra no ato. Se o leitor recusar o anexo, o estado é `unreadable`.
- **Corpo e mapa de origem:** os bytes decodificados ficam como estão (SHA-256 e tamanho). O charset é o **declarado no próprio anexo** (`windows-1252`/`iso-8859-1`/`utf-8`), sem normalizar nem reparar. `attachmentByteOffset` converte offsets UTF-16 em offsets de byte: 1:1 em windows-1252; contagem UTF-8 em utf-8. Os testes conferem que os bytes recortados decodificam de volta para o mesmo texto nos três charsets.
- **Limites:** 512 KiB decodificados por anexo (`attachment_too_large`) e 1 MiB por ato (`act_attachments_too_large`).
- **Estados de falha** (todos testados): `missing_no_content` (PDFs tipo 6, sem conteúdo no JSON), `invalid_base64`, `not_html`, `charset_undeclared`, `charset_unsupported` (inclusive bytes UTF-8 inválidos), `unreadable`.
- Nada é buscado na rede. `legalStatus` `unknown` (verificado no lote).

## Resultado nos atos oficiais (lote de 7 INs)
| Ato | Anexos | Lidos | Sem conteúdo |
|---|---|---|---|
| IN 2.121 (127905) | 31 | **1**: id 67992, `IN1.html`, windows-1252, 5.643 bytes, SHA `e07a161b7f74…`, segmento 702 (tabela da fórmula do fator F do art. 137: "F = 0,0365 × Rx…") | 30 (PDF) |
| IN 1.911 (104314) | 30 | 0 | 30 |
| IN 2.021 (116968) | 35 | 0 | 35 |
| 4 outras INs | 0 | — | — |

## Delta da baseline do lote (contra #298 @ `47d166b4`)
Em todos os 7 atos muda **somente** o campo novo `inlineAttachments` (e o `outputHash`, pela identidade). Status, caracteres, partes, limitações, históricos, anexos sem conteúdo e reconciliação de preparação ficam **inalterados**.

**Identidade:** `afb275ec` → `85fd1426` (o módulo novo entra na lista da identidade, como as outras preparações). Local: ANAT 315/315, `tsc`, `verify-build`, PG16 12/12, snapshot sintético inalterado.

**Não incluído:** o anexo lido ainda não é ligado como subárvore `annex` do resultado do motor (contrato inalterado). O lote e a API do módulo o expõem como recurso separado. A ligação ao resultado do motor seria uma etapa à parte.

## R2 (BLOCK do COORD em `e636bc14`) — correções
1. **UTF-8 com BOM:** o anexo é decodificado com `ignoreBOM`. O BOM fica no corpo como U+FEFF, e os offsets UTF-16 → bytes passam a contar os 3 bytes do BOM. Antes, o BOM era descartado na decodificação e todos os offsets ficavam deslocados em 3 bytes.
2. **Fora do BMP:** um caractere fora do BMP ocupa 2 unidades UTF-16 e 4 bytes UTF-8; o mapeamento foi conferido. Um offset no meio de um par substituto é recusado (`RangeError`).
3. **Ponteiros reais do leitor × bytes originais:** os testes percorrem **todos** os `sourcePointers[].sourceSpan` produzidos pelo leitor no anexo e conferem que os bytes originais nesses offsets decodificam exatamente para o mesmo texto. Casos: UTF-8 com BOM, UTF-8 com caracteres fora do BMP, windows-1252, iso-8859-1 e o **anexo oficial da IN 2.121**, comparado com os bytes do base64 do JSON (SHA igual).
4. **Contexto protegido do segmento que referencia o anexo:** o anexo **herda o contexto mais restritivo** das partes do ato que cobrem esse segmento:
   - citação → `prohibited` (inclusive citação aberta vinda de segmento anterior);
   - tachado → `historical`;
   - segmento sem texto e sem tachado, ou sem parte que o cubra → `prohibited` (conservador).

   As partes do anexo nunca ficam mais permissivas que a referência; elas recebem o motivo `rfb_inline_attachment_reference_context`. No lote, o contexto vem do resultado do motor do próprio ato. Na IN 2.121, o segmento 702 (art. 137) é `operative_candidate`.

**Repetido:** corpo e mapa de origem do ato idênticos com anexo malformado; reconciliação histórica (hash 0.2.0 `c223c99d`; tirar os atributos D04 reproduz o capturado 0.1.0 `8fc9f206`); lote de 7 INs.

**Delta do lote contra `e636bc14`:** só o campo novo `inlineAttachments.read[].referenceContext` (`operative_candidate` na IN 2.121) e o `outputHash` (identidade). Identidade `85fd1426` → `d6ada5f6`. Local: ANAT 319/319, `tsc`, `verify-build`, PG16 12/12.
