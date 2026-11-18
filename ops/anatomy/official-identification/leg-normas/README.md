# Legislação federal pelo normas.leg.br (Congresso Nacional): M1 e M2, não promovidos

**Por que esta fonte:** M1 e M2 (leis de PIS/Cofins, porte grande) apontavam para o Planalto, que recusa este ambiente (em 07/11/2026, `www.planalto.gov.br`, `www4.planalto.gov.br` e `legislacao.presidencia.gov.br` devolvem *empty reply from server*). O `normas.leg.br` é a base oficial de legislação federal do Congresso Nacional (licença CC BY 4.0). Ele publica, para cada lei, o **texto original** e a **versão atualizada** (compilada, com notas de redação, revogações e "vide").

**Como foi obtido, sem contornar nenhum controle:**
1. Busca no Senado (`legis.senado.leg.br/dadosabertos/legislacao/lista`) identifica a norma.
2. `normas.leg.br/api/public/normas?urn=<URN>&tipo_documento=maior-detalhe` devolve os metadados, guardados como `*.normas-metadata.json`.
3. Cada `encoding[].contentUrl` (`/api/public/binario/<id>/texto`) devolve o HTML do texto.

Os bytes estão gravados sem edição. URL, data, HTTP, tipo, SHA-256, bytes, URN, versão, licença e conferência do título estão em cada `*.meta.json`. Todos `promoted: false`.

| id | Item | Versão | Bytes | SHA-256 | Título conferido no arquivo |
|---|---|---|---|---|---|
| lei-10637-2002-original | M1 | texto original | 102.382 | `bb863c51…` | "LEI N. 10.637 – DE 30 DE DEZEMBRO DE 2002" |
| lei-10637-2002-atualizada | M1 | versão atualizada | 180.179 | `8b3ccac4…` | "LEI Nº 10.637, DE 30 DE DEZEMBRO DE 2002" |
| lei-10833-2003-original | M2 | texto original | 308.155 | `60044e68…` | "LEI Nº 10.833, DE 29 DE DEZEMBRO DE 2003" |
| lei-10833-2003-atualizada | M2 | versão atualizada | 388.543 | `c5ca0d93…` | "LEI Nº 10.833, DE 29 DE DEZEMBRO DE 2003" |

**Leitura local histórica** (motor `0e009431`, **perfil DOU**; métrica de diagnóstico, não baseline). Desde a L-LEG-01 (#305), as **duas versões atualizadas** são lidas pela fonte tipada `NORMAS-LEG` (`prepareNormasLegPage`, prova local ligada a bytes/URN/versão/`representationId`): na matriz E9 ficam `read`, **não** `validated` nem `accepted`. Os **textos originais** não têm esse plano e continuam só com o diagnóstico DOU.

| id | Caracteres | Não identificado | Artigos | Parágrafos | Incisos | Alíneas | `quoted_text` | `historical` |
|---|---|---|---|---|---|---|---|---|
| 10.637 original | 60.422 | 813 | 68 | 92 | 105 | 7 | 52 | 0 |
| 10.637 atualizada | 74.715 | 1.200 | 69 | 97 | 122 | 16 | 55 | 0 |
| 10.833 original | 110.418 | 550 | 94 | 131 | 139 | 39 | 159 | 0 |
| 10.833 atualizada | 167.570 | 908 | 115 | 222 | 236 | 54 | 148 | 0 |

**Lacuna observada (tratada na L-LEG-01, #305 — ver `docs/anatomy/L-LEG-01-DESIGN.md` §12):**
- **L-LEG-01 (antes da fonte própria):** na versão atualizada, as notas de redação ("(Redação dada pela Lei nº …)", "(Revogado pela …)", "(Vide …)") e os dispositivos revogados não são reconhecidos como nota editorial nem como redação anterior. Nenhuma parte fica `historical`.

O texto em si não muda: a anatomia continua fiel (sem perda nem reordenação), mas a interpretação dessas notas fica pendente.
