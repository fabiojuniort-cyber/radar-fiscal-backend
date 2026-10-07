# ACT-SCOPE-02 — smoke produtivo

Issue tribusca-control#87. Runner Bun/pg, conexão DATABASE_ADMIN_URL existente, sem impressão de credenciais. ACT_SCOPE_02_MODE preflight/verify são READ ONLY. enqueue cria exclusivamente a execução MANUAL dca14937-8c41-477e-91f1-9b99f091692e para fonte DOU ativa, após política 1r5 APPROVED, lock curto e ausência de runs abertas; replay não cria duplicatas. O worker normal coleta conteúdo oficial e usa seu motor central já implantado, sem fixture/policy/checkpoint/config inventados. Não cancelar/remover a execução após iniciar; observabilidade de tentativa/run normal é a trilha preservada.

Gate antes de enqueue: frontend PR77 revisado e CI verde, merge/deploy correspondente; backend e worker saudáveis; revisão independente do script exato; lease R3 na Issue. Escopo autorizado pelo checkpoint do usuário em 07/10/2026. Sem DELETE/repair histórico. Backup não se aplica ao mero enqueue de uma coleta normal append/versionada (sem sobrescrita destrutiva); Stage7 será preparado/revisado separadamente com suas salvaguardas de banco.

verify deve provar KEEP persistido, FILTERED_OUT sem publication_id, descarte sem origem canônica para ao menos um item, metadados 1r5 e expiração +3meses, schema sem conteúdo/summary e zero enforcement DOE-SP. Reavaliar os nomes reais de status/schema no preflight antes da escrita. Run pode ser PARTIAL_SUCCESS por falha de aquisição; só aceitar smoke se os indicadores de filtro forem completos e não houver falha do filtro.

Stage7 permanece bloqueado até smoke verde. Manifest é simulação aprovada 2dfb162f-5901-4170-addd-f25627bd7da0; preservar todas as exclusões preexistentes de outras frentes. Nenhuma execução SUPPRESS/RESTORE está incluída neste artefato.
