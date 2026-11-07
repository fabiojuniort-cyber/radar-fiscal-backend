# ANAT-L21 — U+200B no início do bloco (portal Sefaz-SP)

**Decisão:** aprovada pelo Fábio (tribusca-control#116 c.6671833324). Escopo R2. **Base:** #294 @ `871ed557` (COMPOSE-01). Isolado de L22 e de LOTE-RFB+.

- Só na fonte `SEFAZ-SP-PORTAL` com prova verificada: uma sequência de U+200B (com espaços) no **início** do bloco é ignorada **só no reconhecimento do marcador** (inciso, §, alínea, artigo, NOTA). A parte recebe o motivo `sefaz_sp_portal_leading_zwsp_tolerated`.
- **Nada muda no texto:** texto canônico, spans, `sourceMap` e hashes continuam literais. No art. 7º, o SHA do texto canônico (`454171706fc2…`) e do `sourceMap` (`dbd2645b8f27…`) é idêntico antes e depois.
- **Sem mudança:** U+200B no meio do marcador; U+200C, U+200D e U+2060; as fontes DOE-SP, DOU, CONFAZ e RFB; a detecção de citação. U+FEFF já era tratada como espaço pelo `trim()` antes da L21 (comportamento anterior, não alterado).

**Antes × depois:**
- RICMS art. 7º: não identificado **103 → 0** (inciso XV reconhecido). O teste da L14–L16 foi atualizado de 103 para 0 com essa justificativa.
- An. II art. 39: sem mudança (68 caracteres não identificados, sem U+200B).
- Lote RFB: estrutura idêntica nas 5 INs; só o `outputHash` muda, pela identidade.

**Identidade:** `afb275ec` → `029514bb`. Local: ANAT 313/313, `tsc`, `verify-build`, PG16 12/12, snapshot sintético inalterado.
