# ACT-SCOPE-02 — smoke e preparação de banco

Issue tribusca-control#87, autorização explícita no checkpoint do usuário 07/10/2026, lease ACT-SCOPE-02-OPS registrado na Issue. R3 requer revisão independente do SHA exato e health antes de escrita.

## Smoke

smoke.tsx (Bun/pg) usa DATABASE_ADMIN_URL existente sem imprimir credenciais. ACT_SCOPE_02_MODE=preflight/verify: READ ONLY. enqueue registra somente a próxima execução natural SCHEDULED do DOU, slot07/10/2026 17:00UTC (14:00 Brasília), iddca14937-8c41-477e-91f1-9b99f091692e. A mesma chave(source_id,scheduled_for,trigger_type) única/ON CONFLICT do scheduler impede outra execução desse slot. Não roda antes do horário normal. Valida cron/timezone, janela de preparação antes16:40UTC, política efetiva maior APPROVED=1r5, fonteativa, nenhuma outra run aberta. Slot existente com outro ID é recusa explícita, não sucesso fictício. Rerun com o mesmo ID é idempotente. Lease congela operacionalmente política1r5; revalidar antes aquisição e conferir versão/revisão nos stats após a execução.

Sem fontes/cron/checkpoints/config/worker alterados; worker usa motor central aprovado e coleta oficial normal. Persistência normal atualiza metadados/versões/checkpoints; retention rotineira elimina somente auditoria de descartes expirada conforme migration041. Não há exclusão de publications ou SUPPRESS/RESTORE neste smoke. Backup não se aplica ao mero enqueue de coleta normal não destrutiva; nenhum repair está incluído.

verify exige KEEP persistido, FILTERED_OUT sem publication_id, descarte com source_item_key/externalId ausente das origens, razão/termo/policy1r5/+3meses, schema sem conteúdo/summary, zero enforcement DOE-SP. Para DOU a identidade é a chave externa, não URL de página compartilhada. PARTIAL_SUCCESS de aquisição só aceita filtro verde e ausência de falha do filtro.

## Backup/restauração para Stage7

backup-restore.sh e Dockerfile adaptam o procedimento existente de backup lógico, preservando nova pasta/volume/serviço ACT distintos. MODE=preflight é READ ONLY. MODE=backup-restore usa snapshot REPEATABLE READ READ ONLY na produção, pg_dump18 e restaura em clusterPostgres18 novo Unix-socket-only no próprio container Railway. Não usa produção como alvo de createdb/pg_restore. Contagens de todas as tabelas públicas restauradas devem coincidir; dump, logs e cluster permanecem em volume privado Railway, sem exportação para GitHub/cliente. EXPECT_SCOPE_TABLES=present. CANDIDATE_SHA identifica artefato aprovado, não polí­tica DOU-CLEAN. Nunca reutilizar/modificar runner/volume de outra frente.

Antes da Stage7: smoke verde, backup/restore PASS, dry-run do executor separado, manifest aprovado/snapshotmaterial validado, revisão independente exata. Usar somente apply_publication_scope_transition; preservar estadosOUT preexistentes e KEEP. RESTORE apenas eventosSUPPRESS deste manifest/ACT. Ainda não há executor Stage7 neste commit.
