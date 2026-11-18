# E9-A1 — prova de leitura de três células RFB (proposta, NÃO registrada)

Mandato: COORD → EXEC F1 "E9-A1 — Provar leitura de três células RFB" (tribusca-control#116).
Escopo: offline, acervo já preservado, motor publicado pelo #317 (`4b96f977…`). Sem coleta, grants,
mudança de motor, alteração da matriz oficial, merge ou deploy. Nada foi escrito em `docs/anatomy/e9-acceptances.json`.

| Arquivo | Conteúdo |
|---|---|
| `e9a1-reading-proof.mts` | rotina da Portaria 635 generalizada para as 6 amostras (dois checkouts independentes) |
| `e9a1-reading-proof.json` | evidência por amostra e por célula (determinística; reexecução byte-idêntica) |
| `e9a1-proposed-acceptances.json` | 4 registros append-only PROPOSTOS; `decidedBy`/`decidedOn` = PENDENTE |

## Reproduzir

```bash
git worktree add --detach /var/tmp/e9a1-pub 196c6ca91570e2041b24e62ff676de5896ca7193   # merge publicado do #317
git worktree add --detach /var/tmp/e9a1-main 86518ba0                                  # main atual (mesmo motor)
ln -s "$PWD/node_modules" /var/tmp/e9a1-pub/node_modules; ln -s "$PWD/node_modules" /var/tmp/e9a1-main/node_modules
cd /var/tmp/e9a1-main && npx tsx <este-dir>/e9a1-reading-proof.mts /var/tmp/e9a1-pub /var/tmp/e9a1-main out.json
sha256sum out.json   # esperado c69911bca020674a09a4c162ca0999418fcf296e1c23a91af06c09b5dabfbaaa
```

Simulação descartável (feita e revertida com `git checkout`): anexar os 4 registros com campos de decisão sintéticos
ao `e9-acceptances.json` de uma cópia passa na validação estrita e leva a matriz de 1 → 4 células aceitas
(IN pequeno, IN grande, Portaria pequeno, além da Portaria médio); `e9MatrixComplete` continua `false` (48 pendentes).
