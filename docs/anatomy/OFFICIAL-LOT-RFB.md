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

## R2-LOT-01 e R1-LOT-02 (correção após a revisão independente, c.6647567947)

**Preparação registrada × preparação reexecutada.** Cada ato da baseline guarda agora as duas, separadas:
- `capturedPreparation`: copiada do `.meta.json` do snapshot (versão, hash do HTML preparado e número de trechos). **O meta nunca é reescrito.**
- `preparationVersion`/`preparedHtmlSha256`: a preparação refeita agora;
- `preparationReconciliation`: como uma se liga à outra, sempre provado na execução:
  - `identical`: mesma versão, mesmo hash e mesmo número de trechos (4 INs);
  - `d04_annotation_only`: IN 2.121 (127905), capturada com `rfb-api-original/0.1.0` (`8fc9f206…`) e reexecutada com `0.2.0` (`c223c99d…`). A única mudança da 0.2.0 (ANAT-D04, adec6abc) é acrescentar os atributos `data-rfb-type`, `data-rfb-type-issue` e `data-rfb-tachado` aos invólucros `<section>`. Removendo exatamente esses atributos do HTML reexecutado, o SHA-256 volta a ser `8fc9f206…` byte a byte, com os mesmos 4.563 trechos. O texto jurídico não muda.
- Qualquer outra situação (versão desconhecida, hash ou contagem divergente, meta sem preparação) **interrompe** a análise. Os testes negativos adulteram uma cópia do meta e confirmam a falha; o `analyzeLot()` anterior aceitava a divergência em silêncio.

Um gate futuro de vínculo/promoção deve usar a preparação reexecutada **com** a reconciliação provada, nunca o hash registrado sozinho.

**Portabilidade (R1-LOT-02).** Caminhos via `fileURLToPath` (não `URL.pathname`); detecção do ponto de entrada por caminho resolvido (`isCliEntry`), não por sufixo do nome. `--write` aceita `--baseline <arquivo>`; o teste executa o CLI de verdade com `--write` num arquivo temporário e compara com a baseline. `historicalByTachado` conta o motivo `rfb_tachado_source`; o novo `historicalContextParts` conta `context === 'historical'`.

Delta da baseline: somente campos novos; `outputHash`, status e métricas dos 5 atos inalterados. Identidade do motor inalterada (nenhum arquivo do motor mudou).

## LOTE-RFB+ — de 5 para 7 INs (decisão do Fábio, #116 c.6671833324)

- Entram a **IN RFB 1.911/2019** (104314) e a **IN RFB 2.021/2021** (116968), coletadas no #295 (COLETA-02). Os snapshots continuam na pasta `rfb-normasinternet2-coleta02/`: **os originais, os metadados de procedência e o `promoted:false` não foram alterados**. `analyzeLot()` lê as duas pastas (`LOT_DIRS`) e recusa idAto repetido entre pastas.
- **5 INs anteriores:** o registro de cada uma na baseline é **idêntico byte a byte**, inclusive o `outputHash`. Esta mudança não altera o motor (identidade `afb275ec` inalterada); não há diferença a explicar.
- **2 INs novas:** reconciliação de preparação `identical` (capturadas já com a preparação `0.2.0`). Na identidade `afb275ec`, sem L21/L22:
  - IN 1.911: partial; 809.136 caracteres; 1.823 não identificados; 30 anexos sem conteúdo; 6 PARTEs reconhecidas;
  - IN 2.021: partial; 151.963 caracteres; 160 não identificados; 35 anexos sem conteúdo.
- A interação com a L22 (#297/branch `claude/anat-l22-rfb-anexo`) aparece quando os PRs forem compostos: a L22 reduz o não identificado dessas duas INs (1.823 → 1.819 e 160 → 103).
