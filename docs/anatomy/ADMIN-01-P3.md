# ANAT-ADMIN-01 / P3 — desenho de persistência, API administrativa, ativação e simulação isolada

**Situação:** desenho para revisão, **sem implementação**. Esta é a **revisão R2 do desenho**: corrige P3-R1-01 a 06 e incorpora as decisões do COORD da [R1](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/256#pullrequestreview-5624065521). Base: P2 com PASS técnico em `92ad925` (#255).

**Não autoriza:** criar arquivo de migration, aplicar SQL, criar executor ou rotas, alterar produção, ler corpus, medir, recapturar, fazer merge ou deploy. Todo SQL abaixo é **ilustrativo** e não foi executado.

**Fontes conferidas (main):**
- `migrations/006_audit.sql` (criação de `audit_log`);
- `migrations/074_audit_allowlist_and_backfill.sql` e `075_audit_historical_event_rules.sql`: `audit_event_policy`, `audit_project`, `audit_actor_reference` e o trigger `audit_allowlist_guard`, que exige evento cadastrado, ator UUID ou `system:*` fechado, `entity_id` e `request_id` UUID e payload plano tipado;
- papéis `radar_app`, `radar_worker` e `radar_taxonomy_curator`;
- schema descartável `test/support/anatomy-ci-schema.sql`;
- serviços P2 ([rules-simulation.md](rules-simulation.md));
- `requirePlatformAdmin` em `taxonomy-admin.route.ts`.

## 0. Decisões do COORD incorporadas (R1)

1. **`anatomy_rule_sets` passa a ser o catálogo de snapshots imutáveis** e preserva as referências de análises e runs. O rascunho mutável e as revisões do seu conteúdo ficam em tabelas separadas. Um snapshot já referenciado nunca é alterado.
2. **Também se auditam falhas ocorridas depois da validação e da autorização**, com resultado e código sanitizados e `correlation_id`, sem conteúdo privado.
   - Sucesso: auditoria atômica com a mutação.
   - Falha: rollback do negócio e registro da tentativa em **transação separada**.
   - Erros antes da validação ou da autorização não são auditados aqui (401, 403 e 422 de schema ficam com o log de acesso).
   - Se a auditoria estiver indisponível, **nenhuma mutação é feita**. Nada promete persistir uma falha dentro da transação que foi revertida.
3. **Parâmetros iniciais:**
   - 2 execuções simultâneas por instância e fila de até 10;
   - espera máxima na fila de 5 s (depois disso, 429);
   - até 20 exemplos e orçamento de 2 s por exemplo;
   - prazo total de 60 s por requisição; uma comparação conta os dois lados;
   - 256 MB como limite proposto de **heap JS** (não é limite de RSS);
   - token de preview de 10 min.
   - Margem de timeout, inicialização e encerramento serão medidos no ensaio. **Não é tempo real rígido.**
4. **Ordem das autorizações:**
   - (a) corrigir e revisar este desenho;
   - (b) pacote de schema administrativo e auditoria em **banco descartável**;
   - (c) executor isolado, em pacote próprio;
   - (d) API, depois que (b) e (c) passarem;
   - (e) telas P4.
   - A aplicação produtiva **não** é pré-requisito para implementar e testar isoladamente e **não** faz parte desta autorização.

## 1. Princípios

1. **Aprovação vinculada a hashes exatos:**
   - perfis: `rule_hash` = SHA-256 do JSON canônico do conjunto de perfis;
   - exemplos e expectativas: `example_set_hash`;
   - motor: `engine_hash`.
   - O trio forma um **candidato** imutável. Mudar qualquer parte cria outro candidato, e nenhuma aprovação anterior é reaproveitada.
2. **Imutabilidade e retenção:** snapshots, conjuntos de exemplos, candidatos, simulações, comparações, revisões, previews consumidos e ativações nunca mudam de conteúdo nem são apagados. Só o rascunho é mutável.
3. **Autor ≠ revisor**, garantido no banco e na API.
4. **Ativar ou retornar não reprocessa nada.**
5. **Estrutura não decide direito:** nada aqui cria evidência jurídica, vigência ou seleção positiva.
6. **Sem corpus:** só exemplos sintéticos; amostras de desenvolvimento e métricas dependem de autorização futura.

## 2. Modelo de dados

### 2.1 Ordem das migrations (sem números)

Os números serão atribuídos **só no pacote de implementação, depois de conferir a main**. Hoje 072 a 075 já estão ocupados (P3-R1-06), e nenhuma migration existente será renumerada ou editada.

| Placeholder | Conteúdo |
|---|---|
| `M_ANAT_BASE` | Schema base ANAT-04 (hoje só no schema descartável do CI). Pacote próprio, se ainda não aplicado |
| `M_ANAT_ADMIN` | Tabelas administrativas (§2.2) |
| `M_AUDIT_ANAT` | Extensão da allowlist de auditoria (§2.4); **não edita** 074 nem 075 |

### 2.2 Tabelas

Todos os identificadores expostos à auditoria são **UUID**, porque o guard aceita só UUID em `entity_id` e `request_id`. Os hashes são `char(64)` em hex minúsculo.

| Tabela | Mutável? | Conteúdo e chaves |
|---|---|---|
| `anatomy_rule_drafts` | **Sim**, só pelo autor | `id uuid PK`, `author uuid`, `base_rule_set_id/base_rule_hash` (FK opcional para o snapshot de origem), `profiles jsonb`, `examples jsonb`, `revision int` (lock otimista), `updated_at`. **Nada referencia rascunhos.** |
| `anatomy_rule_sets` (reaproveitada) | **Não** | Snapshot congelado: `id`, `rule_hash` (UNIQUE `(id, rule_hash)` existente), `profiles`, `author`, `status` legado (ver §2.3), mais `snapshot_id uuid UNIQUE` e `frozen_from_draft uuid`, `frozen_at`. O `rule_hash` é recalculado pela aplicação e conferido por trigger com a mesma canonicalização |
| `anatomy_rule_example_sets` | **Não** | `id uuid PK`, `example_set_hash char(64) UNIQUE` (JSON canônico do array de exemplos com expectativas), `examples jsonb` (schema P2; até 20; IDs da reserva proibidos), `created_by uuid`. Todos os exemplos do conjunto são **obrigatórios** |
| `anatomy_rule_candidates` | **Não** | `id uuid PK`, FK `(rule_set_id, rule_hash)`, FK `example_set_id`, `engine_hash`, `created_by uuid`; UNIQUE `(rule_hash, example_set_id, engine_hash)` |
| `anatomy_rule_simulations` | **Não** | `id uuid PK`, FK `candidate_id`, `report jsonb` (relatório P2), `report_hash`, `status` (`complete`, `partial`, `cancelled`, `failed`), `pass_count`, `fail_count`, `partial_count`, `cancelled_count` e `inconclusive_count` (int), `requested_by uuid` |
| `anatomy_rule_comparisons` | **Não** | `id uuid PK`, `comparison_hash char(64) UNIQUE` (o `id` do envelope P2), FK `candidate_id` (lado **depois**), FK `(baseline_rule_set_id, baseline_rule_hash)` (lado **antes**: ativo no momento ou base declarada), `example_id text`, `envelope jsonb` |
| `anatomy_rule_reviews` | **Não** | `id uuid PK`, FK `candidate_id`, FK `simulation_id`, `reviewer uuid`, `outcome` (`approved` ou `rejected`), `rationale text` (10–4000, **nunca vai para a auditoria**), `created_at` |
| `anatomy_rule_review_comparisons` | **Não** | PK `(review_id, comparison_id)`, FKs para as duas tabelas. Substitui o array sem integridade referencial |
| `anatomy_rule_review_decisions` | **Não** | PK `(review_id, comparison_id, difference_id)`, `decision` (`expected`, `regression`, `not_evaluated`), `note`; FK `(review_id, comparison_id)` |
| `anatomy_rule_activation_previews` | Só `consumed_*` | Ver §4 |
| `anatomy_rule_activations` | Só `superseded_at` | `id uuid PK`, `scope`, FK `candidate_id`, FK `review_id`, `kind` (`activate` ou `rollback`), `previous_activation_id`, FK `preview_id UNIQUE`, `affected_scope jsonb`, `actor uuid`, `justification` (não auditada), `activated_at`, `superseded_at`; índice único parcial `(scope) WHERE superseded_at IS NULL` |

**Rascunho → snapshot (corrige P3-R1-03):** o rascunho é a **única** coisa editável. A operação "congelar" calcula `rule_hash` e `example_set_hash`, faz *upsert* idempotente do snapshot e do conjunto de exemplos (pelo hash) e cria o candidato.
- Editar o rascunho depois disso **não muda** snapshots, exemplos, candidatos nem nada que os referencie.
- Um novo congelamento cria **outro** candidato.
- Nenhuma FK aponta para conteúdo mutável, e o histórico é preservado sem atualizar alvo de FK.

### 2.3 Estados, transições e proibições

O candidato não tem campo de status mutável. O estado é **derivado** de linhas imutáveis:

| Estado derivado | Condição |
|---|---|
| `frozen` | O candidato existe |
| `simulated` | Existe simulação do candidato |
| `approved` | Existe review `approved` válida (§2.5) |
| `rejected` | Só reviews `rejected` |
| `active` | É o alvo da ativação não superada |
| `superseded` | Já foi ativo |

O `status` legado de `anatomy_rule_sets` passa a ter valor fixo `reviewed` para os snapshots administrativos. Isso será confirmado no pacote (b); a coluna não é usada para decisão.

**Política por tabela e papel** (implementada com triggers `BEFORE INSERT/UPDATE/DELETE` e GRANTs):

| Tabela | `radar_app` (API) | `radar_worker` | `radar_taxonomy_curator` | Outros |
|---|---|---|---|---|
| `anatomy_rule_drafts` | SELECT, INSERT, UPDATE (só `profiles`, `examples`, `revision` e `updated_at`, com o `author` da sessão conferido pela API e `revision` incrementada); **sem DELETE** | — | — | — |
| `anatomy_rule_sets` | SELECT, INSERT; **UPDATE e DELETE negados** por trigger (exceto a coluna técnica preexistente, se houver) | SELECT | — | — |
| `anatomy_rule_example_sets`, `candidates`, `simulations`, `comparisons`, `reviews`, `review_*` | SELECT, INSERT; **UPDATE e DELETE negados** | — | — | — |
| `anatomy_rule_activation_previews` | SELECT, INSERT, UPDATE **só** de `consumed_at` e `consumed_activation_id` de NULL para valor; DELETE negado | — | — | — |
| `anatomy_rule_activations` | SELECT, INSERT, UPDATE **só** de `superseded_at` de NULL para valor; DELETE negado | SELECT (para resolver o ativo) | — | — |

- `REVOKE ALL ... FROM PUBLIC` em todas.
- Sem RLS de tenant: são tabelas globais administrativas, e o isolamento vem dos GRANTs acima e de nenhuma rota de tenant as ler.
- Os testes do pacote (b) conferem os privilégios efetivos com `has_table_privilege` e `has_column_privilege` para cada papel.

**Triggers de INSERT:**
- recusam inserir snapshot, candidato ou review com campos obrigatórios faltando;
- recusam `rule_hash` ou `example_set_hash` que não correspondam ao conteúdo;
- recusam review cujo `reviewer` seja o `created_by` do candidato ou o `author` do rascunho de origem (P3-R1-03 e decisão de autor ≠ revisor).

### 2.4 Auditoria: extensão da allowlist (corrige P3-R1-02)

A migration `M_AUDIT_ANAT` faz `CREATE OR REPLACE FUNCTION public.audit_event_policy`, repetindo **byte a byte** todas as entradas atuais da 075 e acrescentando somente entradas novas. É o mesmo padrão que a 075 usou sobre a 074.
- `audit_project`, `audit_allowlist_guard`, `audit_actor_reference` e os GRANTs ficam intactos.
- Um teste compara a projeção das entradas antigas antes e depois.

**Eventos novos** (`entity_type = 'anatomy_rules'`; `tenant_id NULL`; `actor_id` = UUID do administrador, que o guard aceita; `entity_id` = UUID do objeto). Só campos planos tipados; **nenhum texto livre**: justificativa, nota e mensagem ficam nas tabelas de domínio, não no `audit_log`.

```
"ANAT_RULES_DRAFT_SAVED|anatomy_rules":      {"draftId":"uuid","revision":"int","profileSetHash":"sha256","exampleSetHash":"sha256"}
"ANAT_RULES_CANDIDATE_FROZEN|anatomy_rules": {"candidateId":"uuid","draftId":"uuid","profileSetHash":"sha256","exampleSetHash":"sha256","engineHash":"sha256"}
"ANAT_RULES_SIMULATED|anatomy_rules":        {"simulationId":"uuid","candidateId":"uuid","reportHash":"sha256","status":["COMPLETE","PARTIAL","CANCELLED","FAILED"],"passCount":"int","failCount":"int","partialCount":"int","cancelledCount":"int","inconclusiveCount":"int"}
"ANAT_RULES_COMPARED|anatomy_rules":         {"comparisonId":"uuid","candidateId":"uuid","comparisonHash":"sha256","baselineProfileSetHash":"sha256","differenceCount":"int"}
"ANAT_RULES_REVIEWED|anatomy_rules":         {"reviewId":"uuid","candidateId":"uuid","simulationId":"uuid","outcome":["APPROVED","REJECTED"],"comparisonCount":"int","decisionCount":"int"}
"ANAT_RULES_ACTIVATION_PREVIEWED|anatomy_rules": {"previewId":"uuid","candidateId":"uuid","reviewId":"uuid","action":["ACTIVATE","ROLLBACK"],"intentHash":"sha256","expiresMinutes":"int"}
"ANAT_RULES_ACTIVATED|anatomy_rules":        {"activationId":"uuid","previousActivationId":"uuid","candidateId":"uuid","reviewId":"uuid","previewId":"uuid","action":["ACTIVATE","ROLLBACK"]}
"ANAT_RULES_ATTEMPT_REJECTED|anatomy_rules": {"operation":["DRAFT_SAVE","FREEZE","SIMULATE","COMPARE","REVIEW","PREVIEW","CONFIRM"],"code":["STALE_REVISION","AUTHOR_CANNOT_REVIEW","REVIEW_INCOMPLETE","SIMULATION_NOT_PASSING","COMPARISON_MISMATCH","PREVIEW_EXPIRED","PREVIEW_CONSUMED","PREVIEW_STALE","ENGINE_MISMATCH","SIMULATION_UNAVAILABLE","LIMIT_EXCEEDED"],"targetId":"uuid"}
```

- O token de preview **nunca** é auditado; só o `previewId` e o `intentHash`.
- Os testes do pacote (b) usam a cadeia completa 006 → 074 → 075 → `M_AUDIT_ANAT` e verificam três coisas:
  - um evento ANAT não cadastrado é recusado (`audit_event_not_registered`);
  - um campo extra ou texto livre é descartado pela projeção;
  - um ator não UUID é recusado.

### 2.5 Regras de aprovação (corrige P3-R1-04)

Uma review `approved` é aceita (trigger `CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED`, avaliado no commit, mais validação equivalente na API) somente se **todas** as condições abaixo valem:

1. A `simulation_id` pertence ao **mesmo** candidato e tem `status = complete`.
2. **Todos** os exemplos obrigatórios do conjunto foram executados e estão `pass`.
   - `fail`, `cancelled`, `failed`, `partial` por orçamento de tempo e execução ausente **impedem** a aprovação. Marcar diferenças como `expected` não compensa isso.
   - **Resultado parcial do motor** (`status: partial` com limitação de contenção, como `non_nfc_text` sem recuperação, `nfc_*`, `entity_extraction_failed` ou limites de entrada): o exemplo só conta como `pass` se declarar essa limitação **explicitamente** num matcher positivo (`{ kind: 'limitation', code }`). Caso contrário é `inconclusive` e bloqueia.
   - Um exemplo negativo cuja "ausência" decorra só de extração suspensa **não** prova sucesso. Isso exige um pequeno ajuste no P2 (classificar `inconclusive`), previsto para o pacote (b) ou (c).
3. Para **cada** exemplo obrigatório existe exatamente **uma** comparação vinculada à review (`anatomy_rule_review_comparisons`) que:
   - é do mesmo `candidate_id`;
   - tem `example_id` igual ao do exemplo;
   - tem `envelope.provenance.afterProfileSetHash` igual ao `rule_hash` do candidato;
   - tem `envelope.after.engineHash` e `envelope.before.engineHash` iguais ao `engine_hash` do candidato;
   - tem `envelope.provenance.beforeProfileSetHash` igual ao `baseline_rule_hash`;
   - tem `envelope.id` igual a `comparison_hash` e o hash do envelope recalculado bate.
4. **Toda** diferença de cada envelope tem exatamente uma decisão: nenhuma `regression`, nenhuma `not_evaluated`, nenhum ID desconhecido ou duplicado (PK). O veredito P2 é `clear`.
5. `reviewer` ≠ autor do candidato e do rascunho.

Uma comparação sem diferenças **não** substitui o item 2: só a simulação comprova as expectativas.

## 3. API administrativa (`/api/v1/admin/anatomy-rules`)

- Todas as rotas usam `requirePlatformAdmin`, Zod strict e `correlation_id` (UUID).
- Mutações com auditoria na **mesma transação**.
- Falhas depois da validação e da autorização: rollback, depois `ANAT_RULES_ATTEMPT_REJECTED` em transação separada.

| Método e rota | Efeito |
|---|---|
| `GET /drafts`, `GET /candidates`, `GET /candidates/:id` | Leitura, com estado derivado |
| `POST /drafts`, `PUT /drafts/:id` | Cria ou edita o rascunho (`revision` obrigatória; 409 `STALE_REVISION`). Valida P1 e P2 |
| `POST /drafts/:id/freeze` | Cria snapshot, conjunto de exemplos e candidato, de forma idempotente pelos hashes |
| `POST /candidates/:id/simulate` | Executor isolado (§5); 503 se indisponível |
| `POST /candidates/:id/compare` | Uma comparação por exemplo contra a base (ativo atual ou base declarada); grava `comparison_hash` |
| `POST /candidates/:id/reviews` | Review com `simulationId`, `comparisonIds[]`, decisões, `outcome` e justificativa; regras do §2.5 |
| `POST /activation/preview`, `POST /activation/confirm` | §4 (ação `ACTIVATE` ou `ROLLBACK`) |
| `GET /activations`, `GET /audit` | Histórico (a auditoria é lida por `entity_type`) |

**Erros:**
- 403 `platform_admin_required`;
- 409 com os códigos de `ATTEMPT_REJECTED`;
- 422 de schema;
- 429 quando a fila está cheia;
- 503 `simulation_isolation_unavailable`.

## 4. Ativação e retorno (corrige P3-R1-05)

**Tabela `anatomy_rule_activation_previews`:**
- `id uuid PK` e `token_hash char(64) UNIQUE` (SHA-256 de 32 bytes aleatórios; **o token bruto nunca é gravado nem logado**, só devolvido uma vez na resposta);
- `action` (`activate` ou `rollback`), `actor uuid`, `candidate_id`, `review_id`;
- `observed_activation_id uuid NULL` (NULL quando ainda não houve ativação);
- `intent_hash char(64)`: hash canônico de {ação, candidato, review, ativação observada, escopo, expiração};
- `affected_scope jsonb`, `expires_at` (+10 min);
- `consumed_at NULL` e `consumed_activation_id NULL`.

**Preview:**
1. Valida a review aprovada do mesmo candidato, o `engine_hash` igual ao do binário e, para retorno, que o alvo já esteve ativo.
2. Calcula o escopo afetado (abaixo).
3. Grava o preview e a auditoria `ACTIVATION_PREVIEWED` na mesma transação.

**Confirm** (transação `SERIALIZABLE`):
1. `SELECT ... FOR UPDATE` do preview por `token_hash` com `consumed_at IS NULL`, `expires_at > now()` e `actor` igual ao da sessão. A ausência de linha responde 409 `PREVIEW_EXPIRED` ou `PREVIEW_CONSUMED`.
2. Confere que a ativação corrente `IS NOT DISTINCT FROM observed_activation_id`, o que cobre a **primeira ativação** (NULL). Se divergir: 409 `PREVIEW_STALE`.
3. Revalida a review e o `engine_hash`.
4. `UPDATE` de `superseded_at` da ativação corrente (se houver), `INSERT` da nova ativação (`preview_id` UNIQUE), `UPDATE` do preview para consumido e `INSERT` da auditoria `ACTIVATED`.
5. **Retry de serialização:** até 3 tentativas. Cada uma começa relendo o preview; se já estiver consumido por `consumed_activation_id`, devolve **o mesmo resultado** (idempotente) sem reaplicar. Dois confirms concorrentes resultam em exatamente uma ativação.

**Escopo afetado (correção):**
- Calculado por **perfil efetivo**: para cada fonte, e para cada família com perfil próprio, compara `resolveEffectiveProfile(...).effectiveHash` do ativo e do candidato. Hash de conjunto **não** é comparado com hash efetivo.
- **Contagens separadas:**
  - **publicações** das fontes e famílias afetadas, incluindo as ainda sem análise;
  - **análises existentes** cujo perfil efetivo mudaria. Isso exige guardar `effective_profile_hash` (e `family`) em `publication_anatomies`, coluna a propor em `M_ANAT_BASE`, porque o schema atual não os tem. Sem isso, a contagem de análises fica **"não suportada"** e é declarada assim.
- A família só é contada onde o metadado de família da publicação existir; o restante é informado como "família desconhecida".
- O escopo é informativo: **nada é reprocessado**. O reprocessamento é operação separada (`anatomy_runs`).

**Retorno:** o mesmo fluxo com `action = rollback`. Não apaga nada e não reaprova evidência jurídica.

## 5. Simulação isolada (corrige P3-R1-01)

**O que `worker_threads` garante, e só isso:**
- tira o trabalho síncrono da thread da API;
- permite **encerrar** a execução (`worker.terminate()`);
- limita o **heap JS** do worker (`resourceLimits`).

**O que `worker_threads` não garante:**
- não é sandbox e não bloqueia rede nem sistema de arquivos;
- por padrão herda `process.env`;
- `resourceLimits` **não** limita o RSS do processo nem evita OOM global.

**Garantias pretendidas e mecanismo de cada uma:**

| Garantia | Mecanismo | Teste negativo (pacote c) |
|---|---|---|
| CPU e cancelamento: a API continua respondendo; um exemplo acima do orçamento é interrompido | Um worker por exemplo; o pai arma o timer (2 s + margem medida no ensaio); `terminate()` **aguardado** (`await`) antes de liberar a vaga; resposta tardia de um worker encerrado é descartada pelo `simulationId` e pela sequência | Exemplo sintético lento → `cancelled` dentro do orçamento + margem; a API responde a um health check durante a simulação; nenhuma mensagem tardia é aceita |
| Ausência de I/O | **Código confiável**: o worker executa só um módulo versionado (`simulation-worker.ts`), nunca código do usuário (perfis são dados, sem regex livre). A lista de imports é auditada por teste estático (só `rules-simulation` e dependências puras; sem `fs`, `net`, `http`, `child_process` nem `pg`) | Teste de grafo de imports falha se aparecer módulo de I/O |
| Sem segredos | `new Worker(file, { env: {} , execArgv: [], argv: [] })` com `env` **explícito e vazio** e sem `--require` herdado | Teste que lê `process.env` dentro do worker e espera objeto vazio |
| Proibição **técnica** de rede e arquivos | **Não** vem de `worker_threads`. Se o COORD exigir, a opção é rodar o executor em **processo separado** com Node Permission Model (`--permission`, sem `--allow-fs-*`, `--allow-net` nem `--allow-child-process`) ou em contêiner sem rede | Tentativa de `fs.readFile` e `fetch` no executor → erro de permissão |
| Memória | `resourceLimits.maxOldGenerationSizeMb = 256` limita só o **heap JS**. A contenção de RSS do processo depende do limite do contêiner ou processo separado | Exemplo que estoura heap → worker encerrado, exemplo `cancelled`, API viva. RSS **não** é declarado garantido |

**Limites de mensagens:**
- entrada por exemplo de até 256 Ki unidades UTF-16 (P2);
- catálogo opcional de até 20.000 códigos;
- perfis de até 64 KiB (P1);
- **saída** por exemplo de até 2 MiB serializados (acima disso, `failed` com `LIMIT_EXCEEDED`);
- o pai valida a saída pelo schema P2 antes de aceitar.

**Ciclo de vida:**
1. A requisição entra na fila (máximo 10, espera até 5 s, senão 429).
2. Ganha uma das 2 vagas.
3. Cada exemplo é executado no seu worker, com timer.
4. Em timeout, erro ou excesso de memória: `terminate()`, a vaga é liberada **só depois** do encerramento confirmado e o exemplo é marcado `cancelled` ou `failed`.
5. O prazo total de 60 s cancela o restante.
6. Se o cliente abortar (`AbortSignal` ou conexão fechada), os workers ativos são encerrados e a simulação é registrada `cancelled`.
7. O `engine_hash` do worker é comparado com o do pai; se divergirem, o resultado é `failed`.

Sem o executor, `simulate` e `compare` respondem 503. **Nada disso é tempo real rígido**; as margens são medidas no ensaio do pacote (c).

## 6. Testes (pacotes b e c; banco descartável; só sintéticos)

1. **Cadeia de migrations:** `M_ANAT_BASE` → `M_ANAT_ADMIN` → `M_AUDIT_ANAT` sobre 006/074/075. Reaplicação controlada. Entradas antigas da allowlist com projeção idêntica.
2. **Imutabilidade:** UPDATE e DELETE negados nas tabelas imutáveis, inclusive para `radar_app`. Snapshot referenciado nunca muda. Editar o rascunho não altera nenhum candidato.
3. **Privilégios:** `has_table_privilege` e `has_column_privilege` por papel conforme §2.3. `PUBLIC` sem acesso.
4. **Autor ≠ revisor:** recusado no banco e na API.
5. **Aprovação (§2.5):** simulação com `fail`, `cancelled`, `partial`, `inconclusive` ou ausente; comparação de outro candidato, outro exemplo, outro motor ou base trocada; diferença sem decisão; `regression`; `not_evaluated`; ID duplicado ou inexistente. **Todos recusados**; o caminho válido é aceito.
6. **Preview e confirm:** token errado, expirado, reutilizado, de outro ator ou com ativo alterado é recusado. Primeira ativação (NULL) funciona. Dois confirms concorrentes geram uma ativação. Retry idempotente. Token bruto ausente de tabelas e logs.
7. **Sem reprocessamento:** contagens de `anatomy_runs` e `publication_anatomies` inalteradas.
8. **Auditoria:** uma linha por sucesso, atômica. Uma linha `ATTEMPT_REJECTED` por falha depois da validação, em transação separada. Auditoria indisponível impede a mutação. Evento não cadastrado e texto livre recusados ou descartados.
9. **Executor (c):** CPU e cancelamento, `env` vazio, grafo de imports, heap, saída grande, fila e 429, `AbortSignal`, mensagem tardia e `engine_hash`.
10. **Reserva:** IDs da reserva recusados no rascunho, no conjunto de exemplos e na API.

## 7. Critérios de aceite das telas (P4)

| Tela | Aceite |
|---|---|
| T1 Versões | Mostra rascunhos, candidatos (estado derivado), ativo e histórico, com hashes curtos (perfis, exemplos, motor) |
| T2 Editor | Mostra o valor herdado e o efetivo; limites P1 ao digitar e no backend; sem campo de regex; conflito de `revision` tratado |
| T3 Exemplos | Positivos e negativos com expectativa; limitação esperada declarada explicitamente; ID da reserva recusado; até 20 |
| T4 Simulação | `pass`, `fail`, `partial`, `cancelled` e `inconclusive` por exemplo; mostra que só `pass` em todos permite aprovar; nunca mostra seleção positiva |
| T5 Comparação | Uma por exemplo contra a base; diferenças com antes e depois; `comparison_hash`; contagens informativas |
| T6 Revisão | Uma decisão por diferença; justificativa; o revisor não pode ser o autor; o botão "aprovar" só habilita quando todas as regras do §2.5 passam |
| T7 Ativação e retorno | Preview com escopo por fonte e família (publicações e análises separadas; "não suportado" quando for o caso) e aviso de que nada é reprocessado; confirm em segunda tela; 409 explicado |
| T8 Histórico | Ativações, retornos e auditoria (sem texto livre) |

**Aceite da Fase 1, item "tela":** os quatro exemplos de manutenção do ADMIN-01, seção 4, feitos de ponta a ponta em ambiente de teste, com permissões, reserva e auditoria conferidas.

## 8. Matriz da R1

| Achado | Onde foi corrigido |
|---|---|
| P3-R1-01: o executor prometia mais do que `worker_threads` entrega | §5: garantias separadas por mecanismo; `env` vazio; imports auditados; heap ≠ RSS; opção de processo com Permission Model; ciclo de vida e limites de mensagem |
| P3-R1-02: auditoria desenhada contra a 006 | §2.4: extensão da allowlist em nova migration, eventos tipados, sem texto livre; testes na cadeia 006/074/075; §2.3: papéis e GRANTs nomeados |
| P3-R1-03: identidade editável e imutabilidade incompleta | §2.2 e §2.3: rascunho separado; snapshots, exemplos e candidatos imutáveis por hash; estados derivados; política por tabela e papel |
| P3-R1-04: aprovação apoiada em prova alheia ou com falhas | §2.5: tabelas de ligação com FKs, vínculo de candidato, exemplo, motor e base, cobertura de todos os exemplos, simulação toda `pass`, política para `partial` e `inconclusive` |
| P3-R1-05: preview sem modelo de estado | §4: tabela de previews, consumo atômico, primeira ativação, retry idempotente, token nunca logado; escopo afetado por hash efetivo com contagens separadas |
| P3-R1-06: migration 072 ocupada | §2.1: placeholders; números só no pacote de implementação; nada renumerado |

**Mantidos:** reserva fechada; `BLOCK_CORPUS_INPUTS_AND_GOLD`; sem arquivo de migration, SQL aplicado, executor, rotas, produção, corpus real, recaptura, medição, merge ou deploy.
