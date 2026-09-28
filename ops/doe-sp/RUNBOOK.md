# DOE-SP — reconstrução restrita do acervo (D-052)

Estado: **CORRIGIDO (DOE-SP-33, validado e ajustado na DOE-SP-34)** após o parecer DOE-SP-32. Aguarda novo gate
de PREPARAÇÃO (backup/restauração/ensaio no novo SHA) e revisão independente. Nada aqui autoriza, por si só, pausa,
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
| `norma_clara_translations` das versões do escopo | **`30` aborta se houver qualquer linha** | tabela criada em runtime pelo serviço `tribusca-site-prototype` (fora das migrations deste repositório), com FK `ON DELETE CASCADE` para a versão. Não há desenho aprovado para preservar traduções antigas numa versão nova, então nenhuma é apagada. Com contagem > 0, a fase destrutiva para até existir esse desenho |
| `sources` (`doe-sp`) | mantida; `is_active` alternado pela pausa/retomada | — |
| demais fontes | intocadas; totais globais verificados dentro da transação | — |

Na recaptura, a primeira versão de cada publicação preservada é registrada
como `NEW_VERSION` (a publicação já existia), com `version_no = 1`. Se a
identidade de um ato mudar, surge uma publicação nova e a antiga fica sem
origem ou versão; `41` conta esses casos (`publicationsWithoutVersionOrOrigin`)
e eles vão para um gate próprio. Não há exclusão automática.

**Efeito na API pública (#74) durante a janela entre `30` e o fim da
recaptura** (o contrato público não expõe `content_text`):
- `/public/v1/sources`: a contagem de publicações DOE-SP vai a **0** (ela
  conta por `publication_origins`) e sobe conforme a recaptura avança;
- `/public/v1/publications?source=doe-sp`: **vazia** no início, depois só os
  atos já recapturados;
- `/public/v1/publications` sem filtro de fonte: continua listando os IDs e
  metadados preservados (título, tipo, número, datas), com `official_url` vindo
  de `primary_official_url`;
- `/public/v1/stats`: o total global de publicações não muda;
- `/public/v1/sources`, **status** da DOE-SP: `PARTIAL_SUCCESS` no último run
  é exposto como `UNSTABLE` (`src/api/routes/public.route.ts`). Durante a
  recaptura, os runs que param por orçamento de tempo (`TIME_BUDGET_REACHED`)
  deixam a fonte `UNSTABLE`. Depois dela, a fonte continua `UNSTABLE`
  enquanto houver `deferredItems` (§5), até o ato adiado ser capturado.

O protótipo do site (`tribusca-site-prototype`), que lê o banco diretamente,
mostra essas publicações sem versão atual até serem recapturadas. Esses
efeitos são esperados e devem ser comunicados antes do passo 7 do §6.

## 3. Arquivos

| Arquivo | Tipo | Onde roda |
|---|---|---|
| `sql/00_assert_read_only.sql` | guarda | incluído pelos read-only |
| `sql/10_preflight_readonly.sql` | agregados publicáveis | produção (RO), restauração |
| `sql/11_private_manifest_readonly.sql` | **manifesto identificável** | produção (RO) → volume Railway |
| `sql/12_table_counts_readonly.sql` | contagem exata de todas as tabelas | produção (RO), restauração |
| `sql/13_other_sources_fingerprint_readonly.sql` | SHA-256 de tudo fora do escopo DOE-SP (outras fontes, runs, itens, vínculos, empresas, audit, traduções) | produção (RO), restauração, ensaio |
| `sql/20_dry_run_readonly.sql` | contagens esperadas por tabela, bloqueadores e argumentos de `30` | produção (RO) |
| `sql/25_pause_source.sql` | escrita: `is_active=false` | produção (gate futuro) |
| `sql/30_rebuild_destructive.sql` | **destrutivo, transação única** | produção (gate futuro) |
| `sql/40_post_rebuild_validation.sql` | validação pós-`30` | produção (RO) |
| `sql/50_resume_source.sql` | escrita: `is_active=true` | produção (gate futuro) |
| `sql/41_post_recapture_validation.sql` | validação da recaptura | produção (RO) |
| `sql/60_rollback_import.sql` | rollback ao estado do backup, também após recaptura parcial | produção (só em incidente) |
| `rehearsal/partial_recapture_sim.sql` | simula uma recaptura parcial; recusa rodar fora de bancos de ensaio | cópia temporária do runner |
| `runner/prep.sh` | orquestra DOE-SP-31 (preflight, backup, restauração e ensaio) | serviço temporário Railway |
| `runner/rollback-stage.sh` | prepara o `schema doe_sp_rollback` a partir do backup | Railway |
| `runner/Dockerfile` | `postgres:18` + `jq` | Railway |

## 4. Garantias do script destrutivo (`30`)

- Uma transação `SERIALIZABLE`. Os `LOCK TABLE` (escopo, `collection_runs`,
  `collection_items` e `norma_clara_translations`) vêm **antes da primeira
  consulta**: o snapshot só é tirado depois das esperas, então uma escrita de
  outra fonte commitada enquanto `30` aguardava o lock (por exemplo, um item
  apontando para o escopo) é vista pelas guardas e aborta a execução. Depois,
  os locks mantêm o escopo estável. Em seguida, `SELECT … FOR UPDATE` na linha
  da fonte serializa com pausa/retomada e com o gatilho manual. Teste:
  `DOE-SP-34: 30 sees writes committed while it waits for its table locks`.
  O `60` segue a mesma ordem.
- **Pausa × Scheduler (corrida fechada, DOE-SP-34):** o Scheduler roda como
  `radar_worker_runtime`, que só tem `SELECT` em `sources`. Qualquer lock de
  linha ali (`FOR SHARE`/`FOR KEY SHARE`/`FOR UPDATE`) é negado a esse role,
  então o Scheduler insere com `INSERT … SELECT … FROM sources WHERE
  is_active`, sem lock. A corrida é fechada na pausa: `25` toma `FOR NO KEY
  UPDATE` na fonte e `LOCK TABLE collection_runs IN SHARE MODE` na mesma
  transação do `UPDATE`. Uma inserção em curso termina antes e o run aparece
  na contagem de runs ativos. Uma inserção posterior espera o COMMIT da pausa
  e lê `is_active = false`. `NO KEY UPDATE` não conflita com o `FOR KEY SHARE`
  da FK de `collection_runs`, o que evita deadlock com a inserção em curso.
  Teste concorrente, com o Scheduler no role real: `DOE-SP-33/34: a paused
  source never receives a scheduled run`. **Exige o código deste PR em
  produção antes da pausa** (§6, passo 2).
- Guardas: fonte pausada; zero runs `PENDING/RUNNING`; zero origens de outra
  fonte; zero `company_publications`; zero links de run **e zero
  `collection_items`** de runs de outra fonte apontando para o escopo; **zero
  `norma_clara_translations`** em versões do escopo; nenhuma FK desconhecida
  apontando para `publications`/`publication_versions` (proteção contra
  desvio de esquema).
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
    `deferredItems`;
  - enquanto houver `deferredItems`, o run termina com
    `completion = { complete: false, reason: 'MATERIAL_CONTENT_DEFERRED',
    pending.deferredItems = n }`, ou seja, `PARTIAL_SUCCESS`, **nunca**
    `SUCCESS_NO_RESULTS`/`SUCCESS`. Um item adiado nunca é contado como
    publicação capturada. Na API pública, a fonte aparece como `UNSTABLE`
    enquanto isso durar (§2).

## 6. Procedimento da fase destrutiva (gate futuro; cada passo registra evidência)

Pré-requisitos: revisão independente PASS deste SHA; autorização expressa
para a fase destrutiva; merge/deploy do PR #73 decididos pelo responsável.

1. **Worker env** (read-only, só conferir): `DOE_SP_BOOTSTRAP_START_DATE=2025-01-01`;
   `DOE_SP_FORCE_REPROCESS_UNTIL` ausente ou no passado. Se divergir,
   ajustar **antes** de `50` (mudança autorizada no gate).
2. **Merge/deploy do PR #73**: Backend/Worker/Scheduler SUCCESS no commit
   da main. **Obrigatório antes da pausa**: o Scheduler com
   `createScheduledCollectionRun` (inserção condicionada a `is_active`), junto
   com o `LOCK` da pausa `25`, fecha a corrida pausa × criação de run. Com
   a fonte ainda ativa, o conector novo roda sobre o acervo legado pelo
   caminho de compatibilidade v1→v2 (aprovado na DOE-SP-26).
3. **Pausa**: `psql "$DATABASE_URL" -f sql/25_pause_source.sql`. Repetir o
   `20` até `blockers.active_runs = 0` (um run `RUNNING` termina normalmente).
4. **Backup novo + restauração + ensaio**: redeploy do runner (`prep.sh`)
   pinado no SHA revisado. Exigir `DOE_SP_31_RESULT` com todos os passos PASS.
   Os passos `rehearsal_*` rodam apenas no Postgres temporário.
5. **Dry-run**: `PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -q -t -A -f sql/20_dry_run_readonly.sql`.
   Todos os `blockers` = 0, inclusive `scope_translations`; `expected`
   compatível com o preflight revisado (diferença só se houve run entre os
   dois; nesse caso explicar). Comunicar o efeito na API (§2).
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
- **Depois do COMMIT, com ou sem recaptura parcial** (incidente, com
  autorização):
  1. `25` (pausa) e aguardar zero runs `PENDING/RUNNING`;
  2. restaurar o backup verificado num Postgres temporário na Railway (como
     o runner faz) e executar `runner/rollback-stage.sh <restaurado> <produção>`.
     O staging leva as linhas completas de `publications` do escopo, origens,
     versões, arquivos, links, checkpoints, traduções e a lista de runs DOE-SP
     existentes no backup;
  3. `sql/60_rollback_import.sql`, numa transação: remove os runs DOE-SP
     posteriores ao backup (cascade: tentativas, itens, links), as versões e
     traduções da janela, todas as origens e checkpoints DOE-SP e as
     publicações criadas na janela; **restaura os campos canônicos** das
     publicações preservadas (título, vigência, URL canônica, `last_seen_at`
     etc.); reinsere o escopo com os **mesmos IDs**; confere que nada fora do
     DOE-SP mudou. Aborta se, na janela, outra fonte, empresa ou item
     estrangeiro passou a apontar para o escopo. A fonte permanece pausada;
  4. `11` na produção deve ter o SHA do manifesto do backup e `13` o
     fingerprint das outras fontes do momento do backup (se outra fonte
     coletou nesse intervalo, o `13` muda legitimamente: comparar com um `13`
     tirado imediatamente antes do rollback). Retomar com `50` só após revisão.
- Provas: teste de integração `test/doe-sp.rebuild-ops.integration.test.ts`
  (recaptura parcial com a persistência real → rollback → manifesto, outras
  fontes e contagens iguais; guardas de item estrangeiro e de tradução) e
  runner (`rehearsal_partial_recapture` → `rehearsal_rollback_manifest_equal`,
  `rehearsal_other_sources_untouched`, `rehearsal_final_counts_equal`).

## 8. Retomada de uma execução interrompida

| Parou em | Estado | Retomar |
|---|---|---|
| antes de `30` COMMIT | nada mudou além da pausa | repetir desde o passo 5 |
| entre `30` e `50` | escopo vazio, fonte pausada | `40` e seguir o passo 9 |
| recaptura em andamento | checkpoint com `pendingRanges` | só aguardar os runs SCHEDULED; o cursor é idempotente |
| recaptura parcial ou concluída com `41` FAIL | fonte ativa | pausar (`25`), diagnosticar; rollback (§7), que cobre recaptura parcial |

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
Ensaio (DOE-SP-33): guardas negativas (item estrangeiro, tradução no escopo),
`30`, recaptura parcial simulada, rollback `60` e comparação de manifesto,
fingerprint das outras fontes e contagens. Localmente, o runner foi validado
contra um banco sintético (Postgres 16,
migrations do repositório).
