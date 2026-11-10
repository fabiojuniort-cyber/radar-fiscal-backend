# ANAT-L22 — tipo RFB `anexo` declarado

**Decisão:** aprovada pelo Fábio (tribusca-control#116 c.6671833324). Escopo R2. **Base:** #294 @ `871ed557`. Isolado de L21 e de LOTE-RFB+.

- Quando a tabela `tiposSegmento` **do próprio documento** declara `anexo` e a gramática deixou o bloco **não identificado**, o bloco vira `annex` (rank 2, como o `annex_heading` da gramática), com o motivo `rfb_declared_anexo`. O texto não muda.
- **A gramática tem precedência:**
  - um "ANEXO II" que a gramática já reconhece mantém o motivo da gramática;
  - um texto de artigo declarado `anexo` continua `article`, e o conflito é registrado (`rfb_segment_type_conflict`).
- **Sem mudança:**
  - tipo ausente, desconhecido na tabela ou em conflito na tabela;
  - tipo 999;
  - outras fontes (`data-rfb-*` ignorado);
  - tachado → `historical` com evidência;
  - citação → `prohibited`;
  - `legalStatus` `unknown`.

**Antes × depois:**

| Ato | Limitação "sem mapeamento" | Anexos pelo tipo declarado | Outras diferenças |
|---|---|---|---|
| IN 2.121 (lote) | 0 → 0 | 0 | **+1 `rfb_segment_type_conflict`**: o segmento 702 é declarado `anexo`, mas o texto é o art. 137. A gramática mantém `article`; o conflito, antes invisível porque `anexo` não tinha mapeamento, agora fica registrado. Partes, texto e contagens de tipos iguais |
| 4 outras INs do lote | — | 0 | Estrutura idêntica; só o `outputHash` muda, pela identidade |
| IN 1.911 (#295) | 2 → 0 | 2 (ANEXO X, ANEXO XII) | Não identificado: 1.823 → 1.819 caracteres |
| IN 2.021 (#295) | 4 → 0 | 4 (ANEXO XIII–XV…) | Não identificado: 160 → 103 caracteres |

Os blocos que a gramática não reconhecia começam pelo nome do arquivo do anexo (ex.: "Anexo XII.pdf\nANEXO XIII – …").

**Identidade:** `afb275ec` → `fb5059a8`. Local: ANAT 314/314, `tsc`, `verify-build`, PG16 12/12, snapshot sintético inalterado.
