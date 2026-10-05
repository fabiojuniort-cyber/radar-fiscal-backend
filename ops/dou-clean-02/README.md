# DOU-CLEAN-02 — runbook R3 de SUPPRESS / RESTORE

Este runbook governa a implantação e o smoke do mecanismo de escopo reversível da Issue `tribusca-control#84`.

Ele **não autoriza limpeza histórica em lote** e **não autoriza DELETE físico de publications, versões, origens, arquivos, taxonomia, NCM, matches ou histórico de coleta**. A limpeza histórica continua em frente R3 separada.

## Objetivo

Validar em produção que `OUT_OF_SCOPE`:

- desaparece das leituras normais do produto e dos endpoints públicos;
- sai de `publication_source_feed` e das contagens públicas;
- deixa de iniciar NCM, classificação taxonômica e matching;
- não permite que trabalho concorrente confirme derivados depois do SUPPRESS;
- preserva integralmente publicação, versões, origens, arquivos e evidências derivadas já existentes;
- preserva também o fato histórico de que um `collection_run` importou o documento;
- volta a aparecer após `RESTORE`;
- mantém eventos `SUPPRESS`/`RESTORE` append-only;
- é automaticamente restaurado quando material canônico relevante muda.

## Pré-condições obrigatórias

1. LOCK R3 ativo em `tribusca-control#84`.
2. PR da implementação com CI completo verde.
3. revisão independente do SHA material candidato.
4. nenhum batch de limpeza histórica ativo.
5. acesso administrativo ao PostgreSQL para backup/migration/smoke; não usar credencial de runtime.
6. não utilizar Railway AI Agent.
7. registrar SHA do backend e estado de Backend/Worker/Scheduler antes do deploy.
8. **backup lógico + restore validado devem estar concluídos antes de autorizar o merge/deploy**. Em produção, o backend acompanha `main` e o Railway executa `npm run db:prepare` no `preDeployCommand`; portanto, merge pode aplicar migrations antes de a nova aplicação iniciar.

## 1. Gate pré-deploy: snapshot + backup/restore

Esta etapa ocorre com o PR ainda **não mergeado** e antes de qualquer deploy capaz de executar as migrations 033/034/035.

**Dumps, backups e restauração de teste permanecem dentro da Railway.** Executar as ferramentas abaixo em um runner na Railway e restaurar em PostgreSQL temporário isolado na Railway; não baixar o dump nem usar PostgreSQL local. Registrar apenas hashes, contagens, timestamps e resultados sanitizados.

### 1.1 Snapshot somente leitura do banco atual

Executar com credencial administrativa e registrar o resultado:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS backup_snapshot;

SELECT count(*) AS publications FROM publications;
SELECT count(*) AS publication_versions FROM publication_versions;
SELECT count(*) AS publication_origins FROM publication_origins;
SELECT count(*) AS collection_run_publications FROM collection_run_publications;

SELECT to_regclass('public.publication_scope_events') AS events_before,
       to_regclass('public.publication_scope_state') AS state_before,
       to_regclass('public.publication_scope_epoch_state') AS epoch_before;
```

Na primeira implantação de DOU-CLEAN-02, os três objetos de scope devem ser `NULL`. Se já existirem por uma tentativa anterior, **não assumir estado limpo**: registrar o estado, interromper a implantação e reconciliar com a Issue #84 antes de prosseguir.

Manter essa sessão/transação aberta até o término do `pg_dump`. Usar o valor retornado como `SCOPE_BACKUP_SNAPSHOT` no runner; assim o dump e as contagens compartilham o mesmo snapshot mesmo durante coletas concorrentes. Em caso de interrupção da sessão, repetir o snapshot e o dump; não reconciliar contagens obtidas em momentos distintos.

### 1.2 Backup lógico consistente

Criar backup lógico consistente da produção com a ferramenta padrão de PostgreSQL/Railway, sem registrar segredo em log:

```bash
pg_dump "$DATABASE_ADMIN_URL" --snapshot="$SCOPE_BACKUP_SNAPSHOT" --format=custom --file scope-pre-deploy.dump
```

Após o dump concluir com sucesso, executar `COMMIT` na sessão de snapshot.

Registrar timestamp, SHA candidato da aplicação e SHA-256/tamanho do dump.

### 1.3 Restore obrigatório em banco temporário isolado

Restaurar o dump em **banco temporário isolado**, nunca sobre produção:

Provisionar um servidor PostgreSQL temporário na Railway com versão compatível com produção e com as roles referenciadas pelas policies/grants do dump, sem reutilizar senhas produtivas. Confirmar que `RESTORE_MAINTENANCE_URL` aponta para esse servidor isolado. `RESTORE_DATABASE_URL` deve apontar para `scope_restore_test` nesse mesmo servidor; não usar a URL produtiva em nenhum comando de criação/restore. A connection string vai em `--maintenance-db`; o argumento posicional de `createdb` é o nome do banco ([PostgreSQL createdb](https://www.postgresql.org/docs/current/app-createdb.html)).

```bash
createdb --maintenance-db="$RESTORE_MAINTENANCE_URL" --template=template0 scope_restore_test
pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" scope-pre-deploy.dump
```

Validar no restaurado:

```sql
SELECT count(*) FROM publications;
SELECT count(*) FROM publication_versions;
SELECT count(*) FROM publication_origins;
SELECT count(*) FROM collection_run_publications;
```

As contagens devem reconciliar com o snapshot pré-deploy. Registrar como evidência:

- timestamp;
- SHA candidato da aplicação;
- tamanho/SHA-256 do dump;
- resultado do `pg_restore`;
- contagens do banco original e do restaurado.

O arquivo de backup não deve ser commitado no repositório.

**Sem `backup + restore PASS`, o merge/deploy permanece bloqueado.**

### 1.4 Runner versionado na Railway

`runner/Dockerfile` e `runner/backup-restore.sh` automatizam este gate. Criar serviço temporário exclusivo desta frente, sem domínio público, com volume privado em `/data`, restart policy `NEVER`, sem pre-deploy/migration e fonte fixada no SHA revisado. Usar referência Railway à credencial administrativa em `PROD_DATABASE_ADMIN_URL`, sem copiar valores para logs; `CANDIDATE_SHA` registra o SHA candidato. `MODE=preflight` é o padrão e faz somente leitura de versão, tamanho e ausência dos objetos de scope. Só alterar para `MODE=backup-restore` após a revisão independente do runner.

O runner impõe PostgreSQL major 18, sessões produtivas read-only e espaço livre conservador, compartilha snapshot entre dump e contagens de **todas** as tabelas públicas, e restaura em cluster novo dentro do container Railway, sem listener TCP, por Unix socket exclusivo. Roles referenciadas são criadas como `NOLOGIN`, sem copiar senhas. `createdb`/`pg_restore` recebem somente o endereço local desse cluster isolado. Qualquer divergência de contagem impede `SCOPE_BACKUP_RESTORE_PASS`. Dump, cluster restaurado e logs privados permanecem no volume; somente evidência sanitizada é impressa. Não remover esse volume antes do encerramento R3 e da decisão de retenção do backup.

## 2. Deploy/migration e preflight pós-migration

Somente após a evidência da seção 1 estar registrada e o gate R3 autorizar o merge/deploy.

O backend de produção executa `npm run db:prepare` no `preDeployCommand`; isso aplica as migrations antes de iniciar a nova versão. Após o deploy, mas **antes do primeiro SUPPRESS/RESTORE produtivo**, executar:

```sql
SELECT to_regclass('public.publication_scope_events') IS NOT NULL AS events_exists,
       to_regclass('public.publication_scope_state') IS NOT NULL AS state_exists,
       to_regclass('public.publication_scope_epoch_state') IS NOT NULL AS epoch_exists,
       to_regprocedure('public.publication_scope_is_in_scope(uuid)') IS NOT NULL AS predicate_exists,
       to_regprocedure('public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)') IS NOT NULL AS transition_exists;

SELECT public.publication_scope_epoch() AS scope_epoch,
       count(*) FILTER (WHERE scope = 'OUT_OF_SCOPE') AS out_of_scope,
       count(*) AS state_rows
FROM public.publication_scope_state;

SELECT
  has_function_privilege('radar_app',
    'public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)',
    'EXECUTE') AS app_can_transition,
  has_function_privilege('radar_worker',
    'public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)',
    'EXECUTE') AS worker_can_transition;
```

Esperado:

- objetos existem;
- `out_of_scope = 0` antes do smoke inicial;
- `app_can_transition = false`;
- `worker_can_transition = false`.

Também validar que o histórico de coleta continua legível pelo runtime sem reexpor conteúdo canônico:

A migration 035 limita essa leitura às colunas `collection_run_id` e `disposition`. A função `publication_scope_imported_today(uuid)` permite à API pública ler somente a contagem diária em escopo por fonte, sem acesso direto aos identificadores ou timestamps do histórico; suas contagens caem no SUPPRESS e voltam no RESTORE, enquanto `importedDocuments` histórico permanece estável.

```sql
BEGIN;
SET LOCAL ROLE radar_app;
SELECT count(*) FROM collection_run_publications;
ROLLBACK;
```

Falha de migration, privilege check ou reconciliação bloqueia o smoke.

## 3. Escolha do registro de smoke

Usar somente publicação controlada que:

- não seja necessária para operação real de cliente;
- não tenha `company_publications`/`publication_matches` de cliente;
- tenha versão atual e origem conhecidas;
- esteja `IN_SCOPE` antes do teste;
- não esteja sendo alterada por coleta ativa durante a janela do smoke.

Capturar antes do SUPPRESS:

```sql
SELECT p.id, p.identity_hash, p.title, p.act_type, p.act_number,
       p.primary_official_url,
       public.publication_scope_is_in_scope(p.id) AS in_scope
FROM publications p
WHERE p.id = :'publication_id'::uuid;

SELECT md5(string_agg(row_to_json(x)::text, '' ORDER BY x.id::text)) AS versions_fingerprint
FROM (
  SELECT id, publication_id, version_no, content_hash, content_text,
         relevant_excerpt, source_metadata, is_current, captured_at
  FROM publication_versions
  WHERE publication_id = :'publication_id'::uuid
) x;

SELECT md5(string_agg(row_to_json(x)::text, '' ORDER BY x.id::text)) AS origins_fingerprint
FROM (
  SELECT * FROM publication_origins
  WHERE publication_id = :'publication_id'::uuid
) x;
```

Também registrar contagens de `publication_files`, NCM, taxonomia, `company_publications`, `publication_matches`, `publication_source_feed` e `collection_run_publications` para esse publication_id.

## 4. SUPPRESS controlado

Gerar um UUID exclusivo para `operation_id` e um SHA-256 de evidência do manifesto do smoke.

A transição só pode ser executada por credencial administrativa/governada:

```sql
SELECT *
FROM public.apply_publication_scope_transition(
  :'publication_id'::uuid,
  'SUPPRESS',
  :'operation_id'::uuid,
  NULL,
  'DOU_CLEAN_02_PROD_SMOKE',
  'CONTROLLED_SMOKE_SUPPRESS',
  'scope-v1',
  :'evidence_sha256',
  :'manifest_sha256',
  :'actor_ref'
);
```

Registrar `event_id` retornado. Reexecutar **a mesma** operação deve ser idempotente (`applied = false`) e não criar segundo evento.

## 5. Verificações enquanto OUT_OF_SCOPE

Antes de restaurar, provar:

1. `publication_scope_is_in_scope(publication_id) = false`;
2. `publication_source_feed` não contém o publication_id;
3. endpoint público/listas/Acervo normal não devolvem o ato;
4. acesso direto normal ao publication_id não devolve conteúdo ao usuário comum;
5. `X-Publication-Scope-Epoch` avançou e resposta pública usa revalidação HTTP;
6. totais, facets e navegação do Acervo refletem o novo epoch sem aguardar TTL/stale TTL;
7. batch NCM não seleciona a versão;
8. batch de classificação não seleciona a versão;
9. matching não cria novo vínculo para a publicação;
10. contagens de publicação/versões/origens/arquivos/evidências permanecem iguais;
11. `collection_run_publications` e `importedDocuments` históricos do run permanecem iguais ao pré-smoke;
12. runtime `radar_app`/`radar_worker` continua sem EXECUTE na função de transição.

Se qualquer item falhar, **não prosseguir para batch histórico**. Restaurar o registro de smoke e abrir incidente/Issue.

## 6. RESTORE controlado

Usar novo `operation_id` e o `event_id` do SUPPRESS como optimistic lock:

```sql
SELECT *
FROM public.apply_publication_scope_transition(
  :'publication_id'::uuid,
  'RESTORE',
  :'restore_operation_id'::uuid,
  :'suppress_event_id'::uuid,
  'DOU_CLEAN_02_PROD_SMOKE',
  'CONTROLLED_SMOKE_RESTORE',
  'scope-v1',
  :'evidence_sha256',
  :'manifest_sha256',
  :'actor_ref'
);
```

Validar:

- `publication_scope_is_in_scope = true`;
- feed reconstruído;
- API/Acervo normal volta a exibir;
- epoch avança novamente;
- fingerprints de versões/origens e contagens de evidência permanecem iguais aos do pré-smoke;
- histórico de `collection_run_publications` permanece idêntico;
- evento SUPPRESS continua existente e imutável;
- novo evento RESTORE existe.

## 7. Rollback de aplicação

### Antes de qualquer rollback para código anterior ao DOU-CLEAN-02

É obrigatório:

```sql
SELECT count(*)
FROM publication_scope_state
WHERE scope = 'OUT_OF_SCOPE';
```

O resultado deve ser **0**.

Se houver qualquer `OUT_OF_SCOPE`:

1. parar novas operações de scope;
2. restaurar cada registro de forma governada, preservando eventos;
3. verificar feed/API;
4. somente depois considerar rollback da aplicação.

Motivo: código anterior não conhece os guards de scope dos workers e não oferece as mesmas garantias de invisibilidade/concorrência.

### Migration

As migrations são forward-only. Não fazer `DROP` das tabelas/funções de ledger em produção como rollback emergencial: isso destruiria a trilha append-only.

Rollback operacional é:

1. RESTORE dos registros afetados;
2. confirmar zero `OUT_OF_SCOPE`;
3. manter ledger preservado;
4. reverter somente a aplicação para SHA anterior, se necessário;
5. abrir migration compensatória revisada em PR próprio caso seja necessário retirar a infraestrutura depois.

## 8. Pós-deploy

Registrar em `tribusca-control#84`:

- SHA mergeado e SHA deployado;
- CI completo;
- parecer independente;
- backup + restore **pré-deploy** PASS;
- contagens/fingerprints pré e pós smoke;
- event_ids SUPPRESS e RESTORE do fixture;
- epoch antes/SUPPRESS/RESTORE;
- prova de invalidação imediata de cache v1/v2/Acervo;
- prova de preservação de `collection_run_publications`/`importedDocuments` histórico;
- estado Backend/Worker/Scheduler;
- ausência de publicações deixadas OUT_OF_SCOPE pelo smoke.

Somente depois disso a Issue #84 pode ser encerrada. A seleção e aplicação do acervo histórico permanece na Issue R3 própria (#80), com manifesto e dry-run dedicados.
