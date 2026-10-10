# Trifaros — TAX13-R9-REMEDIATION | pacote para revisão independente R9-DESIGN-R2

**Status: proposta do EXECUTOR, NÃO parecer independente.** Revisão anterior R9-DESIGN [BLOCK](https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6093945807) no SHA congelado `e21334fa1b34f6af21c83d661a705fbd6ce58dfb`. Nova frente draft [PR #195](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/195) contra o PR #194, branch `fix/tax13-r9-design-remediation-r2`, sem alterar o SHA auditado anterior. Aguardar SHA final no último checkpoint.

## Mudanças e limitação jurídica

- `dou-official-text-correspondence.ts`: valida agora a seção **impressa** no cabeçalho (`SEÇÃO 1/3`) além de data e número da edição; exige que o conteúdo normalizado integral do ato comece no título e rejeita material não identificado após o limite do ato. Reporta versão `DOU_PDF_TEXT_BOUNDARIES_V2` e `sqlSourceAdmissionAllowed=false` mesmo para candidatos positivos. **TypeScript readonly / a propriedade false NÃO são mecanismos de segurança SQL**. Admission depende exclusivamente de identidade restrita da captura/verificador definidos no desenho. Verificar risco de falso negativo em cabeçalhos reais.
- `dou-native-pdf-text.ts`: montagem de itens PDF com geometria de texto e verificação conservadora de ordem ascendente/inversão lateral; `PDFJS_NATIVE_SPATIAL_V2`, novas provas sintéticas de espaçamento, linha, sobreposição e ordem.
- `TAX13_R9_DOU_EVIDENCE_SQL_RFC_V2.md`: nova proposta documental com DDL tipado, chaves/constraints/FKs, fingerprints, identificadores de edição incluindo sufixo A/B, eventos de captura, índices e XML, segregação de roles collector/verifier, policies FORCE RLS/append-only, gateways SECURITY DEFINER, idempotência, retry, revogação, temporalidade por dispositivo, auditoria sem PDF e status de coleta por tenant.
- Workflow DOU dedicado incluiu branch stacked PR #195 e testes sintéticos específicos. **Não há migration 049+, execução SQL, novo serviço Railway, certificado ICP, recibos positivos reais, merge, deploy ou reprocessamento.**

## Oito achados de R9 — tratamento proposto

| Achado | Design / código tratado | Limites remanescentes |
| --- | --- | --- |
| **P1 D01 — trust boundary** | `sqlSourceAdmissionAllowed=false`; RFC separa coletor de rede, verificador e principal SQL; admissão exclusiva do role, ref à captura + anti-replay/revocation | Sem backend persistente aprovado nem prova real de dois workloads; bypass superuser fora do threat model |
| **P1 D02 — identidade 80/A/B** | Chave composta incluindo data, seção, journal ID, edição com sufixo, página, matter, ZIP/XML/ato/dispatch; índice oficial exigido em execução | Associação oficial de index/INLABS 601↔80-B **ainda não obtida sob uma mesma captura** |
| **P1 D03 — conteúdo** | Checagem adicional de SEÇÃO 1/3, início no título, extra residual desconhecido rejeitado, versionamento do algoritmo, testes | Corpus PDF governamental não disponível para validar todos os layouts e final de ato |
| **P1 D04 — DDL/ACL** | RFC v2 detalha sete tabelas e triggers/policies/gateways, projetor e regra de non-relevance | DDL de proposta não compilado/testado; função completa do verificador e migration 049+ ainda não implementadas (gate independente obrigatório) |
| **P1 D05 — hash real** | Diferenciadas captura Railway, upload e ausência de equivalência; status UNVERIFIED, nenhuma falsa admissão | GET Railway `9cbfa79d...` bytes descartados vs upload `e5cc4ad...`; somente captura real futura autorizada resolverá |
| **P2 D06 — retenção** | SHA/URL/metadados/versão em PG, sem PDF; limitações de auditoria e objeto externo futuro | Prazo de retenção jurídico/operacional e eventual armazenamento externo requerem aprovação |
| **P2 D07 — PDF** | Montagem de espaço por coordenadas + detecção de layout fora de ordem, testes sintéticos | Extração em PDF real 80-B e corpus multicoluna não verificada |
| **P2 D08 — temporalidade** | DDL append-only por cláusula/dispositivo, emendas/ratificação/retroatividade/prazo/revogação supersession, as-of | Nenhuma conclusão CURRENT; emendas/revogação Convênio ICMS 15/24 ainda pendentes |

## Matriz de 18 cenários exigidos

| # | Cenário | Estado executado neste PR / gate posterior |
| --- | --- | --- |
| 1 | DTO `sourceCapture` manual | **UNIT PASS** com retorno candidato `sqlSourceAdmissionAllowed=false`; proteção efetiva SQL **DESIGN ONLY** |
| 2 | Seção impressa divergente | **UNIT PASS** rejeitando seção 3/missing contra DO1 |
| 3 | Edição 80/80-A/80-B | Regular vs Extra sintetizados em teste anterior; vínculo oficial de índice **PENDING** |
| 4 | Journal incompatível | **UNIT PASS** URL/journal discordante no preflight (legado); vínculo índice independente **PENDING** |
| 5 | Matéria INLABS divergente | **UNIT PASS** pré-validação contra XML rederivado (legado); validação fonte real **PENDING** |
| 6 | Ato incompleto | **UNIT PASS** mudança/truncamento e texto integral; delimitação em PDF real **PENDING** |
| 7 | Cláusula modificada | **UNIT PASS** trecho normativo alterado rejeitado |
| 8 | Texto legal conflitante adicional | **UNIT PASS** alteração de cláusula/coda arbitrária rejeitada |
| 9 | PDF inválido/maior 20MiB | **UNIT PASS** negativos existentes de extrator/transporte |
| 10 | HTTPS indisponível | **UNIT PASS** negativos existentes de HTTP; run-status multifuente **DESIGN ONLY** |
| 11 | 2 workers simultâneos | **DESIGN ONLY** — advisory lock/unique; sem migration a executar |
| 12 | Retry com histórico | **DESIGN ONLY** — eventos append-only por job/attempt |
| 13 | Credencial não autorizada | **DESIGN ONLY** — session_user/grants/roles; PG16/18 após migration |
| 14 | UPDATE/DELETE proibido | **DESIGN ONLY** — triggers/RLS/ACL; PG16/18 após migration |
| 15 | Tenant A/B | **DESIGN ONLY** — fonte global e leitura tenant isolada em módulos existentes |
| 16 | Publicação não concede CURRENT | **UNIT PASS** — `grantsLegalCurrent=false`, SQL admission false |
| 17 | Revogação credencial | **DESIGN ONLY** — event revocation e fail-closed projetado |
| 18 | Migration 048 recusa fixture falsa | **PASS HISTÓRICO no HEAD #194** PG16/18 negativos; **R7/TAX11 FAIL** sintéticos (proteção preservada) |

**Testes realizados:** [CI dedicado de PR #195](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38026535577) — `npm run typecheck` **PASS**, **26/26** testes TypeScript sintéticos **PASS** (inclui layout). Nenhuma alegação de PostgreSQL 16/18 de 049+, prova real, CI geral verde ou revisão independente.

## Riscos a revisar adversarialmente

1. O verificador não tem ainda função SQL completa: aceitar um status produzido pelo próprio chamador seria outra forma de fonte fabricável; revisão deve exigir comprovação da segregação real em runtime e implementação verificável mais adiante.
2. Um PHP/TS/SQL cliente externo não pode gerar `SOURCE_ADMITTED` só porque existe correlação textual positiva ou status DTO nominalmente oficial. Toda projeção positiva depende de procedimento restrito e verificação de credenciais/identidade dinâmica.
3. Falsos negativos podem ocorrer em documentos reais quando PDFJS embaralha coluna/página, separadores não aparecem, section label sai fora do masthead ou texto termina em rodapé desconhecido; esses casos ficam UNVERIFIED e geram triagem, sem remediar por permissividade automática.
4. Superuser, comprometimento combinado collector/verifier, conteúdo governamental modificado sob a mesma URL e re-fetch posterior são riscos residuais que devem ser explicitados.
5. NENHUMA evidência de PDF real permite alegar equivalência textual entre o GET Railway 80-B descartado e o upload original. Uma captura futura de serviço Railway requer autorização separada, inclusive estimativa de custo.
6. Como o PR #195 é stacked sobre #194 (base #193/#192/#186), **nenhum PR da cadeia está aprovado para merge/deploy ou migração**. R7 e TAX11 seguem BLOCK sem enfraquecer 048.

## Prompt pronto para revisor R9-DESIGN-R2

**Nome do chat:** Revisor Independente R9-DESIGN-R2 — Trifaros

> Você é o revisor adversarial independente R9-DESIGN-R2 da arquitetura de fonte oficial DOU do Trifaros. Utilize GPT-6 no maior esforço disponível. Leia o parecer R9-DESIGN BLOCK https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6093945807 e as alterações em https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/195, HEAD congelado indicado no último checkpoint da Issue #101. Leia integralmente `docs/taxonomy/TAX13_R9_DOU_EVIDENCE_SQL_RFC_V2.md` e este pacote, os módulos DOU, testes, R9 anterior e migration 048 imutável. Avalie os cinco P1 e três P2 em matriz PASS/BLOCK/NOT_VERIFIED, reproduza falsificações, examine DDL/FKs/unicidade/índices, identidades oficiais A/B, fonte XML/ZIP, papéis coletor/verificador, ausência de gate SQL fabricável, permissões, FORCE RLS/append-only, SECURITY DEFINER/search_path, replay/credenciais/rotação/concorrência, extração e texto, retenção/temporalidade, e as lacunas declaradas. NÃO considere mocks PDF ou HMAC de string como evidência governamental. Distingua aprovação do DESENHO, da implementação 049+ e da liberação para produção. Não peça certificados ICP/PDF. Não execute serviços Railway, migrations, merges, deploy nem rescan. Não trate R7/TAX11 com fixture falsa como autorização de afrouxar migração 048. Registre parecer APPROVED/BLOCK apenas para desenho na https://github.com/fabiojuniort-cyber/tribusca-control/issues/101, sobre SHA congelado, com P0/P1/P2 e condições para fase SQL. Informe percentual de avanço em todas as atualizações; não herde conclusões do executor.

**Próximo gate:** congelar SHA final, conferir execução CI no SHA, registrar Issue #101 e solicitar revisão independente R9-DESIGN-R2. **Nenhuma autorização operacional do proprietário é necessária para revisar o desenho.**
