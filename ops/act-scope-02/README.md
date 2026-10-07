# ACT-SCOPE-02 — operadores e evidências

Frente: [tribusca-control#87](https://github.com/fabiojuniort-cyber/tribusca-control/issues/87). Autorização explícita do usuário para coleta real e SUPPRESS → validação → RESTORE, sem exclusão física. Operações produtivas exigem lease, SHA exato revisado, CI e saúde. Dumps, manifestos completos e diagnósticos privados permanecem no volume Railway.

## Coleta e verificação

- `smoke.tsx`: procedimento original Bun/pg para o slot natural SCHEDULED de 07/10/2026 17:00 UTC, ID `dca14937-8c41-477e-91f1-9b99f091692e`. Enqueue utiliza a mesma chave única do scheduler, recusa conflitos e só é válido na janela codificada. Preflight/verify são somente leitura. O ciclo terminou SUCCESS_NO_RESULTS e não comprova KEEP/DISCARD.
- `smoke-backfill.mjs`: coleta oficial de um único dia elegível (15/07/2026), uma tentativa, motor central existente, cron/90 minutos/política efetiva APPROVED 1r5 e concorrência revalidados. Dry-run padrão; --apply só com os gates. BACKFILL preserva o checkpoint de monitoramento. Timeout de 900000ms limita aquisição, sem promessa de teto total de persistência. Ver [BACKFILL-SMOKE.md](BACKFILL-SMOKE.md).
- `verify-smoke.tsx`: verificador Bun/pg sempre READ ONLY, exige ACT_SCOPE_02_VERIFY_RUN_ID explícito. PASS depende de coleta terminal DOU, KEEP persistido, FILTERED_OUT sem vínculo canônico, todos os descartes ausentes das origens por chave externa, razão/política1r5/expiração3meses e ausência de conteúdo integral/summary, descartes expirados ou enforcement DOE-SP. Logs de diagnóstico usam apenas código seguro e status; não imprimem credenciais ou mensagens livres. NEW_VERSION aparece separadamente nos itens/métricas.

A coleta usa o filtro antes da persistência. Não há filtro paralelo, reset de checkpoint, alteração de fonte/cron ou dados fabricados. Retenção rotineira remove somente auditoria expirada; nenhuma publication é apagada.

## Backup e restauração

`backup-restore.sh` / Dockerfile usam uma pasta, serviço e volume privados exclusivos ACT. MODE=preflight é READ ONLY. MODE=backup-restore mantém snapshot REPEATABLE READ READ ONLY em produção, cria pg_dump18 e restaura em cluster PostgreSQL18 novo, apenas Unix socket local. Produção nunca é alvo de createdb/pg_restore. Todas as contagens de tabelas públicas devem coincidir. EXPECT_SCOPE_TABLES=present; CANDIDATE_SHA identifica o artefato aprovado.

## Histórico reversível

`stage7.cjs` / `stage7-runner.sh` implementam preparação somente leitura, ensaio isolado, roundtrip produtivo e recuperação. Ver [STAGE7.md](STAGE7.md) para variáveis, caminhos e gates.

A simulação FULL_ARCHIVE aprovada fornece a decisão; o operador não reavalia regras fiscais. Somente DISCARD atualmente IN_SCOPE e com material estável entram no manifesto. Estados OUT anteriores, KEEP, origens mistas/DOE e divergências de material permanecem intocados. A preparação grava metadados/hashes privados, nunca corpos integrais.

SUPPRESS e RESTORE usam exclusivamente apply_publication_scope_transition e eventos append-only. Lease e material são revalidados por lote. RESTORE compensa apenas eventos SUPPRESS atuais deste manifesto, tenta três vezes por lote, continua os demais e registra pendências privadas. Qualquer pendência impede PASS. Durante a supressão verifica feed e leitura normal radar_app iguais a zero; após compensação verifica retorno, contagens físicas, hash externo e avanço do epoch de cache. Recovery restore permanece permitido mesmo após expiração da lease ou mudança de política.

O SHA operacional do ciclo documentado na Issue87 é `5dbc15f03c0bc36797ff145c4543891c56aab270`. Atualizações documentais posteriores não alteram esse identificador de execução. Não executar scripts de DOU-CLEAN como se pertencessem a ACT-SCOPE-02. Ao concluir, remover somente os serviços ACT e preservar o volume de backup.
