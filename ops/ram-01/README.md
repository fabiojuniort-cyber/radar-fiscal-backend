# RAM-01 — diagnóstico PostgreSQL 18, somente leitura

Issue: [tribusca-control#76](https://github.com/fabiojuniort-cyber/tribusca-control/issues/76).
Risco R3; este PR é **preparação**, não autorização automática de execução.
Escopo exclusivo `ops/ram-01/`; sem coletores/DOU (#72–#74), migrations,
alteração de aplicação, parâmetros do PostgreSQL, pool, limites ou exclusões.

## Estado e objetivo

Preparado: script e testes offline. Executado/validado em produção: **NÃO**.
Base de preparação: `0908ca2039951157aeca592786b30a8b5a15d422`.
Não mergear em `main`: o backend executa `db:prepare` no predeploy.
O PR pode ser revisado e seu SHA exato usado por runner isolado após gate.

Baseline Railway observado em 05/10/2026: Postgres média24h 1,329 GB / pico
2,687 GB; média7d 1,257 GB / pico 2,722 GB. Métricas agregadas não permitem
atribuir o pico a uma consulta ou distinguir vazamento/cache do kernel.
Volume observado: 100000 MB. O alerta de capacidade com denominador 5 GiB
é outro achado (disco/monitoramento), não explicação de RAM; não é alterado aqui.

## Segurança e limites

- Uma conexão `pg.Client`; dois snapshots, separados por 15 segundos **fora**
  de transação. Cada snapshot abre `BEGIN READ ONLY` e termina `ROLLBACK`.
- Startup força `default_transaction_read_only=on`, `search_path=pg_catalog`,
  statement timeout 3 s, lock timeout 500 ms, idle transaction timeout 5 s.
  Cliente: conexão/query 5 s; deadline do processo 120 s. Sem retry automático.
- Consultas fixas de catálogos/estatísticas: settings allowlisted, atividade,
  banco, top20 relações/índices, locks, checkpoints, bgwriter, WAL, arquivamento
  e retenção agregada por slots. Sem varrer linhas de tabelas da aplicação.
- `pg_stat_statements(false)` somente se já instalado no schema `public`:
  métricas agregadas do banco corrente, sem texto/queryid/userid. Falha dessa
  consulta opcional fica `NOT_PROVEN`; não instala extensão nem concede acesso.
- Sem SQL externo/dinâmico, `SHOW ALL`, arquivos, alteração de role,
  logs SQL, dados de tenant, IP, usuário, nome arbitrário de aplicação/relação,
  URL, credencial ou erros brutos. Saída tem tipos/colunas allowlisted e teto
  de 192 KiB. Desconhecidos recebem `other`; nulos permanecem nulos.
- Desconexão/timeout aborta a transação. A leitura incrementa estatísticas e
  pode aquecer caches de metadados; não é uma medição de impacto zero.
- Não mede memória residente de cada backend nem cache de SO. Não soma RSS
  dos processos (memória compartilhada seria contada várias vezes).

## Testes e dry-run (sem banco / sem segredos)

```sh
node --check ops/ram-01/diagnose.mjs
node --test ops/ram-01/diagnose.test.mjs
node ops/ram-01/diagnose.mjs --dry-run
```

Em executor que proíbe subprocessos, usar o runner nativo em processo único:
`node --test --test-isolation=none ops/ram-01/diagnose.test.mjs`.
Isso não altera testes/gates nem executa banco; registrar essa variante na evidência.

Dry-run somente imprime o plano SQL estático e limites. Não importa `pg`, não
conecta e não prova sintaxe/compatibilidade de um servidor real. Os testes usam
cliente falso e credencial sintética; não são integração PostgreSQL. Runtime
precisa Node24 e `pg` do `package-lock.json` existente. Não adicionar dependência.

## Gate de execução — obrigatório antes de criar/deployar runner

1. Revisão independente do **SHA exato** contendo estes três arquivos; registrar
   resultado/testes em #76. Mudança do script/runbook exige recheck do novo SHA.
2. Revalidar autorização explícita de execução, registrar lease/LOCK específico
   `tmp-ram-01-readonly` com início/fim e executor. O LOCK de preparação não é
   LOCK produtivo. Não executar se existir concorrência ou autorização incerta.
3. Confirmar PostgreSQL18 e IDs abaixo; revalidar saúde, deploys, memória 1h/24h,
   erros recentes e tráfego de API/sites. Reconciliar staged changes **vazios**.
   Nunca aplicar alterações de outra frente. Se há staged changes, parar.
4. Preparar serviço novo isolado por operações staged, inspecionar configuração
   efetiva antes de aceitar deploy; se conector iniciar deploy prematuramente,
   não conectar fonte/credencial até garantir gates e configuração segura.
5. Registrar IDs do runner, reviewed SHA, configuração sem valores secretos,
   planos de reversão e postchecks na Issue. Não usar Railway AI Agent.

### Configuração exata a preparar (não é comando para execução automática)

Projeto: `d7291d78-020d-42d5-8cd9-c387a156a580`.
Ambiente: `c6963775-4b79-4ef7-a82e-0435b8c39102`.
Postgres existente: `1982a72c-5270-4c06-9b5e-95a07047a04d`.
Nome do serviço **novo**: `tmp-ram-01-readonly`.

- Fonte backend, branch `ops/ram-01-postgres-readonly`, pin no SHA revisado.
- Build explícito `npm ci --omit=dev --ignore-scripts` (usa lock existente;
  nenhuma migration/build da aplicação; o script importa apenas `pg`).
- Start: `node ops/ram-01/diagnose.mjs --execute`.
- Predeploy vazio; sem healthcheck HTTP, domínio, TCP proxy, volume ou cron.
- Uma réplica em sfo; restart **NEVER**; sem deploy automático de main.
- O serviço finito não recebe novas permissões globais nem links a tenants.
- Variáveis exclusivas: `RAM01_EXECUTE=READ_ONLY_REVIEWED_76`,
  `RAM01_REVIEWED_SHA=<SHA revisado>`,
  `RAM01_DATABASE_URL=${{Postgres.DATABASE_URL}}`,
  `RAM01_EXPECTED_HOST=${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`.
  São referências resolvidas **dentro da Railway**, nunca copiar valor literal.
- O executor deve validar pelo canal de infraestrutura que as referências
  apontam ao Postgres exato acima. Se esse mapeamento não for comprovável, parar.
  Usar credencial de monitoramento read-only já disponível se houver; não criar
  roles/grants neste ciclo. Se usar referência administrativa existente do
  Postgres, registrar essa limitação e incluí-la na revisão/gate de execução.
- `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_NAME` e
  `RAILWAY_GIT_COMMIT_SHA` são metadados Railway, não forjar para passar gates.
  URL deve ser privada, host igual à referência esperada, porta5432, sem query
  ou fragmento. Divergência causa recusa; não afrouxar gate em produção.

**Não reutilizar outro runner**, principal ou temporário protegido. Preservar
Postgres/PITR/volumes/API/Worker/Scheduler, `web05-preview` e
`tribusca-site-prototype` (**PRD/CORE confirmado por Fábio**). Preservar validators
até provar papel/dependências; preservar #4/#17/#61 e `doe-sp-31-backup`.

## Execução supervisionada e reversão

Após gates, aceitar exclusivamente o delta do runner, observar uma execução
finita e coletar somente linhas `scope=ram-01` sanitizadas. Não publicar logs
brutos de infraestrutura. Sucesso requer `READ_ONLY_COMPLETED`, dois snapshots,
`read_only/default_read_only=true` e conexão encerrada. `NOT_PROVEN` permanece
limitação explícita, não vira zero. Falha não autoriza retry/redeploy automático.

Abortar por alvo/versão/SHA divergente, erro inesperado, deadline, saúde core
degradada ou saída suspeita. Parar apenas o runner novo; não matar sessões de
terceiros. Após término, confirmar running=0 e remover/neutralizar somente as
referências do runner sem novo deploy; confirmar ausência de restart.
Reversão: encerrar o runner e retirar referências. Não há mudança de banco para
reverter. Backup/restore de dados não se aplica à leitura pura; PITR permanece
intocado. Remoção do runner é operação separada com prova e gate próprios; na
ausência deles, deixar serviço inerte, sem credencial resolvível, não deletar.

## Pós-verificação e interpretação

- Revalidar inventário/staged changes, saúde e erros dos seis serviços core,
  tráfego/status de API/site/PRD, progresso Worker/Scheduler sem alterar jobs.
- Registrar start/end UTC, SHA/deployment e memória Railway 1h/24h. Separar
  memória do runner da memória Postgres. Não alegar economia: isto é diagnóstico.
- Comparar contadores das duas amostras somente se `stats_reset_epoch` e
  `server_started_epoch` não mudarem. Intervalo real inclui duração das queries;
  duas amostras curtas não representam carga 24h nem demonstram causalidade.
- `blks_hit` é cache PostgreSQL; uma leitura pode vir do cache do SO. SQL não
  discrimina cache de kernel/RSS/anon do container. Precisaria telemetria SO
  permitida em outra etapa; não inferir decomposição exata destes resultados.
- `shared_buffers/shared_memory_size` explicam memória compartilhada; não
  somá-las cegamente. `effective_cache_size` é estimativa do planner, não alocação.
  `work_mem` vale por operação/worker, não por conexão e não é pré-reserva;
  `autovacuum_work_mem=-1` herda maintenance_work_mem.
- Atividade agrupa somente nomes allowlisted; `unset/other_named` não permitem
  atribuir conexões a API/Worker/prototype. Não inventar atribuição. Pools efetivos
  de outros papéis também não são provados pelo pg_settings deste runner.
- Configuração cumulativa/índices/dead tuples e picos são indícios, não prova de
  leak/bloat. Consultas caras/picos podem ocorrer fora das duas amostras.
- Próximo delta só após evidência: ajuste de pool/memória/observabilidade requer
  análise de carga, rollback e revisão próprios; sem reduzir RAM às cegas.

Referências primárias consultadas para PG18 e cliente:
- https://www.postgresql.org/docs/18/monitoring-stats.html
- https://www.postgresql.org/docs/18/runtime-config-resource.html
- https://www.postgresql.org/docs/18/pgstatstatements.html
- https://node-postgres.com/apis/client
