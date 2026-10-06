# DOU-CLEAN-02 — runner pós-deploy de uma publicação

**Preparado localmente; não executado em produção.** Overlay proposto para
`radar-fiscal-backend`, a partir de `068506811ae4c0a257816c38e899e3a1dccb0fb8`.
Este pacote não autoriza merge, deploy, SQL produtivo, encerramento da Issue #84
ou limpeza histórica. A execução futura é R3: artefato exato revisado, LOCK,
autorização vigente, CI e validação PostgreSQL 18 isolada. O harness de fixtures
abaixo é separado do smoke HTTP produtivo; não se deve usar o runner produtivo
apontando a uma restauração enquanto sua URL HTTP continua em produção.

## Arquivos e implantação proposta

- `postdeploy-smoke.sh`: Bash + psql/jq/curl/coreutils/util-linux; sem Node/Python.
- `sql/`: apenas leituras, locks do alvo e chamadas do procedimento governado.
- `Dockerfile`: adiciona `curl` e chmod do novo script; preserva o CMD de
  `backup-restore.sh`. É overlay para o repo completo, não uma imagem independente.
- `test-static.sh`: checks offline; não conecta a nenhum serviço.
- `test-recovery-control.sh`: executa as funções reais de controle com DB mockado.
- `test-pg18-isolated.sh` e `tests/`: rehearsal SQL em container PG18 sem rede,
  somente fixtures sintéticas e socket Unix; nunca chamam o HTTP produtivo.
- `.github/workflows/ci.yml`: step offline obrigatório, sem ambiente/segredos herdados;
  job PG18 separado com fixtures e privilégios mínimos, sem credenciais de aplicação.

O runner existente `dou-clean-02-backup-restore` pode usar esse overlay após
revisão/autorização específicas. Não alterar automaticamente seu comando, suas
variáveis ou seu deploy. Manter sem domínio, sem pre-deploy/migration, restart
`NEVER`, volume privado `/data`, credencial administrativa por referência Railway.
Comando futuro explícito: `/opt/dou-clean-02/runner/postdeploy-smoke.sh`.
O modo padrão é desabilitado; o Dockerfile continua iniciando o backup existente.

## Seleção conservadora automática

Uma única publicação, nunca lote, deve satisfazer:

- `IN_SCOPE`, não oculta, exatamente uma versão atual, origem e feed;
- zero company links/matches e zero scope events/state anteriores;
- zero collection/taxonomy runs globais `PENDING`/`RUNNING` naquele instante;
- pelo menos um arquivo e uma linha de histórico de coleta, para provas não vazias;
- presença garantida no top-20 real de v1 para um `source` observado, incluindo
  toda a faixa empatada no limite; só depois do ranking se aplicam os filtros;
- presença confirmada na resposta HTTP inicial, mesma URL nas três fases.

Há preferência por fonte DOU. Se não houver candidato, aborta antes de qualquer
SUPPRESS. Esses filtros técnicos não provam dispensabilidade comercial por si:
`CONTROLLED_SELECTION_APPROVED=true` atesta autorização explícita da política
de seleção acima. O script não cria fixture, usuário, sessão ou token.

## Entradas para execução futura autorizada

Não inserir valores de conexão/UUID/segredos em logs, comandos de diagnóstico,
Issue, PR ou resposta. Configurar por interface privada/referências Railway.

| Variável | Valor/contrato |
|---|---|
| `MODE` | `smoke` ou `restore-only`; ausente desabilita |
| `MODE=preflight` | somente preflight/grants/candidato/snapshot READ ONLY; imprime agregados e hash do ID público, sem ledger ou conteúdo |
| `SMOKE_CANDIDATE_SHA256` | opcional: SHA-256 de UUID público já observado no Acervo; fixa o candidato sem relaxar nenhum filtro |
| `UI_OBSERVATION_WINDOW` | `enabled` exige candidato fixado por hash; abre janela visual de até 40s, dentro do orçamento 60s, com RESTORE automático |
| `PROD_DATABASE_ADMIN_URL` | Referência privada existente; nunca impressa ou passada no argv do psql |
| `RAILWAY_VOLUME_MOUNT_PATH` | `/data`, mount real exigido |
| `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` | Presença de contexto Railway |
| `CONFIRM_DOU_CLEAN_02` | `SUPPRESS_ONE_AND_RESTORE` para smoke |
| `CONTROLLED_SELECTION_APPROVED` | `true` |
| `R3_APPROVAL_SHA256` | SHA-256 do registro privado de autorização/evidências |
| `RUNNER_SHA` | SHA de 40 hex revisado, igual a `RAILWAY_GIT_COMMIT_SHA` |
| `BACKEND_DEPLOYED_SHA`, `WORKER_DEPLOYED_SHA`, `SCHEDULER_DEPLOYED_SHA` | Exatamente o backend SHA acima |
| `BACKUP_RESTORE_VERIFIED`, `R3_LOCK_VERIFIED` | `true` |
| `NO_HISTORICAL_BATCH_VERIFIED`, `WORKER_NCM_DISABLED_VERIFIED` | `true` |

Esses campos são **atestados do operador**, não descoberta automática de CI,
deploy, backup, revisão, LOCK ou da flag NCM. O runner não acessa Railway API.
O banco é validado como PostgreSQL 18, usuário administrativo com visão não
filtrada, migrations 033/034/035 de checksum conhecido e grants restritos.
O gate de privilégios considera os runtimes identificados por memberships
explícitos e **todas** as roles assumíveis via `pg_has_role(..., 'SET')`, mesmo
`NOINHERIT`. Nega atributos SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION,
EXECUTE/ownership das duas funções governadas e DML/ownership/grants de escrita
de tabela ou coluna nos três ledgers, incluindo PUBLIC e roles assumíveis.
Também nega SELECT bruto de tabela/coluna nesses ledgers, leitura de
publication_id/publication_version_id/detected_at do histórico pelo app e
EXECUTE indevido da fronteira de curadoria e de imported_today. Verifica os
grants positivos dos predicados/epoch para app/worker, do agregado para app e
da fronteira para curator, e nega EXECUTE PUBLIC das cinco funções estreitas.
Também rejeita ownership assumível do database ou schema `public`, que permitiria
DDL destrutivo indireto mesmo sem ownership individual dos ledgers.

## Segurança, journal e recuperação

Diretório fixo `/data/dou-clean-02-postdeploy-smoke`, proprietário atual e modo
700, sem symlink. Journal `journal.json` em 600, criado antes do SUPPRESS por
arquivo temporário + flush + rename + flush; `flock` impede dupla execução nesse
volume. Nova execução smoke recusa journal existente, mesmo concluído. Reter e
revisar evidências antes de qualquer arquivamento manual; o script não as apaga.

O preflight não cria journal nem arma recuperação; ele escreve evidências
privadas no volume e só executa SQL READ ONLY. Para prova visual autenticada,
o operador usa a sessão já aberta no produto, sem extrair cookie/token nem
criar usuário. Aquecer antes as mesmas buscas, filtros, navegação e detalhe
do ID público correspondente ao hash; durante a janela observar a ausência
e após RESTORE observar a volta. O runner não promove essas observações a
PASS automaticamente: devem ser verificadas e registradas separadamente.
Se a janela visual expirar, ele restaura automaticamente e continua as provas.

O journal contém candidato/UUIDs privados, operações distintas SUPPRESS/RESTORE,
hashes, identidade do banco (system_identifier + database), baseline de hashes,
contagens, epoch, RLS e feed. O conteúdo canônico é serializado/hashado **dentro
do PostgreSQL**, não exportado. Respostas HTTP públicas e identificadores ficam
em arquivos privados do volume; stdout contém somente status, hashes e contagens.
Erros crus psql/curl são descartados. Não usar shell tracing ou imprimir o ambiente.

Após o journal durável, EXIT/INT/TERM/HUP tentam compensação. Um COMMIT sem
resposta é reconciliado pelo operation_id persistido, não por um event_id só em
memória. RESTORE usa exclusivamente o próprio SUPPRESS atual como optimistic
lock. Outro evento atual nunca é sobrescrito. A recuperação usa SQL mínimo sem
dependência de estatísticas/API/fingerprints; verifica read-back, não apenas exit0.
Antes de qualquer confirmação de IN_SCOPE/no-op, ela adquire `FOR UPDATE` na
publicação em uma transação READ COMMITTED; **outro statement após o lock** lê
o estado. Assim uma transição sem ack que ainda detém o lock precisa terminar
antes da decisão. Lock timeout/erro/falta do alvo resulta em NOT_CONFIRMED, nunca
em confirmação baseada no snapshot anterior. O barrier é feito antes e depois
da tentativa compensatória; não executa DML.

SIGKILL, queda do container, disco/rede/banco indisponíveis não podem ser
resolvidos por trap. **Não existe garantia de restauração enquanto o banco estiver
inacessível.** Reter o volume e acionar imediatamente, no mesmo serviço/banco:

```text
MODE=restore-only
CONFIRM_DOU_CLEAN_02=RESTORE_JOURNALED_TARGET
```

Esse modo não exige atestados smoke antigos e nunca seleciona/suprime outro alvo.
Compara journal/hash/identidade do banco, restaura primeiro e valida depois.
Se já IN_SCOPE por evento externo, não força novo evento; provas completas podem
continuar falhando, corretamente. Se SUPPRESS jamais commitou, recuperação é no-op.
Um evento concorrente OUT_OF_SCOPE de outra operação exige intervenção governada.

Existe orçamento de 60 segundos para trabalho de verificação após iniciar
SUPPRESS; comandos recebem o restante, timeout psql global máximo 25s, timeout
SQL 15s/lock 3s, HTTP máximo 12s sem retry. A compensação tem orçamento próprio:
**60s não é limite absoluto de invisibilidade**. Não há pausa global de DML,
cron/Worker, batch histórico, hard-delete, alteração de grant ou bypass de RLS.

## Provas obrigatórias para o marcador público PASS

1. Baseline HTTP v1 list/stats e v2 stats igual às contagens SQL; sem aceitar cache
   global já stale por ingestão anterior. Erro/discrepância aborta antes do SUPPRESS.
2. SUPPRESS único e governado; replay idempotente sem segundo evento/epoch.
3. Predicate false, feed vazio e coerente com `publication_source_feed_expected`.
4. Sob `SET LOCAL ROLE radar_app`, leituras diretas publication/version/origin/file
   retornam zero. Arquivos usam IDs de versão salvos antes, não join escondendo
   indevidamente a consulta. Histórico agregado permitido continua idêntico.
5. Roles comuns, descendentes e roles assumíveis via SET ROLE continuam sem
   transição/material-restore, ownership ou escrita nos ledgers, inclusive PUBLIC.
6. Primeira resposta das mesmas URLs, sem cache-buster, retry ou request
   `Cache-Control`, confirma ausência no v1 e totais -1 em v1/v2. v1 exige header
   epoch e `max-age=0, no-cache, must-revalidate`. **v2 neste SHA não emite header
   epoch**: valida-se cache interno por contagens e DB epoch antes/depois do HTTP.
7. SHA-256 + counts para canonical e todos os descendentes FK alcançáveis,
   versões, origens, arquivos, NCM, taxonomia, scans/tags sem FK, candidatos
   taxonômicos vinculados, collection items/history e importedDocuments por run.
8. RESTORE próprio, reaparecimento no v1, feed semântico idêntico, fingerprints e
   contagens/RLS iguais, SUPPRESS preservado, dois eventos e epoch baseline+2.
9. Estado final `IN_SCOPE`, zero OUT_OF_SCOPE global, reconciliação pós-API.

Um refresh legítimo de coleta/derivados, mudança de data BRT ou operação concorrente
pode causar falha conservadora. Não “corrigir” baseline, avançar epoch artificialmente,
trocar o alvo depois de falha ou rodar coleta/enriquecimento para forçar PASS.

`DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS` é **somente o escopo público acima**, não o
fechamento da Issue #84. Archive/detail/facets/navigation autenticados ficam
`NOT_PROVEN`, pois não se cria conta/sessão e não se copia JWT secret. Corrida
adversarial in-flight dos workers também fica `NOT_PROVEN`: este runner não inicia
jobs nem substitui testes de concorrência da implementação. Ele apenas exige
quiescência observada e preservação dos derivados durante o round-trip.

## Validação local feita / restante

Executado localmente: `bash -n`, checks estáticos e funções de recuperação com
mocks (`bash .../runner/test-static.sh`) — PASS.
Revisão read-only contra runbook, migrations e rotas do SHA fixado; revisão separada
dos contratos API/SQL. Nenhum SQL/HTTP produtivo, deploy, variável ou write GitHub.

**Ainda não executado nesta preparação:** integração real PostgreSQL 18 e
fault-injection de processo/rede/durabilidade. `test-pg18-isolated.sh` prepara
fixtures sintéticas, roda os SQLs reais de transição/recuperação/privilégios e
valida nominal, COMMIT concorrente sem ack, lock timeout e grants inseguros.
O container usa `--network none`, sem portas, conexão apenas por socket Unix,
imagem PG18 local (`--pull=never`) e não recebe credenciais produtivas.
Isso torna a prova SQL reproduzível sem depender da BASE_URL fixa de produção.
O job PG18 proposto no CI primeiro obtém a imagem oficial `postgres:18-bookworm`
(único passo de provisionamento com rede); depois executa o harness com ambiente
limpo e container `--network none`. O step estático não acessa rede. Nenhum desses
jobs foi disparado nesta preparação e a suíte existente em PostgreSQL 16 é preservada.

O runner `postdeploy-smoke.sh` continua **production-only**, com BASE_URL fixa e
MODE=rehearsal recusado. O harness não o chama nem exercita suas rotas HTTP.
Portanto o rehearsal SQL não comprova API/cache nem crash/durabilidade do runner
inteiro. Smoke público, erro HTTP após SUPPRESS, TERM/KILL seguido de restore-only,
ausência de candidato e journal adulterado continuam gates separados. Um futuro
rehearsal end-to-end requer backend e banco ambos isolados e artefato dedicado
revisado; nunca combinar banco isolado e endpoint produtivo. Não encerrar o gate
R3 com base apenas nos checks estáticos/mocks ou na existência do harness.
