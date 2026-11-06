# ANAT COMPOSE-02 — candidato composto offline #298 + #296 + #297

**Autorização:** Fábio (tribusca-control#116 c.6673604188), conforme o plano do #293 §14.3. Candidato revisável: **não** é integração nem liberação. Herda o #285 `2c41fbab` (via #294/#295); **não** está liberado para a `main`. #285, `main` e ramos do R7 intocados.

## Commits (separados conforme pedido)
1. **Merges normais:** #298 @ `47d166b4` ← #296 @ `e6b0dbb0` (`d3ed8f73`, sem conflito) ← #297 @ `cb8a9773` (`cd730399`). Conflitos só em arquivos gerados, na baseline do lote e na guarda da integração, mantidos do lado do #296 nesse commit.
2. **Conferência semântica do `readers.ts`** (este documento): o arquivo composto difere do #296 **somente** pelas linhas da L22 (mapa `anexo: 'annex'` e o ramo `mapped === 'annex'` em `rfbDeclared`) e do #297 **somente** pelas linhas da L21 (`leadingZwsp`, `markerText`, motivo `sefaz_sp_portal_leading_zwsp_tolerated`). A L21 só age com `spPortal` (fonte `SEFAZ-SP-PORTAL` com prova); a L22 só com `rfbSeg` (fonte RFB). Nenhuma linha de uma toca a outra.
3. **Regeneração da identidade** (commit próprio).
4. **Regeneração da baseline de 7 INs** (commit próprio), com o delta por ato.

## Identidade
#296 `029514bb` × #297 `fb5059a8` → **`050602a3`** (`build-identity.mjs --write`; igual à prova do #293 §14.3).

## Baseline de 7 INs — delta por ato (contra #298 @ `47d166b4`)

| Ato | Diferença | Causa |
|---|---|---|
| 108391 IN 1.932 | só `outputHash` | identidade |
| 115131 IN 2.005 | só `outputHash` | identidade |
| 133898 IN 2.162 | só `outputHash` | identidade |
| 141910 IN 2.237 | só `outputHash` | identidade |
| 127905 IN 2.121 | `rfb_segment_type_conflict` 0→1 | L22: o segmento 702 é declarado `anexo`, mas o texto é o art. 137; a gramática é mantida e o conflito fica registrado |
| 104314 IN 1.911 | não identificado 1.823→1.819 caracteres; unidentified 17→15; annex 30→32; `rfb_segment_type_unmapped` 2→0; `rfb_tachado_evidence` 17→15 | L22: 2 anexos declarados eram blocos não identificados **tachados**; agora são `annex` histórico (motivo `rfb_tachado_source`), e a evidência específica de "não identificado tachado" deixa de ser emitida |
| 116968 IN 2.021 | não identificado 160→103; unidentified 5→1; annex 56→60; unmapped 4→0 | L22 |

A L21 não muda nenhum ato RFB.

## SHA da saída completa do leitor por ato contra o PR de origem

| Ato | Composto | Origem | |
|---|---|---|---|
| RFB 104314 / 108391 / 115131 / 116968 / 127905 / 133898 / 141910 | `32de6a27` / `d0b30141` / `4da42f18` / `5ffdbb69` / `386c4d02` / `061fa137` / `5126448b` | #297 (L22) | **todos iguais** |
| SP art. 7º / An. II art. 39 / An. I art. 41 / An. II art. 3º / art. 8º / art. 9º | `1f6d43fb` / `ba8dc038` / `f0c57bd6` / `87bb439e` / `dd9ab260` / `d970394a` | #296 (L21) | **todos iguais** |

## Gate local no SHA final
`tsc` OK; ANAT unit **317/317**; `anatomy:verify-build` OK (`050602a3`); integração PG16 **12/12**; snapshot sintético inalterado. CI: ver o PR.
