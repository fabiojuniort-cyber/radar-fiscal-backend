# TAX-13 — Plano de rollout adversarial R2 (B5)

Status: **BLOQUEADO para merge/deploy**, até deltas R2, aferição de proveniência e compatibilidade de tags. Não é autorização de rescan.

## Inventário de produção (08/10/2026 UTC)
Consulta agregada somente de leitura, via serviço operacional `taxonomy-v11-validation`, deploy `fa660b32-cb1e-430e-8eb5-6d0c7f71196f`, sem alterar dados.

| Métrica | Observado |
|---|---:|
| Versões atuais em escopo, excluindo origem DOE-SP | 96.066 |
| Versões atuais, todas as origens | 122.170 |
| Versões atuais com HTML de apresentação | 77.984 |
| Versões atuais sem HTML de apresentação | 44.186 |
| HTMLs atuais acima de 2 MiB | 0 |
| NCM detector 1.0.0 SUCCESS | 111.344 scans históricos |
| NCM detector 1.1.0 SUCCESS | 2 |
| NCM detector 1.2.0 SUCCESS | 2 |
| Curated engine 2.1.0 SUCCESS | 1 |
| Curated engine 2.2.0 SUCCESS | 6 |
| Curated engine 2.3.0 SUCCESS | 2 |
| Release v1.6.0 | PUBLISHED, **zero scans de taxonomia** |
| Taxonomia anterior v1.5.0 | 4 scans |
| Switch classificação global | OFF |
| Fontes excluídas da classificação global | DOE-SP |

Contagens de scans por versão são históricos globais, **não** a diferença de 96.066 documentos atuais. Não somar os scans como quantidade de documentos distintos. A ausência de HTML ou escopo validado não autoriza fallback para `content_text` ou `relevant_excerpt`.

## Gates obrigatórios
1. **Bloquear varredura implícita:** o worker TAX13 com detector 1.2.0 usa guarda de opt-in separada `TAX13_GLOBAL_NCM_RESCAN_APPROVED=true`. Se ausente, o loop automático NCM 1.2.0 fica desabilitado mesmo quando `PUBLICATION_NCM_ENRICHMENT_ENABLED=true`; produção não deve habilitar essa guarda antes do plano R2. Startup reporta `ncmGlobalRescanGuard=TAX13_NOT_APPROVED`. O job direcionado `taxonomy-ncm-rescan-one` fica independente e não é acionado por esse guard.
2. **Classificação global OFF**, DOE-SP excluído e nenhum backfill até inventário/aceite. Confirmar variáveis no Railway **antes** e **depois** do deploy; não confiar em `.env.example`.
3. **Conflito de versões:** engine 2.3.0 e NCM 1.2.0 não herdam aprovação de 2.2.0/1.0.0. Não exibir NCMs ou tags de redação antiga como atuais. A preservação de tags automáticas anteriores precisa indicar explicitamente verificação/ciclo, sem fingir novo sucesso. Preserve decisões de curadoria e releases anteriores append-only.
4. **Proveniência:** fonte oficial, hash de conteúdo, data de referência, texto legal efetivamente vigente, segmento/anexo/célula, evidência do ato alterador. Fragmentos externos sem extração/status comprovado são `UNVERIFIED` e não geram afirmações.
5. **Canário:** somente depois de R2 e deploy, verificar em produção `CV100/97` (publication `4c92f7ce-2e3d-4a61-9524-d4beca0c2af7`, version `8f1a2386-30fc-4f11-a88a-e96a65807793`) e `CV52/91` (`07d24640-61a0-45db-8f69-3b064320b2b2`, version `ec18e755-128c-41ca-8cd3-2bdad7d9d9eb`). Registrar listas antes/depois de tags, NCM, tratamento de anexo revogado, etiquetas UNVERIFIED; checar impacto frontend/API.
6. **Rollout por lotes:** somente após inventário por origem/UF e previsão de custo/duração, limites pequenos por ciclo, observabilidade de PENDING/SUCCESS/FAILED/UNVERIFIED, pausas/rollback testado. Proibir ativar `TAX13_GLOBAL_NCM_RESCAN_APPROVED` enquanto faltar aprovação R2.
7. **Rollback:** o código deve voltar à versão anterior por redeploy, sem apagar histórico de runs/assertions; reversão de exibição tem de distinguir tags não revalidadas da vigência atual.

## Riscos pendentes
- B4: metadados `data-legal-status=current` sem adaptador/proveniência confiável continuam insuficientes. PDF/XLS externos, atos alteradores e vigência temporal são escopo pendente.
- B5: reuso seguro de tags antigas na API/UI ainda não está implementado/provado; o guard do Worker sozinho só evita carga global.
- Deltas B1/B2/B3 e rebase frontend exigem CI verde e parecer R2/delta sobre os novos SHAs.

Este plano é evidencia de inventário e definição de gates; **não equivale a B4/B5 resolvidos**.
