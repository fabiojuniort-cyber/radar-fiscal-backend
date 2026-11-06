# ANAT COMPOSE-02 — candidato composto offline #298 + #296 + #297

**Autorização:** Fábio (tribusca-control#116 c.6673604188), conforme o plano do #293 §14.3. Candidato revisável: **não** é integração nem liberação. Herda o #285 `2c41fbab` (via #294/#295); **não** está liberado para a `main`. #285, `main` e ramos do R7 intocados.

## Commits (separados conforme pedido)
1. **Merges normais:** #298 @ `47d166b4` ← #296 @ `e6b0dbb0` (`d3ed8f73`, sem conflito) ← #297 @ `cb8a9773` (`cd730399`). Conflitos só em arquivos gerados, na baseline do lote e na guarda da integração, mantidos do lado do #296 nesse commit.
2. **Conferência semântica do `readers.ts`** (este documento): o arquivo composto difere do #296 **somente** pelas linhas da L22 (mapa `anexo: 'annex'` e o ramo `mapped === 'annex'` em `rfbDeclared`) e do #297 **somente** pelas linhas da L21 (`leadingZwsp`, `markerText`, motivo `sefaz_sp_portal_leading_zwsp_tolerated`). A L21 só age com `spPortal` (fonte `SEFAZ-SP-PORTAL` com prova); a L22 só com `rfbSeg` (fonte RFB). Nenhuma linha de uma toca a outra.
3. **Regeneração da identidade** (commit próprio).
4. **Regeneração da baseline de 7 INs** (commit próprio), com o delta por ato.
