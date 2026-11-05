# OFFICIAL-LOT-RFB — lote de análise reprodutível das normas oficiais da RFB

Pacote proposto em tribusca-control#116 (c.6647242287), sem decisão nova: coleta e análise já autorizadas, fontes acessíveis, nada promovido.

- **Base:** #288 @ `0069e3bd` (D04 e D05 aceitos), mais o #279 @ `665b3231` (snapshots). **O #285 não é tocado.**
- **Script:** `ops/anatomy/official-lot-rfb.ts`. Para cada snapshot, confere os bytes contra o SHA-256 registrado, revalida a representação (D03), prepara o JSON e roda o motor completo. Com `--write`, grava a baseline `docs/anatomy/official-lot-rfb.json` (métricas e `outputHash` por ato).
- **Teste:** `test/anatomy.official-lot-rfb.unit.test.ts` refaz o lote e falha em qualquer divergência da baseline: identidade do motor, texto, partes, limitações ou hash de saída. Uma mudança de motor exige regenerar a baseline e revisar o delta.

| IN | Porte | Status | Caracteres | Não identificado | Históricos (tachado) | Anexos sem conteúdo |
|---|---|---|---|---|---|---|
| 1.932/2020 | pequeno | complete | 2.003 | 0 | 0 | 0 |
| 2.162/2023 | pequeno | complete | 4.540 | 0 | 19 | 0 |
| 2.237/2024 | médio | partial | 31.389 | 11.279 | 10 | 0 |
| 2.005/2021 | grande | complete | 57.179 | 0 | 342 | 0 |
| 2.121/2022 (PIS/Cofins) | muito grande | partial | 1.009.001 | 437 | 608 | 31 |

"complete" é o status do leitor; não prova completude estrutural nem jurídica. `legalStatus` continua `unknown` em todas as partes (verificado na execução). Todas as INs ficam `promoted: false`.
