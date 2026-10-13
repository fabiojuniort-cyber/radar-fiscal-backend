# Hardening do Motor de Coleta

Esta frente trata três problemas operacionais do Motor. Nenhum deles altera a arquitetura: monólito modular, API/Worker/Scheduler separados, coordenação no PostgreSQL, runs separados de attempts, heartbeat/recovery, retry/backoff e dedup/versionamento continuam como estavam. A semântica de publicação também não muda.

1. **Checkpoint pesado dentro do histórico.** O estado incremental do SPED e do NF-e era gravado em `collection_attempts.metadata` a cada execução. Isso fazia o histórico crescer sem limite. Agora esse estado fica em `collection_checkpoints`.
2. **Execução longa sem saída graciosa.** Quando o tempo acabava, a execução terminava em hard timeout e o trabalho era perdido. Agora existe um orçamento de tempo com parada voluntária num ponto seguro.
3. **Sem visibilidade de armazenamento.** O volume de 500 MB se esgotou sem aviso. O WAL foi provavelmente um componente importante disso, mas não necessariamente a única causa. Agora há telemetria de capacidade e uma política de retenção de metadata.

## 1. `collection_checkpoints` (migration 012)

- Cada linha guarda uma geração do checkpoint de um par `(source_id, connector_key)`. O payload é JSONB e vem acompanhado de `payload_sha256` (calculado sobre o JSON canônico, com as chaves ordenadas), `payload_bytes`, `state_version` e do run e attempt que o produziram.
- **Retenção:** ficam a geração atual e mais 2 anteriores (`CHECKPOINT_GENERATIONS_KEPT = 3`). A limpeza das mais antigas acontece na mesma transação que grava a nova.
- **Concorrência:** a geração é alocada sob `pg_advisory_xact_lock(hashtextextended(source:connector, 0))`, na mesma transação que finaliza o attempt. Como garantia final, existe a constraint `UNIQUE (source_id, connector_key, generation)`.
- **Quando é gravado:** somente quando o conector retorna normalmente, com attempt SUCCESS. O attempt passa a guardar só um `checkpointRef` pequeno: `{id, generation, version, sha256, bytes}`.
- **Leitura (`readCurrentCheckpoint`):**
  - percorre as gerações retidas da mais nova para a mais antiga;
  - ignora gerações cujo run não tem status aceito, gerações de outra `state_version` e payloads com hash divergente.
  - Os status aceitos continuam os de antes: SPED aceita `SUCCESS`, `SUCCESS_NO_RESULTS` e `PARTIAL_SUCCESS`; NF-e aceita `SUCCESS` e `SUCCESS_NO_RESULTS`.
- **Transição (fallback legado):** se ainda não existe checkpoint aceitável na tabela, o leitor usa o estado legado (`metadata.spedState` ou `metadata.nfeEncatState`) do último attempt aceito. A primeira execução após o deploy lê esse estado legado, não refaz o crawl e grava a geração 1. A partir da segunda execução, a leitura vem direto da tabela.
- **Privilégios:** apenas `radar_worker` tem `SELECT, INSERT, DELETE`. Não há `UPDATE`, porque as gerações são imutáveis. `radar_app` (a API) não tem acesso a essa tabela.

## 2. Orçamento de tempo (budget/completion)

As duas partes do contrato são opcionais:

- `ConnectorExecutionContext.budget` (`ConnectorTimeBudget`) informa `deadlineAt` (o hard timeout), `softDeadlineAt`, `remainingMs()` e `shouldYield()`.
- `ConnectorResult.completion = { complete: false, reason: 'TIME_BUDGET_REACHED', pending }` indica que o conector parou num ponto seguro com trabalho pendente.
- `ConnectorResult.checkpoint = { version, state }` carrega o estado operacional, que o Motor grava em `collection_checkpoints`.

**Folga (grace):**

- O executor cria o budget com `softDeadline = timeout - grace`.
- A folga padrão é 15% do timeout, com mínimo de 2 min e máximo de metade do timeout. Com `COLLECTION_TIMEOUT_MS=1200000`, isso dá 180 s de folga, e o soft deadline cai aos 17 min.
- A variável opcional `COLLECTION_BUDGET_GRACE_MS` sobrescreve a folga. Ela precisa ser menor que o timeout; caso contrário, o worker não sobe.

**Semântica de uma parada voluntária:**

- O attempt termina **SUCCESS** e o run termina **PARTIAL_SUCCESS**.
- O `error_summary` começa com `TIME_BUDGET_REACHED (…pendências…)`.
- O checkpoint é salvo.
- Não há retry imediato (`next_attempt_at` fica nulo); a próxima execução agendada continua de onde parou.
- O hard timeout continua valendo para execuções realmente travadas. Nesse caso o attempt termina `TIMEOUT` e nenhum checkpoint é gravado.

Somente o SPED adota o budget por enquanto. Os demais conectores ignoram o campo e se comportam exatamente como antes.

### SPED: parada graciosa

- **Descoberta** (crawl e rechecks) usa no máximo 60% da janela até o soft deadline (`SPED_DISCOVERY_BUDGET_SHARE`). O restante fica reservado para baixar os arquivos do que foi descoberto. Assim, toda execução interrompida ainda emite documentos e a próxima avança, em vez de redescobrir as mesmas páginas.
- **Pontos seguros:**
  - antes de cada nova requisição de página;
  - antes de cada módulo;
  - antes de cada recheck (um recheck nunca é cortado pela metade);
  - antes de cada download.
- **Documento incompleto nunca é emitido.** Isso vale quando um arquivo novo não foi baixado ou quando ainda havia páginas de artefato vinculadas na fila. O documento fica *deferred*: a página volta a `UNKNOWN` e ele não gera versão artificial. Arquivos já provados pelo checkpoint anterior continuam resolvidos.
- **Retomada:** o checkpoint guarda `cycle = { completedModules, frontier }`.
  - A execução seguinte parte da fronteira: páginas não visitadas e documentos deferred.
  - Ela não recomeça das seeds dos módulos que já foram concluídos no ciclo.
  - Quando uma execução termina sem ceder, o `cycle` é removido e a próxima faz um ciclo completo normal.
  - A fronteira é limitada a `SPED_MAX_FRONTIER = 5000` entradas.
- `SPED_ALL_MODULES_FAILED` continua sendo lançado quando nenhuma seed responde numa execução completa. Após uma parada voluntária ou numa retomada, a execução só é tratada como fonte indisponível se algo foi tentado e nada respondeu.
- `metadata.sped.deferredDocuments` passa a ser uma amostra de no máximo 50 itens. `deferredDocumentCount` continua exato.

### NF-e

O NF-e passa a devolver `checkpoint` (`NFE_ENCAT_STATE_VERSION = 1`) em vez de `metadata.nfeEncatState`. Ele não adota budget: o volume é pequeno e o comportamento é idempotente, como antes.

## 3. Retenção de metadata (D3)

Comando: `npm run db:prune-collection-metadata -- [--apply] [--older-than-days=30] [--batch-size=100] [--max-batches=N]`

- **Dry-run por padrão.** Sem `--apply`, nada é gravado. O relatório (`COLLECTION_METADATA_PRUNE=…`) mostra por chave e por conector quantos attempts seriam afetados, os bytes antes e depois e uma amostra de ids.
- **Escopo:** somente attempts finalizados há mais de 30 dias. As chaves conhecidas removidas são:
  - `spedState` e `nfeEncatState`, somente se a fonte já tem uma linha em `collection_checkpoints`;
  - `sped.identityAudit`, substituída por `sped.identityAuditCounts`;
  - `sped.deferredDocuments`.
- **Preservado sempre:** status, timestamps, duração, número do attempt, erro e summary, contadores (`publicationCount`, `partialFailureCount`, `*Count`, `moduleResults`), `completion` e `checkpointRef`. O attempt recebe a marca `metadataPruned {at, keys}`.
- **Nunca apaga attempt.** O processamento é em lotes, com paginação por keyset e uma transação curta por lote. A operação é idempotente.
- Roda com a URL de menor privilégio disponível (`DATABASE_URL`, que é o papel do worker).
- Depois da primeira execução manual validada, o comando pode entrar no Scheduler com frequência diária. Isso ainda não está ativado.

## 4. Telemetria de capacidade (migration 013)

- A tabela `db_capacity_snapshots` guarda:
  - `db_bytes`;
  - `wal_bytes` (nulo quando não é observável), junto com `wal_estimate_basis`;
  - `estimated_pg_bytes`, `capacity_bytes` e `estimated_used_ratio`;
  - `platform_volume_used_bytes`, reservado e nulo por enquanto;
  - `top_tables` (as 10 maiores);
  - `attempts_rows`, `publications_rows` e `alert_level`.
- Isso é uma **estimativa** do que o PostgreSQL ocupa. A métrica autoritativa de volume cheio é a da plataforma.
- **WAL:** `pg_ls_waldir()` exige `pg_monitor`. **Esse privilégio nunca é concedido aos papéis de runtime.**
  - Com `DATABASE_MONITOR_URL` configurada, apontando para um papel de monitoramento dedicado, o WAL é medido (`MEASURED`).
  - Sem ela, `wal_bytes` fica NULL e a estimativa soma `max_wal_size` como folga conservadora (`MAX_WAL_SIZE`).
- **Alertas:** `WARNING` a partir de 70%, `CRITICAL` a partir de 85% e `UNKNOWN` quando `DB_VOLUME_CAPACITY_BYTES` não está definida. Cada snapshot gera um log estruturado com `event=db_capacity_snapshot` e `alertCode` (`DB_CAPACITY_WARNING` / `DB_CAPACITY_CRITICAL`), no nível warn ou error conforme o alerta.
- **Scheduler:** tira um snapshot por hora (`CAPACITY_SNAPSHOT_INTERVAL_MS`, padrão 3600000). A decisão é tomada sob advisory lock, o que torna o processo seguro com mais de um scheduler. Uma falha nele nunca afeta a criação de runs. Para desligar: `CAPACITY_SNAPSHOTS_ENABLED=false`.
- **Manual:** `npm run db:capacity-report -- [--no-insert]` (`DB_CAPACITY_REPORT=…`).
- A retenção dos snapshots (cerca de 13 meses) fica para depois; o volume é de aproximadamente 9 mil linhas por ano.
- `max_wal_size` continua em 1 GB, sem `ALTER SYSTEM`. Ele é uma meta de checkpoint, não um limite rígido.

## Variáveis novas (todas opcionais)

| Variável | Serviço | Padrão |
|---|---|---|
| `COLLECTION_BUDGET_GRACE_MS` | worker | 15% do timeout (mín. 2 min, máx. metade) |
| `DB_VOLUME_CAPACITY_BYTES` | scheduler | ausente, o que gera alerta `UNKNOWN` |
| `DATABASE_MONITOR_URL` | scheduler | ausente, e o WAL não é medido |
| `CAPACITY_SNAPSHOT_INTERVAL_MS` | scheduler | 3600000 |
| `CAPACITY_SNAPSHOTS_ENABLED` | scheduler | true |

## Verificação de privilégios

- `db:verify-worker-runtime` passa a exigir `SELECT/INSERT/DELETE` (e nenhum `UPDATE`) em `collection_checkpoints` e `SELECT/INSERT` (e nenhum `UPDATE/DELETE`) em `db_capacity_snapshots`. Também exige que o papel **não** seja membro de `pg_monitor` nem de `pg_read_all_stats`.
- `db:verify-runtime` (API) exige que a API **não** tenha acesso a nenhuma das duas tabelas e não seja membro de `pg_monitor`.

## Gates pós-merge

Ferramenta: `npm run db:gate-hardening -- …` (usa `DATABASE_URL`, papel do worker):

- `inspect [--since=ISO]` — checkpoints de SPED/NF-e com verificação do SHA-256, gerações, últimos runs (status, `completion`, `checkpointRef`, se ainda há estado legado) e totais de publicações/versões/origens.
- `run <sped|nfe-encat> [--timeout-ms=N] [--grace-ms=N]` — executa **um** run controlado pelo Motor real neste processo. O run já nasce pertencendo ao gate (RUNNING, worker id próprio, heartbeat mantido), então os workers de produção não o pegam e o `COLLECTION_TIMEOUT_MS` deles não muda. Uma tentativa, sem retry. Imprime o delta de publicações/versões/origens.
- `hang <sped|nfe-encat> [--timeout-ms=60000]` — conector que nunca retorna, para provar o hard timeout (attempt `TIMEOUT`, nenhum checkpoint gravado).

O gate 6 roda como `run sped --timeout-ms=300000 --grace-ms=270000`, com os mesmos valores do worker temporário previsto, sem expor os outros conectores a um timeout de 5 min.

1. SPED lê o checkpoint legado e migra para a tabela sem recrawl indevido.
2. NF-e faz o mesmo.
3. A segunda execução lê de `collection_checkpoints`.
4. SPED mantém 0 versões artificiais.
5. NF-e continua idempotente.
6. Um teste controlado de budget termina em `PARTIAL_SUCCESS/TIME_BUDGET_REACHED`, por exemplo um worker temporário com `COLLECTION_TIMEOUT_MS=300000` e `COLLECTION_BUDGET_GRACE_MS=270000`.
7. A execução seguinte continua corretamente.
8. O hard timeout ainda funciona para um travamento real.
9. O dry-run do prune mostra exatamente o que removeria.
10. O snapshot de capacidade é criado corretamente.
11. Nenhum privilégio desnecessário foi concedido à API ou ao Worker.
