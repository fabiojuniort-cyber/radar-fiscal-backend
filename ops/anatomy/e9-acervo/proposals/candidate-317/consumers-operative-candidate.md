# Consumidores de `operative_candidate` do anexo RFB inline (`referenceContext` / `context` das partes)

Refs: main=e4514436, #300=22e8cc48 (módulo `src/modules/anatomy/rfb-inline-attachments.ts`, "RIA"), #303=46afdaf1 (matriz/aceites). Patches lidos: A r13 (#300), B r7 (#303). Nada foi editado/commitado; reprodução feita numa cópia (`git archive` + patch r13) em `.../scratchpad/cand/w300` (script: `.../cand/repro-operative-candidate.ts`).

## 1. Produção e consumo (rastreio exaustivo)

Estrutura: `referenceContext` é calculado por `referenceContextOf` (RIA:105-129 em #300; r13 acrescenta `expressReference` e a promoção a `operative_candidate` no ramo "segmento sem texto"). Em seguida RIA:181-183 só REBAIXA as partes do anexo (nunca promove): `operative_candidate` não altera nenhuma parte.

| Ref | Onde (file:linha) | O que faz com o valor |
|---|---|---|
| main | (RIA não existe; `git grep` = 0 em src/ops/test) | sem consumidor |
| #300 | `rfb-inline-attachments.ts:55-56,154-156,181-183` | produz/guarda `referenceContext(+Evidence)` e `context` das partes do anexo |
| #300 | `ops/anatomy/official-lot-rfb.ts:68,71-77` (único importador de `readRfbInlineAttachments`) | copia só `referenceContext` (string) p/ `inlineAttachments.read[]` da baseline; checa `legalStatus==='unknown'` (l.76) |
| #300 | `docs/anatomy/official-lot-rfb.json` (1 ocorrência: IN 2.121, id 67992 = `operative_candidate`) | baseline offline; `test/anatomy.official-lot-rfb.unit.test.ts` falha em qualquer deriva |
| #300 | `ops/anatomy/build-identity.mjs:7` + `docs/anatomy/engine-build.json` | o arquivo entra no hash do motor (`ANATOMY_ENGINE_BUILD_HASH`) |
| #300 | `test/anatomy.rfb-inline-attachments.unit.test.ts` (l.135-186) | só asserts |
| #303 | `ops/anatomy/official-coverage-matrix.ts` (r7: `rfbReadingAssessment`, `AnnexReadEvidence`) | lê `a.inlineAttachments.read[]` mas usa SÓ `id` e `sha256`; comentário do patch (l.~1259-1261): "COMPLETENESS IS INDEPENDENT OF THE OPERATIVE CONTEXT". Em #303 puro a baseline não tem `inlineAttachments` (0 ocorrências) |
| #303 | `ops/anatomy/e9-acervo/*` (working tree) | só `p.context==='operative_candidate'` do ato principal (`rfb-acervo-equivalence.mts:23`), não do anexo |
| src/ (todas as refs) | `git grep -E 'rfb-inline-attachments\|readRfbInlineAttachments\|referenceContext\|inlineAttachments'` em src/ migrations/ | **zero importadores fora do próprio RIA**. Rotas (`anatomy-config.route`, `anatomy-rules-admin.route`), `worker.ts`, `simulation-worker.ts`, `consumer.ts` não o importam |
| contrato | `contract.ts`, `contract-v1.schema.json` | sem campo de anexo inline; `docs/anatomy/L2-L12-INLINE-ANNEX.md`: "o anexo lido ainda não é ligado como subárvore `annex` do resultado do motor (contrato inalterado)" |
| web (842bd77) | `git grep operative_candidate\|referenceContext\|inlineAttachments\|rfb-inline` = 0 | sem consumidor (só checkout local HEAD; outras branches NOT_PROVEN) |

Consumidores genéricos de `part.context==='operative_candidate'` (contract.ts:239,264; engine.ts:83; evaluation.ts:70; config/view.ts:102) operam sobre o `AnatomyResult` do motor (`analyzeAnatomy`) do ATO principal. O leitor do anexo é uma passada separada de `readAnatomyInput` (sem entidades, sem eligibilidade) e nunca é passada a eles.

## 2. Classificação do efeito de um `operative_candidate` errado

| Categoria | Efeito | Evidência |
|---|---|---|
| (a) DISPLAY (UI/API) | **Não afetado** | nenhuma rota/serviço/web importa RIA nem a baseline; contrato/schema sem o campo; web: 0 ocorrências |
| (b) PERSISTÊNCIA | **Não afetado em DB.** Só persiste em `docs/anatomy/official-lot-rfb.json` (JSON de repositório, string `referenceContext`) | `official-lot-rfb.ts:74-75`; src/ não grava `anatomy_parts` (migration 077 só define schema; `git grep anatomy_parts` em src = 0); recurso `rfb:<id>:anexo:<fid>` não é `publication_version`. Hoje a baseline só tem 1 anexo lido (IN 2.121/67992), pelo ramo "segmento com texto", não pelo ramo express-ref |
| (c) CLASSIFICAÇÃO | **Não afetado**: `part.context` do ato principal, cobertura, NCM/entidades, taxonomia, perfil/sonar | r13 não toca `engine.ts`/`readers.ts`/`entities.ts` (arquivos do patch: build-identity, RIA, lot JSON, engine-build, package.json, 2 testes); `reading` é `AnatomyReaderResult` (sem entidades); em reprodução, o NCM da tabela não é extraído. Só muda `reading.parts[].context` do anexo (isolado) |
| (d) ACEITE | **Não afetado na lógica; afetado só como pin de digest** | B r7: completude usa só `id`+`sha256` (`rfbReadingAssessment`); `accepted` exige registro MANUAL em `docs/anatomy/e9-acceptances.json` (nenhum registro é criado automaticamente; validação fail-closed). Indireto: `entrySha256 = sha(canonJson(entrada do lote))` inclui `inlineAttachments.read[].referenceContext`; e `engineBuildHash` muda com qualquer edição do RIA (r13: 04af1bfd→8debb578; o aceite de 148693 pina 0e009431). Mudar `referenceContext` invalida/ força re-pin, não detecta o erro. Único aceito: rfb:148693 (Portaria 635/2025), cujo JSON não tem `arquivoBinario` nenhum -> sem anexo inline, `referenceContext` inaplicável |
| (e) DECISÕES A JUSANTE (alertas, Sonar, notificações, `legalStatus`) | **Não afetado** | nenhum código de alerta/sonar/notificação toca RIA; `legalStatus` permanece `unknown` (RIA nunca o define; checado em `official-lot-rfb.ts:76`; reproduzido: `unknown`). Nota: contract.ts:239/264 exigem `legalStatus==='current'` além de `operative_candidate` para seleção segura, então `operative_candidate` sozinho nunca bastaria |

## 3. Os três casos residuais (reproduzidos em #300 + r13)

Montagem: seg.1 com texto "Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas <X>, conforme tabela a seguir:"; seg.2 SEM texto com `arquivoBinario` tipo 5 (tabela); seg.3 "Art. 2º ...". Resultado (`state=read`):

| Caso `<X>` | `referenceContext` | partes do anexo | `legalStatus` |
|---|---|---|---|
| 1 "da norma em apreço" | `operative_candidate` (evidência: "express reference: segment 1 ends 'tabela a seguir:'...") | operative_candidate | unknown |
| 2 "do ato epigrafado" | idem | idem | unknown |
| 3 "da norma em foco" | idem | idem | unknown |
| controle "desta Portaria" | idem (correto: autorreferência) | idem | unknown |
| controle "da IN RFB nº 2.121" | `prohibited` | prohibited | unknown |

Por categoria, nos 3 casos: (a) não afetado; (b) não afetado em DB (apareceria em `official-lot-rfb.json` apenas se um ato real do lote reproduzisse o padrão: hoje nenhum, a baseline do r13 não altera nenhum `referenceContext`); (c) não afetado (só `reading.parts` do anexo, isolado; ato principal idêntico); (d) não afetado (nenhuma lógica de aceite lê o contexto; nenhum aceite automático); (e) não afetado (`legalStatus` unknown, sem consumidores).

O erro é, portanto, um falso positivo de DADO PROVISÓRIO no resultado offline do módulo (rótulo de proveniência da tabela), sem consumidor que o torne decisão. O risco é prospectivo: se uma etapa futura ligar o anexo ao resultado do motor (declarada "à parte" em L2-L12-INLINE-ANNEX.md), as partes do anexo viriam `operative_candidate` e entrariam em `evaluation.ts:70` (candidato NCM), `engine.ts:83` (eligibilidade, ainda `eligible:false` por falta de evidência) e `config/view.ts`; isso exigiria ainda `legalStatus==='current'` para seleção segura (contract.ts:239).

## 4. NOT_PROVEN
- Web: só o checkout local (842bd77); outras branches/deploy não inspecionados.
- Caminhos de runtime: nenhum teste de integração com PG foi executado; a ausência de escrita em `anatomy_parts` é por `git grep` em src/ (#300), não por execução. Refs main/#303 não contêm RIA, logo a combinação #300+#303 (lote com `inlineAttachments` sobre as 14 amostras; revalidação do pin `entrySha256`) não foi construída/executada.
- A suíte completa do patch r13 não foi rodada; só o script de reprodução dos 3 casos (+2 controles).
- Comportamento de `official-lot-rfb` com os 14 atos do lote #303 + r13 (se algum ato real aciona o ramo express-ref): não medido.
