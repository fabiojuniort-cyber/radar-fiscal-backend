# ANAT COMPOSE-01 — candidato composto offline (#290 + #292)

**Autorização:** COORD em #293 (c.6660098953), confirmada expressamente pelo Fábio: "autorizo a composição e os demais itens do COORD". Escopo: preparar um candidato revisável. **Não** é integração nem liberação.

## Origem (merges normais, histórico preservado)
- Base do ramo: #292 @ `023f7c460400c122ae693ccc05c37a0d63fc7f1a` (L17 ← #291 ← #288 ← #285 `2c41fbab` + #279).
- Merge de: #290 @ `48240b9872d84043d4a0adca4ad027cef22c1996` (L11 ← #289 ← #288).
- **Herança bloqueada:** o candidato contém o #285 `2c41fbab` (via #288), congelado por R7 NOT_PROVEN. **Não está liberado para a `main`.** O #285, a `main` e os ramos do R7 não foram tocados.

## Conflitos e resoluções
Os conflitos aparecem só em arquivos gerados ou na guarda. Nenhum exigiu decisão funcional.

| Arquivo | Natureza | Resolução |
|---|---|---|
| `docs/anatomy/engine-build.json` | Gerado (identidade) | Regenerado com `node ops/anatomy/build-identity.mjs --write` |
| `src/modules/anatomy/build-identity.ts` | Gerado (identidade) | Idem |
| `test/anatomy.base-migration.integration.test.ts` | Guarda da identidade | Os dois históricos ficaram no comentário; a guarda passou ao valor gerado `afb275ec` |
| `docs/anatomy/official-lot-rfb.json` | Baseline (sem conflito textual, desatualizada) | Regenerada com `official-lot-rfb.ts --write`, porque a identidade mudou; estrutura justificada abaixo |

`src/modules/anatomy/readers.ts` combinou automaticamente: L11 no mapa RFB, L14–L17 no portal SP. Os trechos não se sobrepõem.

## Identidade
#290 `525e9466` × #292 `7a7c5fab` → composto **`afb275ec`**. O `outputHash` de toda análise muda por incluir a identidade; isso **não** é mudança estrutural.

## Estrutura, separada da identidade
- **Lote RFB** (baseline sem `outputHash`): as 5 INs são **idênticas** às do #290, em status, caracteres, partes, limitações, históricos, anexos e reconciliação de preparação.
- **SHA da saída completa do leitor** (não contém identidade):

| Ato | #290 | #292 | Composto |
|---|---|---|---|
| RFB 108391 | `d0b30141` | `d0b30141` | `d0b30141` |
| RFB 115131 | `4da42f18` | `4da42f18` | `4da42f18` |
| RFB 127905 | `7ebad3a8` (L11) | `86fd6219` | `7ebad3a8` = #290 |
| RFB 133898 | `061fa137` | `061fa137` | `061fa137` |
| RFB 141910 | `5126448b` | `5126448b` | `5126448b` |
| SP art. 7º, bruto lido como DOE-SP | — | `c18b3f1a` | `c18b3f1a` = #292 |
| SP art. 7º, portal com prova | — | `af411080` | `af411080` = #292 |
| SP An. II art. 39, bruto lido como DOE-SP | — | `ec2fdba3` | `ec2fdba3` = #292 |
| SP An. II art. 39, portal com prova | — | `ba8dc038` | `ba8dc038` = #292 |

Cada ato fica exatamente igual ao do PR que o alterou. Nenhum efeito cruzado.

## Gates locais
`tsc` OK; ANAT unit **310/310** (inclui os testes de #289/#290 e de #291/#292); `anatomy:verify-build` OK; integração PG16 **12/12**; snapshot sintético inalterado. PG18/R7 não foi executado (não autorizado).

## Invariantes
`legalStatus` `unknown`; `promoted:false`; L18 adiada (`blockquote` `prohibited`); L19 não implementada (sem migration ou banco); corpus/gold/reserva intocados.
