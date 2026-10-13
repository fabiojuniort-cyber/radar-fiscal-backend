# Phase 3 — Collection Engine

## Scope

This phase implements the generic federal/state collection foundation. It intentionally does **not** implement any real government connector, tax relevance engine, AI analysis, dashboard, municipal monitoring, or Redis/broker infrastructure.

## Runtime topology

The same repository builds three processes:

- API: `npm start`
- Collection Worker: `npm run start:worker`
- Scheduler: `npm run start:scheduler`

Worker and Scheduler must connect as `radar_worker_runtime`, which is a dedicated PostgreSQL login role that inherits only `radar_worker`.

## Connector boundary

A connector implements `CollectionConnector` and only returns canonical collection data. It does not write to PostgreSQL, decide tenant relevance, or own retry/deduplication policy.

The engine flow is:

```text
source
  -> connector
  -> normalized publication
  -> identity/content hashing
  -> transactional persistence
  -> global publication/version/origin history
```

## Identity and versioning

- `identity_hash`: publication/normative identity.
- `content_hash`: canonical content/version identity.
- `rawSha256`: optional attachment integrity hash supplied by the connector.

Strong identity requires scope + agency + act type + act number + publication date. When this basis is incomplete, identity is source-scoped using source + external ID (preferred) or official URL.

This is intentionally conservative. Similar weak-identity publications from different sources are never merged automatically.

Attachment references and integrity metadata are preserved in the publication version source metadata. Binary object storage is not introduced in this phase because no storage provider has been approved. The existing `publication_files` table remains available for a future storage integration.

## Run and attempt lifecycle

Run status uses the taxonomy already present in migrations 001–009. No parallel status model was introduced.

A connector timeout is preserved as `collection_attempts.status = TIMEOUT`. After retries are exhausted the run closes as `FETCH_FAILED`, because `collection_runs` intentionally has no `TIMEOUT` terminal status.

Every retry creates a new `collection_attempts` row. Backoff is finite and respects connector-provided retry-after metadata.

## Concurrency and recovery

PostgreSQL is the only coordination infrastructure.

Workers acquire eligible runs with:

```sql
FOR UPDATE OF collection_runs SKIP LOCKED
```

The run records worker ownership, lock time, heartbeat, and next retry time. A stale heartbeat allows another worker to recover the run. Any abandoned RUNNING attempt is closed as `CANCELLED` with error code `STALE_WORKER_HEARTBEAT`, preserving the historical attempt before the new worker starts the next attempt.

No Redis, RabbitMQ, Kafka, or external queue is required for the MVP.

## Scheduler

The scheduler evaluates each active source with a configured five-field cron expression and source timezone. Scheduling is idempotent through the existing unique key:

```text
(source_id, scheduled_for, trigger_type)
```

Running the same scheduler minute multiple times therefore does not duplicate runs.

## Operational monitoring

The engine preserves enough information to distinguish:

- not yet consulted;
- operational;
- unstable;
- unavailable.

Derived monitoring includes last run, last attempt, last success, duration, found/processed/new/existing/new-version/error counts, attempt count, and retry count. These indicators are derived from collection tables; they are not duplicated into `sources`.

### MON-01 — execução por fonte e indicadores de 24h

A rota autenticada `GET /api/v1/monitoring/runs` mantém os campos existentes e expõe também `discardedItems`, `retainedItems` e `processedItems` por execução da janela de 24 horas:

- **Encontradas** (`foundItems`): registros únicos do run em `collection_items`; para runs cujos itens foram retidos/limpos, o `found_count` de `collection_filter_discard_run_stats` pode preservar o mínimo conhecido;
- **Descartadas** (`discardedItems`): itens `FILTERED_OUT`; quando não há mais `collection_items` do run, usar `discard_count` da estatística, se a política RLS permitir;
- **Mantidas** (`retainedItems`): itens com status `PROCESSED_NEW`, `PROCESSED_EXISTING` e `NEW_VERSION` (não incluem falhas, itens descobertos mas pendentes ou descartados);
- **Processadas** (`processedItems`): soma de descartadas e mantidas, sem contar `FAILED`;
- **Importadas** (`importedDocuments`): apenas vínculos `collection_run_publications` com `NEW_PUBLICATION` ou `NEW_VERSION`, sem contar publicações já existentes.

A contagem agrega por `collection_run_id`, evitando duplicações por retry. A tabela de estatísticas tem leitura restrita a administrador global; usuários comuns contam por `collection_items`. A interface agrega esses números nos cards de 24h e mostra cada execução por fonte. Nenhuma migration ou mutação de dados é necessária.


## Mandatory simulated scenarios

Integration tests cover:

1. success with new publications;
2. success with no publications;
3. duplicate publication;
4. same identity with updated content;
5. timeout;
6. fetch error;
7. parser/processing error;
8. partial result;
9. initial failure followed by retry success;
10. retries exhausted.

Additional integration coverage includes scheduler idempotency, concurrent worker acquisition, stale worker recovery, attempt preservation, source operational metrics, cross-source strong identity, and weak-identity separation.

## DECISÕES PARA O GERENTE GERAL

- Migrations 001–009 remain unchanged.
- No migration 010 was required for Phase 3.
- Attempt-level `TIMEOUT` maps to terminal run `FETCH_FAILED` after retry exhaustion.
- PostgreSQL locking/heartbeat is the MVP coordination mechanism; no broker was added.
- Worker/Scheduler use a dedicated `radar_worker_runtime` login, separate from API `radar_app_runtime`.
- Collection remains global; no tenant ID was added to connectors/publications.
- Real federal/state connectors remain the next specialization step after Phase 3 acceptance.
- Attachment URLs/hash metadata are preserved now; object storage remains a future infrastructure decision.
