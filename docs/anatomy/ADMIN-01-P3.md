# ANAT-ADMIN-01 / P3 — desenho de persistência, API administrativa, ativação e simulação isolada

**Situação:** desenho para revisão, **sem implementação**. Base: P2 com PASS técnico em `92ad925` (#255). Origem: autorização do COORD na issue #116.

**Não autoriza:** aplicar migration, criar rotas, alterar produção, ler corpus, medir, recapturar, fazer merge ou deploy. O SQL abaixo é **proposta** dentro deste documento; nenhum arquivo foi criado em `migrations/`.

**Fontes:**
- [ADMIN-01](ADMIN-01.md), seções 3 a 8;
- serviços P2 em [rules-simulation.md](rules-simulation.md);
- schema descartável `test/support/anatomy-ci-schema.sql`;
- `migrations/006_audit.sql` (`audit_log`);
- `requirePlatformAdmin` em `src/api/routes/taxonomy-admin.route.ts`.

## 1. Princípios

1. **Aprovação vinculada ao hash exato.** Uma revisão aprova a versão identificada por `profile_set_hash`, que é o SHA-256 do JSON canônico do conjunto de perfis. Ela também fica presa aos `comparison_id` usados e ao `engine_hash` vigente. Qualquer mudança de conteúdo gera outro hash e anula a aprovação.
2. **Imutabilidade.** Uma versão revisada ou ativada não muda: corrigir significa criar uma versão nova. Nada é apagado; retirar ou retornar só muda o estado.
3. **Autor ≠ revisor**, garantido no banco (CHECK com trigger) e na API.
4. **Ativar ou retornar não reprocessa nada.** O reprocessamento é operação separada, já prevista em `anatomy_runs`, e exige autorização própria.
5. **Estrutura não decide direito.** Nenhuma operação desta fase cria evidência jurídica, vigência ou seleção positiva.
6. **Auditoria completa** em `audit_log`, existente desde a migration 006, com `entity_type = 'anatomy_rules'`, hashes antes e depois e `correlation_id` por operação.
7. **Sem corpus nesta fase.** Simulação e comparação usam só exemplos sintéticos guardados com a versão. Amostras de desenvolvimento e métricas dependem de autorização futura.

## 2. Persistência (migration proposta `072_anat_rule_admin.sql`)

O schema descartável do ANAT-04 já define `anatomy_rule_sets(id, version, status, rule_hash, contract_version, profiles, author, reviewer, …)` e é referenciado por `publication_anatomies` e `anatomy_runs`.

A proposta **reaproveita** essa tabela como registro da versão de perfis e acrescenta tabelas para exemplos, comparações, revisões e o ponteiro de versão ativa. Hoje as tabelas `anatomy_*` não existem nas migrations produtivas, só no schema descartável. A ordem de aplicação (schema ANAT-04 antes da 072) depende da autorização da migration produtiva do ANAT-04, que não foi dada.

```sql
-- Proposta; NÃO aplicar. Requer autorização específica de migration produtiva.
ALTER TABLE anatomy_rule_sets
  ADD COLUMN scope_level text NOT NULL DEFAULT 'set' CHECK (scope_level IN ('set')),
  ADD COLUMN parent_rule_hash text CHECK (parent_rule_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN profile_format text NOT NULL DEFAULT 'ANAT-PROFILE/1',
  ADD COLUMN engine_hash_at_review text CHECK (engine_hash_at_review ~ '^[a-f0-9]{64}$'),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT rule_set_author_not_reviewer CHECK (reviewer IS NULL OR reviewer <> author),
  ADD CONSTRAINT rule_set_reviewed_fields CHECK ((status = 'draft') = (reviewer IS NULL AND reviewed_at IS NULL));
-- status continua draft | reviewed | retired; "ativo" é o ponteiro abaixo, não um status.
-- rule_hash = SHA-256(canonicalJson(profiles)); conferido pela aplicação e por trigger com a mesma canonicalização.

-- Imutabilidade: após 'reviewed', profiles/rule_hash/author/reviewer não mudam; nada é apagado.
CREATE FUNCTION anatomy_rule_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'anatomy_rule_sets rows are never deleted'; END IF;
  IF OLD.status <> 'draft' AND (NEW.profiles IS DISTINCT FROM OLD.profiles OR NEW.rule_hash <> OLD.rule_hash
      OR NEW.author <> OLD.author OR NEW.reviewer IS DISTINCT FROM OLD.reviewer) THEN
    RAISE EXCEPTION 'reviewed rule sets are immutable';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'retired is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER anatomy_rule_sets_guard BEFORE UPDATE OR DELETE ON anatomy_rule_sets
  FOR EACH ROW EXECUTE FUNCTION anatomy_rule_sets_guard();

-- Exemplos sintéticos (T3), versionados com o conjunto de perfis.
CREATE TABLE anatomy_rule_examples (
  rule_set_id text NOT NULL, rule_hash text NOT NULL,
  example_id text NOT NULL CHECK (example_id ~ '^[A-Za-z0-9._-]{1,64}$'
    AND example_id NOT IN ('04','06','08','09','12','14','16','18','24','28')),
  example jsonb NOT NULL,                        -- SimulationExample validado (P2), até 256 Ki UTF-16
  example_hash text NOT NULL CHECK (example_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_set_id, rule_hash, example_id),
  FOREIGN KEY (rule_set_id, rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash)
);

-- Simulações e comparações: o envelope P2 inteiro, com o id = hash do envelope.
CREATE TABLE anatomy_rule_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id text NOT NULL, rule_hash text NOT NULL,
  engine_hash text NOT NULL CHECK (engine_hash ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL, report_hash text NOT NULL CHECK (report_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('complete','partial','cancelled','failed')),
  requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_set_id, rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash)
);
CREATE TABLE anatomy_rule_comparisons (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),   -- Comparison.id (P2): hash do envelope completo
  before_rule_hash text NOT NULL, after_rule_hash text NOT NULL,
  example_id text NOT NULL, envelope jsonb NOT NULL,
  requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

-- Revisão: decisão por diferença, presa à versão candidata, às comparações e ao motor.
CREATE TABLE anatomy_rule_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id text NOT NULL, rule_hash text NOT NULL,
  engine_hash text NOT NULL CHECK (engine_hash ~ '^[a-f0-9]{64}$'),
  comparison_ids text[] NOT NULL CHECK (cardinality(comparison_ids) >= 1),
  decisions jsonb NOT NULL,                       -- Review.decisions (P2), uma por diferença
  verdict text NOT NULL CHECK (verdict IN ('clear','blocked','incomplete')),
  outcome text NOT NULL CHECK (outcome IN ('approved','rejected')),
  reviewer text NOT NULL, rationale text NOT NULL CHECK (length(rationale) BETWEEN 10 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome <> 'approved' OR verdict = 'clear'),
  FOREIGN KEY (rule_set_id, rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash)
);
-- autor ≠ revisor também aqui (trigger compara reviewer com anatomy_rule_sets.author).

-- Ponteiro de versão ativa: uma por escopo; histórico append-only.
CREATE TABLE anatomy_rule_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'anatomy',
  rule_set_id text NOT NULL, rule_hash text NOT NULL,
  review_id uuid NOT NULL REFERENCES anatomy_rule_reviews(id),
  kind text NOT NULL CHECK (kind IN ('activate','rollback')),
  previous_activation_id uuid REFERENCES anatomy_rule_activations(id),
  preview_token_hash text NOT NULL CHECK (preview_token_hash ~ '^[a-f0-9]{64}$'),
  affected_scope jsonb NOT NULL,                  -- contagens por fonte/família; nenhum reprocessamento
  actor text NOT NULL, justification text NOT NULL CHECK (length(justification) BETWEEN 10 AND 2000),
  activated_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
  FOREIGN KEY (rule_set_id, rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash)
);
CREATE UNIQUE INDEX anatomy_one_active ON anatomy_rule_activations(scope) WHERE superseded_at IS NULL;
-- Trigger: ativar exige review aprovada da MESMA (rule_set_id, rule_hash) e engine_hash igual ao vigente
-- informado pela aplicação; UPDATE só pode preencher superseded_at; DELETE proibido.
```

**RLS e permissões:**
- tabelas sem acesso de tenant (as políticas seguem a 009 para tabelas globais);
- escrita só pelo papel do backend;
- leitura administrativa pela API.

**Retenção:** nada é apagado. Os relatórios de simulação são limitados pelos limites P2 (20 exemplos, entradas de até 256 Ki).

## 3. API administrativa (`/api/v1/admin/anatomy-rules`)

Todas as rotas usam `requirePlatformAdmin` (o mesmo padrão de `taxonomy-admin.route.ts`), corpo validado por Zod em strict, `correlation_id` gerado por operação e gravação em `audit_log` na **mesma transação** da mudança.

| Método e rota | Efeito | Regras |
|---|---|---|
| `GET /versions` | Lista versões: status, hash curto, autor, revisor, ativa | Leitura |
| `GET /versions/:id/:hash` | Perfis, exemplos, simulações, comparações, revisões | Leitura |
| `POST /drafts` | Cria rascunho a partir de uma versão (`parent_rule_hash`) | `validateProfile`/`resolveEffectiveProfile` (P1); 64 KiB; piso de proteções |
| `PUT /drafts/:id` | Substitui os perfis do rascunho e recalcula `rule_hash` | Só `status = draft` e só o autor; invalida simulações e comparações antigas desse rascunho, porque o hash muda |
| `PUT /drafts/:id/examples` | Grava exemplos sintéticos | Schema P2; IDs da reserva recusados |
| `POST /drafts/:id/simulate` | Executa `simulateProfiles` **no executor isolado (§5)** e persiste o relatório | Até 20 exemplos; tempo efetivo; `cancelled` ou `partial` registrados |
| `POST /compare` | `compareProfiles` entre duas versões em um exemplo e persiste o envelope | O `id` do envelope é a chave |
| `POST /versions/:id/:hash/review` | `reviewDifferences` sobre `comparison_ids` + `outcome` + justificativa | Revisor ≠ autor; `approved` exige veredito `clear`; vincula `rule_hash` e `engine_hash` |
| `POST /activate/preview` | Calcula o escopo afetado (contagens por fonte e família cujo `ruleSetHash` mudaria) e emite um token de confirmação | Sem escrita além da auditoria; token de uso único, 10 min, preso a (versão, hash, review, ativa atual) |
| `POST /activate/confirm` | Troca o ponteiro ativo | Exige o token, review aprovada do **mesmo hash**, `engine_hash` igual e justificativa. **Não reprocessa** |
| `POST /rollback/preview` / `POST /rollback/confirm` | Reativa a versão anterior (ponteiro), sem apagar a atual | As mesmas duas etapas; a versão anterior precisa ter review aprovada própria |
| `GET /history` | Ativações, retornos e auditoria paginada | Leitura |

**Ações de auditoria:** `DRAFT_SAVED`, `EXAMPLES_SAVED`, `SIMULATED`, `COMPARED`, `REVIEWED`, `ACTIVATION_PREVIEWED`, `ACTIVATED`, `ROLLBACK_PREVIEWED`, `ROLLED_BACK`, `RETIRED`. `before_data` e `after_data` levam os hashes (`rule_hash`, `engine_hash`, `comparison_id`, ativação anterior e nova), nunca o conteúdo integral de perfis grandes.

**Erros:**
- 403 `platform_admin_required`;
- 409 `stale_preview`, quando o ponteiro ativo ou o hash mudou depois do preview;
- 409 `review_hash_mismatch`;
- 409 `author_cannot_review`;
- 422 de validação, com os códigos P1 e P2.

## 4. Ativação e retorno (duas etapas, sem reprocessamento)

1. **Preview:** lê o ativo atual e confere que existe review `approved` para (`id`, `rule_hash`) com `engine_hash` igual ao do binário em execução.
   - Calcula o escopo afetado com consultas de leitura a `publication_anatomies` (contagem por fonte e família cujo `rule_set_hash` difere).
   - Devolve o token `T = random(32)` e guarda só `SHA-256(T)`, junto com o ID da ativação atual.
2. **Confirm:** numa transação `SERIALIZABLE`:
   - confere o token, a validade, o ativo atual igual ao do preview e a review ainda válida;
   - preenche `superseded_at` da ativação atual e insere a nova (com `previous_activation_id`);
   - grava `audit_log`.
   - **Não** cria `anatomy_runs`: o reprocessamento é pedido em outra operação autorizada.
3. **Retorno:** é o mesmo fluxo, apontando para uma ativação anterior.
   - Não apaga a versão retornada.
   - **Não reaprova evidências jurídicas**: análises cuja identidade muda voltam a depender de conferência própria.
4. **Mudança de motor:** se o `engineHash` do binário diferir do `engine_hash` da review, a ativação é recusada até haver nova simulação, comparação e revisão.

## 5. Simulação isolada com limite efetivo de tempo (pré-requisito da API)

**Problema (registrado no P2):** `analyzeAnatomy` é síncrono. Hoje os 2 s são medidos depois da execução, e um perfil ou entrada patológicos poderiam ocupar o event loop do servidor.

**Proposta:**
- **Executor em `worker_threads`.** O módulo `simulation-worker.ts` roda `simulateProfiles` e `compareProfiles` fora da thread da API.
  - Um worker por requisição; no máximo **2** simultâneos por instância, fila limitada a 10 e 429 acima disso.
- **Limite efetivo por exemplo:**
  - o pai envia **um exemplo por mensagem** e arma um `setTimeout(2000)`;
  - se o prazo estourar, chama `worker.terminate()`, o que interrompe o JavaScript em execução;
  - o exemplo fica `cancelled`;
  - os exemplos seguintes rodam num worker novo, até o orçamento total (20 × 2 s) ou o cancelamento da requisição.
- **Limite de memória:** `resourceLimits` (por exemplo `maxOldGenerationSizeMb: 256`). Estouro também conta como `cancelled`.
- **Cancelamento pelo cliente:** `AbortSignal` da requisição (conexão fechada ou `DELETE /simulations/:id` enquanto `pending`) chama `terminate()`.
- **Isolamento de estado:**
  - o worker recebe só JSON (perfis, exemplos, catálogo opcional) e não tem acesso ao banco, à rede nem ao sistema de arquivos (sem `env` com segredos; `argv` mínimo);
  - o resultado volta como JSON e o pai o valida pelo schema P2 antes de persistir;
  - o pai é a fonte da verdade de `engine_hash`: o worker importa o mesmo build e o hash é comparado.
- **Determinismo:** mesma entrada, mesmo relatório (garantia P2). O cancelamento não altera exemplos já concluídos.
- **Exposição:** `POST simulate` e `POST compare` só ficam disponíveis com esse executor. Sem ele, as rotas respondem 503 `simulation_isolation_unavailable`.

## 6. Testes em banco descartável (pacote de implementação futuro)

Os testes seguem o padrão `test/anatomy.schema.integration.test.ts`, com PostgreSQL 16 descartável no CI, e usam só dados sintéticos.

1. **Migration:** aplicar a 072 sobre o schema ANAT-04 descartável; reaplicar é no-op ou erro controlado; constraints e triggers presentes.
2. **Imutabilidade:** `UPDATE` de perfis em versão revisada falha; `DELETE` em qualquer tabela de regras falha; `retired` é final.
3. **Autor ≠ revisor:** a revisão pelo autor é recusada no banco e na API.
4. **Hash exato:** alterar o rascunho depois da review muda o hash e o confirm falha com 409; review de outro hash não serve; `engine_hash` divergente bloqueia a ativação.
5. **Duas etapas:** confirm sem preview, com token expirado, reutilizado ou com ativo alterado entre preview e confirm é recusado; corrida entre dois confirms resulta em exatamente um sucesso (índice único parcial + `SERIALIZABLE`).
6. **Sem reprocessamento:** a contagem de `anatomy_runs` e `publication_anatomies` antes e depois da ativação e do retorno é idêntica.
7. **Retorno:** reativa a anterior, mantém o histórico das duas e cria auditoria `ROLLED_BACK`.
8. **Auditoria:** cada operação gera exatamente uma linha em `audit_log` com `correlation_id` e hashes, inclusive quando a operação falha depois da validação (registrada como tentativa, se o COORD quiser).
9. **Permissões:** usuário sem plataforma-admin recebe 403 em todas as rotas; tenant comum não lê as tabelas (RLS).
10. **Executor:** um exemplo sintético que roda além do prazo (gerado só no teste, por exemplo HTML com profundidade no limite e perfil válido) é `cancelled` em ≤ 2 s + margem; a API continua respondendo durante a simulação; cancelamento pelo cliente; limite de concorrência retorna 429.
11. **Reserva:** IDs da reserva recusados nos exemplos (banco e API).

## 7. Critérios de aceite das telas (P4, futura)

As telas T1–T8 do ADMIN-01 consomem só a API acima.

| Tela | Aceite |
|---|---|
| T1 Perfis e versões | Mostra a versão ativa, rascunhos, revisadas e retiradas, com hash curto, autor e revisor; o ponteiro ativo coincide com `GET /versions` |
| T2 Editor | Mostra o valor herdado e o efetivo por campo; os limites P1 são validados ao digitar e de novo no backend; não existe campo de regex |
| T3 Exemplos | Positivos e negativos com expectativa; ID da reserva recusado; até 20 |
| T4 Simulação | Mostra `pass`, `fail`, `partial` e `cancelled` por exemplo, com `ruleSetHash` e `engineHash`; nunca mostra seleção positiva |
| T5 Comparação | Diferenças por categoria com antes e depois e o `id` do envelope; contagens rotuladas como informativas |
| T6 Revisão | Exige uma decisão por diferença e justificativa; o revisor não pode ser o autor; `approved` só com veredito `clear` |
| T7 Ativação e retorno | Preview com escopo afetado e aviso explícito de que nada é reprocessado; confirm em segunda tela com justificativa; erro 409 compreensível |
| T8 Histórico | Linha do tempo de ativações e retornos com hashes e auditoria |

**Aceite da Fase 1, item "tela":** os quatro exemplos de manutenção do ADMIN-01, seção 4, feitos de ponta a ponta em ambiente de teste, com permissões e reserva testadas e trilha de auditoria conferida.

## 8. Decisões pedidas ao COORD

1. Reaproveitar `anatomy_rule_sets` ou criar uma tabela de versões administrativas separada.
2. Se as tentativas que falham depois da validação também entram em `audit_log`.
3. Parâmetros do executor: 2 simultâneos, fila de 10, 256 MB e token de 10 min.
4. Ordem das autorizações: (a) migration produtiva do ANAT-04 e da 072 em banco descartável e depois em produção; (b) executor isolado; (c) rotas; (d) telas, que dependem do repositório frontend.

**Mantidos:** reserva fechada; `BLOCK_CORPUS_INPUTS_AND_GOLD`; sem migration aplicada, API, produção, corpus real, recaptura, medição, merge ou deploy.
