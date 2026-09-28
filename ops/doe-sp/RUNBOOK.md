# DOE-SP — reconstrução restrita do acervo (D-052)

Estado: **PREPARADO (DOE-SP-31)**, aguardando revisão independente deste
diretório no SHA registrado na Issue #1. Nada aqui autoriza, por si só, pausa,
exclusão, merge, deploy ou recaptura.

Governança: [Issue #1](https://github.com/fabiojuniort-cyber/tribusca-control/issues/1),
D-017/D-036/D-052 no `tribusca-control`. Código: PR #73.

## 1. Objetivo e escopo

Reconstruir **somente** o acervo DOE-SP sob page-first (HTML oficial canônico,
PDF autenticado apenas quando material, anexos materiais obrigatórios), sem a
camada de compatibilidade v1→v2. Janela de recaptura: **01/01/2025 a
27/09/2026, inclusive, BRT**. A partir daí, o incremental cobre as datas seguintes.

Escopo = publicações com pelo menos uma origem da fonte `doe-sp`. Qualquer
publicação com origem de outra fonte, vínculo de empresa/tenant/match,
link de run ou item de outra fonte **aborta** o processo.

## 2. Preservação (reconstrução que preserva IDs)

| Objeto | Tratamento | Motivo |
|---|---|---|
| `publications` (linhas e `id`) | **mantidas** | IDs públicos (API #74) e `collection_items.publication_id` continuam válidos; a recaptura reencontra a linha pelo `identity_hash` |
| `publication_versions` do escopo | apagadas | remove hashes v1 com PDF redundante |
| `publication_files` do escopo | apagadas (cascade das versões) | idem |
| `publication_origins` da fonte `doe-sp` | apagadas | a metadata v1 de origem carregaria evidência antiga; a recaptura recria as origens |
| `collection_run_publications` | **mantidas**, `publication_version_id := NULL` | preserva o histórico run↔publicação |
| `collection_runs`, `collection_attempts`, `collection_items` | **mantidas** | histórico operacional |
| `collection_checkpoints` do conector `doe-sp` | apagados | o próximo run faz bootstrap desde `DOE_SP_BOOTSTRAP_START_DATE` |
| `sources` (`doe-sp`) | mantida; `is_active` alternado pela pausa/retomada | — |
| demais fontes | intocadas; totais globais verificados dentro da transação | — |

Na recaptura, a primeira versão de cada publicação preservada é registrada
como `NEW_VERSION` (a publicação já existia), com `version_no = 1`. Se a
identidade de um ato mudar, surge uma publicação nova e a antiga fica sem
origem ou versão; `41` conta esses casos (`publicationsWithoutVersionOrOrigin`)
e eles vão para um gate próprio. Não há exclusão automática.

Durante a janela entre `30` e o fim da recaptura, a API pública lista as
publicações DOE-SP preservadas sem texto de versão e com contagem por fonte
reduzida. Esse efeito é esperado e deve ser comunicado.

## 3. Arquivos

| Arquivo | Tipo | Onde roda |
|---|---|---|
| `sql/00_assert_read_only.sql` | guarda | incluído pelos read-only |
| `sql/10_preflight_readonly.sql` | agregados publicáveis | produção (RO), restauração |
| `sql/11_private_manifest_readonly.sql` | **manifesto identificável** | produção (RO) → volume Railway |
| `sql/12_table_counts_readonly.sql` | contagem exata de todas as tabelas | produção (RO), restauração |
| `sql/20_dry_run_readonly.sql` | contagens esperadas por tabela, bloqueadores e argumentos de `30` | produção (RO) |
| `sql/25_pause_source.sql` | escrita: `is_active=false` | produção (gate futuro) |
| `sql/30_rebuild_destructive.sql` | **destrutivo, transação única** | produção (gate futuro) |
| `sql/40_post_rebuild_validation.sql` | validação pós-`30` | produção (RO) |
| `sql/50_resume_source.sql` | escrita: `is_active=true` | produção (gate futuro) |
| `sql/41_post_recapture_validation.sql` | validação da recaptura | produção (RO) |
| `sql/60_rollback_import.sql` | rollback após COMMIT (reimporta linhas originais) | produção (só em incidente) |
| `runner/prep.sh` | orquestra DOE-SP-31 (preflight, backup, restauração e ensaio) | serviço temporário Railway |
| `runner/rollback-stage.sh` | prepara o `schema doe_sp_rollback` a partir do backup | Railway |
| `runner/Dockerfile` | `postgres:18` + `jq` | Railway |

## 4. Garantias do script destrutivo (`30`)

- Uma transação `SERIALIZABLE`, com `LOCK` em `sources` e nas tabelas do
  escopo: Scheduler/Worker não reivindicam run DOE-SP nem gravam no escopo
  durante a execução.
- Guardas: fonte pausada; zero runs `PENDING/RUNNING`; zero origens de outra
  fonte; zero `company_publications`; zero links de run estrangeiros; nenhuma
  FK desconhecida apontando para `publications`/`publication_versions`
  (proteção contra desvio de esquema).
- As contagens esperadas do dry-run (`-v expected_*`) são comparadas com o
  escopo vivo **antes** de qualquer escrita, e cada `UPDATE/DELETE` confere
  o próprio número de linhas.
- Pós-condições dentro da mesma transação: totais globais = antes − apagados,
  demais tabelas inalteradas e escopo sem versões.
- Sem `-v confirm=REBUILD_DOE_SP`, executa tudo e faz **ROLLBACK** (execução
  seca). Com qualquer falha, `ON_ERROR_STOP` aborta e o Postgres desfaz a
  transação.

## 5. Ato b8bec255 e PDF em "Processando"

- `b8bec255-a9b3-44c0-1648-08dd40ce108a` (DOE 05/02/2025) tem HTML oficial
  (~7,5 MB). No page-first, o PDF redundante **não é solicitado**: o ato é
  capturado pelo HTML (teste `historical never-rendered PDF is not requested
  when official HTML is complete`). O preflight reporta o ato (`act_b8bec255`).
- Para ato **sem corpo HTML** cujo PDF material fica em "Processando":
  - até `DOE_SP_MATERIAL_PDF_GRACE_DAYS` (7) dias após a data do DOE, o
    item falha e o dia é tentado de novo;
  - depois disso (timeout), o ato vai para `deferredItems` no checkpoint, o
    dia conta como concluído e o cursor de bootstrap avança
    (`DOE_SP_MATERIAL_PDF_DEFERRED` em `partialFailures`, contador
    `materialPdfDeferred`);
  - o ato é tentado de novo no máximo 1×/24 h e só sai de `deferredItems`
    quando é publicado. Nunca some do controle; `10`/`41` reportam
    `deferredItems`.

## 6. Procedimento da fase destrutiva (gate futuro; cada passo registra evidência)

Pré-requisitos: revisão independente PASS deste SHA; autorização expressa
para a fase destrutiva; merge/deploy do PR #73 decididos pelo responsável.

1. **Worker env** (read-only, só conferir): `DOE_SP_BOOTSTRAP_START_DATE=2025-01-01`;
   `DOE_SP_FORCE_REPROCESS_UNTIL` ausente ou no passado. Se divergir,
   ajustar **antes** de `50` (mudança autorizada no gate).
2. **Pausa**: `psql "$DATABASE_URL" -f sql/25_pause_source.sql`. Repetir o
   `20` até `blockers.active_runs = 0` (um run `RUNNING` termina normalmente).
3. **Backup novo + restauração**: redeploy do runner (`prep.sh`) pinado no
   SHA revisado. Exigir `DOE_SP_31_RESULT` com todos os passos PASS. O
   `rehearsal_pause` do runner roda apenas no Postgres temporário.
4. **Merge/deploy do PR #73** (se decidido): Backend/Worker/Scheduler SUCCESS
   no commit da main. A fonte continua pausada.
5. **Dry-run**: `PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -q -t -A -f sql/20_dry_run_readonly.sql`.
   Todos os `blockers` = 0; `expected` compatível com o preflight revisado
   (diferença só se houve run entre os dois; nesse caso explicar).
6. **Execução seca em produção**: `psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 <DOE_SP_REBUILD_ARGS> -f sql/30_rebuild_destructive.sql`
   → `mode=DRY`, `postConditions=PASS`, `ROLLED_BACK`.
7. **Execução real**: mesmo comando `+ -v confirm=REBUILD_DOE_SP` →
   `DOE_SP_REBUILD_COMMITTED`.
8. **Validação**: `40` com `-v expected_publications_kept=<n>` → `PASS`.
9. **Retomada**: `50_resume_source.sql` → `DOE_SP_RESUMED`. O Scheduler cria
   o próximo run; o conector faz bootstrap desde 2025-01-01 com orçamento de
   tempo por run (vários runs).
10. **Acompanhamento**: por run, `pendingDays` decrescente e `deferredItems`
    conhecido. Não iniciar run manual sem autorização.
11. **Fechamento da recaptura**: `41` com `checkpoint.pendingRanges = []`,
    `publicationsWithoutVersionOrOrigin = 0`, `redundantPdfInVersion = 0`,
    `crossOriginFiles = 0` e `historicalVersions = 0`. Depois, um run
    SCHEDULED seguinte como prova de replay: 0 publicações novas e
    0 versões novas.

## 7. Rollback

- **Antes do COMMIT de `30`**: automático (transação única).
- **Depois do COMMIT** (incidente, com autorização):
  1. `25` (se retomado), aguardar zero runs ativas;
  2. se já houve recaptura parcial: `20` novo e `30` com as novas contagens,
     para limpar o escopo de novo;
  3. restaurar o backup verificado num Postgres temporário na Railway (como
     o runner faz) e executar `runner/rollback-stage.sh <restaurado> <produção>`;
  4. `sql/60_rollback_import.sql` → origens, versões, arquivos, ponteiros de
     run e checkpoints voltam com os **mesmos IDs**; a fonte permanece
     pausada;
  5. `11` na produção deve ter o SHA do manifesto do backup; retomar com `50`
     só após revisão.
- Ensaiado integralmente pelo runner (`rehearsal_rollback_manifest_equal`).

## 8. Retomada de uma execução interrompida

| Parou em | Estado | Retomar |
|---|---|---|
| antes de `30` COMMIT | nada mudou além da pausa | repetir desde o passo 5 |
| entre `30` e `50` | escopo vazio, fonte pausada | `40` e seguir o passo 9 |
| recaptura em andamento | checkpoint com `pendingRanges` | só aguardar os runs SCHEDULED; o cursor é idempotente |
| recaptura concluída com `41` FAIL | fonte ativa | pausar (`25`), diagnosticar; rollback (§7) se necessário |

## 9. Dados privados

`11`, o dump e as cópias restauradas ficam **somente** no volume do runner
na Railway (`/data/doe-sp-31/<stamp>/`, permissão 700). Logs e GitHub levam
apenas PASS/FAIL, contagens e SHA-256.

## 10. Runner de preparação (DOE-SP-31)

Serviço temporário `tmp-doe-sp-31-runner` no projeto `efficient-imagination`:
Dockerfile `ops/doe-sp/runner/Dockerfile`, fonte pinada por `commitSha`,
`restartPolicy=NEVER`, volume em `/data`, variável
`PROD_DATABASE_URL=${{Postgres.DATABASE_URL}}`. Linha final esperada:
`DOE_SP_31_RESULT` com todos os passos PASS e depois `DOE_SP_31_DONE`.
Localmente, o runner foi validado contra um banco sintético (Postgres 16,
migrations do repositório).
