# Trifaros / TAX13-R9 — RFC v2: custódia DOU, identidade documental e evidência temporal

**Status: DESIGN-ONLY / R9-DESIGN-R2 PENDING. Este arquivo NÃO é uma migration, não é um script aprovado para execução, não cria tabelas nem libera SOURCE_ADMITTED/CURRENT.** Referência congelada R9-DESIGN: backend PR #194 @ `e21334fa1b34f6af21c83d661a705fbd6ce58dfb`; BLOCK em https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6093945807. Remediação isolada no PR #195. Preservar **integralmente** a migration 048, a cadeia de PRs #186/#192/#193/#194 e o bloqueio jurídico. Sem ICP-Brasil, assinatura digital documental, ITI, OCSP ou CRL.

## 1. Posição arquitetural

O PDF original obtido de HTTPS governamental controlado basta para **comprovar a existência de uma publicação**, após correlacionar a identidade e o texto jurídico. Não é evidência de vigência de cada dispositivo. SHA-256 comprova integridade/deduplicação dos bytes vistos, **não sua procedência**. Uma string URL, um objeto `sourceCapture`, um HMAC sobre dados declarados por operador, uma fixture, ou um administrador que preenche metadados NÃO pode ser admitido como uma coleta real.

O DOU é **um documento canônico global**: um evento de captura deve ser compartilhado logicamente entre clientes; mapeamentos de relevância por tenant permanecem nos módulos e tabelas separados, protegidos por RLS de cliente. Não colocar `tenant_id` nas tabelas de captura canônica. Não armazenar arquivos originais PDF/JPG/ZIP nem texto volumoso no PostgreSQL.

### Camadas e estados NÃO equivalentes

```text
PLANNED_SOURCE ─┬─> FETCH_ATTEMPT ─> UNAVAILABLE | ERROR | REJECTED
                └─> FETCH_ATTEMPT ─> HTTP_CAPTURED
                                         │ (somente collector de rede)
                                         v
                      PDF_PARSED + INDEX_LINKED + INLABS_CORRELATED
                                         │ (verificador independente)
                                         v
                          DOCUMENTARY_SOURCE_CORRESPONDS
                                         │
                      revisão jurídica POR DISPOSITIVO/DATA
                                         v
                     PENDING/UNVERIFIED (nunca CURRENT implícito)
```

- `HTTP_CAPTURED` é **fato técnico observado** por um processo de captura segregado; não afirma correspondência normativa.
- `DOCUMENTARY_SOURCE_CORRESPONDS` requer **duas identidades de runtime**, uma coleta real e correlação por verificador segregado, que lê os **mesmos bytes efêmeros** do GET e o XML/ZIP realmente obtido; valida identidade de edição oficial, despacho, ato e limites de conteúdo. Os metadados posteriores fazem somente auditoria de um resultado ocorrido; não substituem os bytes.
- `SOURCE_ADMITTED`, se algum dia criado como função SQL de leitura, somente pode ser resultado **calculado a cada consulta** a partir de recibos de origem, correlação e credenciais não revogadas. Não é flag arbitrária gravável.
- Nenhuma das tabelas abaixo concede `CURRENT`, cria `tax13_legal_proofs_v2` ou altera `tax13_v2_original_exists_for_issuer`. A migration 048 continua limitada a HTML CONFAZ, sob controles próprios.
- `NO_RELEVANT_PUBLICATIONS` é resultado **de uma consulta integralmente concluída e sem matches de filtro**, NÃO status de download individual. `UNAVAILABLE/ERROR` jamais viram `SUCCESS(0)`.

## 2. Fronteira de confiança — R9-D01

**Credenciais e processos separados.** Scheduler gera alvos internos com provenance INLABS e controla o job; `radar_dou_collector_runtime` é LOGIN exclusivo de workload que cria um único pedido HTTPS a `pesquisa.in.gov.br` e, quando necessário, `inlabs.in.gov.br` (hosts/caminhos allowlisted por **tipo**). O coletor gera a URL, abre conexão HTTPS normal validada pela plataforma, registra status, cabeçalhos relevantes, SHA do buffer obtido, horário e código de execução; nenhuma API recebe corpo/headers/status forjados para registrar positivo. DNS/rebinding, redirects, limite de 20 MiB, timeout, comprimento e MIME devem ser controlados com regras iguais ou mais fortes às já aplicadas em `dou-official-http-pdf-capture.ts`; redirects inesperados são rejeitados. Proteger egress de máquina sem proxy controlado por usuário.

`radar_dou_verifier_runtime` é outra conta LOGIN e outro processo, com segredos e deployment isolados do coletor, sem acesso ao login/segredo de coleta. Recebe **pelo canal autenticado interno apenas o job e os bytes efêmeros da mesma captura**, obtém sua própria confirmação de índice governamental e arquivo INLABS, extrai texto nativo novamente ou verifica o digest da extração junto ao SHA dos mesmos bytes, e liga deterministicamente uma matéria, despacho e ato. Não pode aceitar `PDF_ACT_TEXT_CORRESPONDS_ONLY` emitido por API/DTO como permissão de escrita. Se o verificador não puder obter e confrontar material independente, marca PENDING/REJECTED.

O PostgreSQL não observa pacotes TLS nem consegue provar que a função Node fez GET. Sua função de inserção **somente autoriza credenciais de sessão de workloads distintos, verifica referências e encadeamento, e armazena trilha imutável**. A autenticidade operacional está no código isolado, provisionamento secreto, rede real e no processo verificador. Não mascarar a limitação com HMAC da própria aplicação. Se o verificador e collector forem comprometidos simultaneamente ou o superuser de DB for hostil, o modelo não oferece prova independente irrefutável. Logs imutáveis externos / KMS/HSM opcionais exigem autorização separada.

Credenciais com ID, data de início, data de fim e revogação *append-only*. Cada evento liga ID de credencial; o veredicto derivado é invalidado dinamicamente se uma delas for revogada. Rotação nunca altera eventos passados. Proteção anti-replay: identificador `job_id`, ordinal por tentativa e IDs de eventos imutáveis; fingerprint canônico de execução com `schema_version`, `collector_version`, `target_sha256`, resposta e tempos; verificador independente compara evento e evidência recebida; replay de `job_id+attempt_number`/correlação gera conflito, nunca novo sucesso.

## 3. Identidade exata do DOU — R9-D02

**Chave documental candidata completa:** publicação (data), seção `DO1/DO1E/DO3/DO3E`, `journal_id` da URL governamental, `printed_edition` com sufixo, página, `matter_id`, ZIP INLABS `archive_sha256`, manifesto ordenado das partes XML `xml_parts_digest`, despacho pai e versão do ato filho. O pacote pode declarar `editionNumber=80`/`DO1E`: isso **não resolve** 80-A x 80-B.

A associação oficial `journal_id=601 ↔ Nº 80-B ↔ 25/04/2024/Seção 1/página 1` precisa vir de índice/cabeçalho obtido **em uma execução** da fonte Imprensa Nacional, com URL oficial, SHA, bytes e comparação independente, vinculada ao registro XML/ZIP INLABS real. Dados digitados no campo `printedEdition`, índice de buscador ou uma URL isolada só geram **candidato**, não evento `INDEX_LINKED`. Índices ausentes, conflitantes ou com sufixo não comprovado impedem correlação positiva. DOU 80, 80-A, 80-B são identidades diferentes mesmo que data/número sem sufixo coincidam.

Não afirmar equivalência dos PDFs conhecidos: GET Railway (descartado, `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`) e upload 80-B (`e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`) **têm hashes distintos**; não há bytes históricos para confrontar texto. Campo futuro `documentary_comparison = PENDING`. Nenhum serviço Railway novo está autorizado.

## 4. Contrato relacional proposto — R9-D04

**Abaixo há DDL de referência para crítica, NÃO executável como migration, SEM autorização para aplicar.** Nomes novos intencionalmente não conflitam com 048. Revisão por DBA de compatibilidade com schemas 044–048, privilégios existentes, locks, migration order, performance e rollback é obrigatória. Identificadores FK de `publication_versions` refletem modelo já existente; checar constraint exata no HEAD de implementação antes de escrever 049+.

```sql
-- R9-DESIGN ONLY, NOT A MIGRATION. Requires explicit role provisioning
-- independently from app/worker/curator/issuer/sealer. No passwords here.
CREATE ROLE radar_dou_evidence_owner NOLOGIN;
CREATE ROLE radar_dou_collector_runtime LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE radar_dou_verifier_runtime LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE radar_dou_read_runtime LOGIN NOINHERIT NOBYPASSRLS;
-- Privileged migration owner owns objects. All role memberships/grants to
-- radar_app_runtime, radar_worker_runtime, curator, issuer, sealer and tenant
-- accounts are forbidden. Do not grant either collector/verifier role to
-- shared application logins.

CREATE TABLE public.tax13_dou_source_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 publication_date date NOT NULL CHECK (publication_date >= DATE '2020-01-01'),
 section text NOT NULL CHECK (section IN ('DO1','DO1E','DO3','DO3E')),
 journal_id text NOT NULL CHECK (journal_id ~ '^[0-9]{1,4}$'),
 printed_edition text NOT NULL CHECK (printed_edition ~ '^[0-9]{1,4}(-[A-Z])?$'),
 page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 9999999),
 matter_id text NOT NULL CHECK (matter_id ~ '^[0-9]+$'),
 archive_sha256 char(64) NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
 xml_parts_digest char(64) NOT NULL CHECK (xml_parts_digest ~ '^[a-f0-9]{64}$'),
 parent_dispatch_version_id uuid NOT NULL
   REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 child_act_version_id uuid NOT NULL
   REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 identity_schema_version smallint NOT NULL DEFAULT 2 CHECK (identity_schema_version=2),
 identity_fingerprint char(64) NOT NULL UNIQUE CHECK (identity_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK ((section IN ('DO1E','DO3E')) =
   (printed_edition ~ '-[A-Z]$')),
 CHECK (split_part(printed_edition,'-',1) ~ '^[0-9]+$')
);
CREATE UNIQUE INDEX uq_tax13_dou_identity_complete
 ON public.tax13_dou_source_identities (
  publication_date,section,journal_id,printed_edition,page_number,matter_id,
  archive_sha256,xml_parts_digest,parent_dispatch_version_id,child_act_version_id);
CREATE INDEX ix_tax13_dou_identity_act
 ON public.tax13_dou_source_identities(child_act_version_id,publication_date DESC);

CREATE TABLE public.tax13_dou_collection_jobs (
 id uuid PRIMARY KEY,
 internal_target_sha256 char(64) NOT NULL CHECK (internal_target_sha256 ~ '^[a-f0-9]{64}$'),
 source_identity_id uuid REFERENCES public.tax13_dou_source_identities(id) ON DELETE RESTRICT,
 scheduled_for timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 scheduler_version text NOT NULL CHECK (length(scheduler_version) BETWEEN 1 AND 80)
);
CREATE INDEX ix_tax13_dou_jobs_target ON public.tax13_dou_collection_jobs
 (internal_target_sha256,scheduled_for DESC);

CREATE TABLE public.tax13_dou_runtime_credentials (
 id uuid PRIMARY KEY,
 principal text NOT NULL CHECK (principal IN ('COLLECTOR','VERIFIER')),
 key_reference text NOT NULL UNIQUE CHECK (length(key_reference) BETWEEN 12 AND 250),
 active_from timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK (expires_at>active_from),
 issued_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
-- key_reference is an ID only: never store passwords/HMAC or private keys in PG.
CREATE TABLE public.tax13_dou_credential_revocations (
 credential_id uuid PRIMARY KEY
   REFERENCES public.tax13_dou_runtime_credentials(id) ON DELETE RESTRICT,
 revoked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z_]{4,64}$')
);

CREATE TABLE public.tax13_dou_http_fetch_events (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id) ON DELETE RESTRICT,
 attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 1000),
 source_identity_id uuid REFERENCES public.tax13_dou_source_identities(id) ON DELETE RESTRICT,
 purpose text NOT NULL CHECK (purpose IN ('DOU_PDF','DOU_INDEX','INLABS_ARCHIVE')),
 outcome text NOT NULL CHECK (outcome IN ('CAPTURED','UNAVAILABLE','ERROR','REJECTED')),
 requested_url text NOT NULL CHECK (length(requested_url) BETWEEN 30 AND 2048),
 final_url text,
 http_status integer CHECK (http_status BETWEEN 100 AND 599),
 content_type text,
 byte_count bigint CHECK (byte_count BETWEEN 0 AND 20971520),
 document_sha256 char(64) CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL CHECK (finished_at>=started_at),
 collector_credential_id uuid NOT NULL
   REFERENCES public.tax13_dou_runtime_credentials(id) ON DELETE RESTRICT,
 collector_version text NOT NULL CHECK (length(collector_version) BETWEEN 1 AND 100),
 sanitized_error_code text CHECK (sanitized_error_code ~ '^[A-Z0-9_]{3,96}$'),
 event_fingerprint char(64) NOT NULL UNIQUE CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE (job_id,attempt_number,purpose),
 CHECK (
  (outcome='CAPTURED' AND http_status=200 AND final_url IS NOT NULL
     AND byte_count>0 AND document_sha256 IS NOT NULL AND sanitized_error_code IS NULL)
  OR
  (outcome<>'CAPTURED' AND document_sha256 IS NULL AND sanitized_error_code IS NOT NULL)
 )
);
CREATE INDEX ix_tax13_dou_fetch_identity_time
 ON public.tax13_dou_http_fetch_events(source_identity_id,finished_at DESC);
CREATE INDEX ix_tax13_dou_fetch_retry
 ON public.tax13_dou_http_fetch_events(job_id,purpose,attempt_number);

CREATE TABLE public.tax13_dou_verification_events (
 id uuid PRIMARY KEY,
 pdf_fetch_event_id uuid NOT NULL
   REFERENCES public.tax13_dou_http_fetch_events(id) ON DELETE RESTRICT,
 index_fetch_event_id uuid NOT NULL
   REFERENCES public.tax13_dou_http_fetch_events(id) ON DELETE RESTRICT,
 inlabs_fetch_event_id uuid NOT NULL
   REFERENCES public.tax13_dou_http_fetch_events(id) ON DELETE RESTRICT,
 source_identity_id uuid NOT NULL
   REFERENCES public.tax13_dou_source_identities(id) ON DELETE RESTRICT,
 verifier_credential_id uuid NOT NULL
   REFERENCES public.tax13_dou_runtime_credentials(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK (outcome IN ('VERIFIED','REJECTED','UNVERIFIED')),
 pdf_extract_digest char(64) CHECK (pdf_extract_digest ~ '^[a-f0-9]{64}$'),
 index_to_printed_edition_digest char(64)
   CHECK (index_to_printed_edition_digest ~ '^[a-f0-9]{64}$'),
 xml_archive_correlated_digest char(64)
   CHECK (xml_archive_correlated_digest ~ '^[a-f0-9]{64}$'),
 normalization_version text NOT NULL,
 verifier_version text NOT NULL,
 checked_at timestamptz NOT NULL,
 verifier_report_sha256 char(64) NOT NULL UNIQUE
   CHECK (verifier_report_sha256 ~ '^[a-f0-9]{64}$'),
 error_code text CHECK (error_code ~ '^[A-Z0-9_]{3,96}$'),
 UNIQUE (pdf_fetch_event_id,verifier_credential_id,verifier_report_sha256),
 CHECK (pdf_fetch_event_id<>index_fetch_event_id
        AND pdf_fetch_event_id<>inlabs_fetch_event_id
        AND index_fetch_event_id<>inlabs_fetch_event_id),
 CHECK (
  (outcome='VERIFIED' AND pdf_extract_digest IS NOT NULL
    AND index_to_printed_edition_digest IS NOT NULL
    AND xml_archive_correlated_digest IS NOT NULL AND error_code IS NULL)
  OR
  (outcome<>'VERIFIED' AND error_code IS NOT NULL)
 )
);
CREATE INDEX ix_tax13_dou_verification_identity
 ON public.tax13_dou_verification_events(source_identity_id,checked_at DESC);

CREATE TABLE public.tax13_dou_act_correlations (
 id uuid PRIMARY KEY,
 verified_event_id uuid NOT NULL UNIQUE
   REFERENCES public.tax13_dou_verification_events(id) ON DELETE RESTRICT,
 source_identity_id uuid NOT NULL
   REFERENCES public.tax13_dou_source_identities(id) ON DELETE RESTRICT,
 parent_dispatch_version_id uuid NOT NULL
   REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 child_act_version_id uuid NOT NULL
   REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK (outcome IN ('TEXT_CORRESPONDS','REJECTED','UNVERIFIED')),
 act_boundary_start integer CHECK (act_boundary_start>=0),
 act_boundary_end integer CHECK (act_boundary_end>act_boundary_start),
 full_act_normalized_sha256 char(64)
   CHECK (full_act_normalized_sha256 ~ '^[a-f0-9]{64}$'),
 algorithm_version text NOT NULL,
 comparison_report_sha256 char(64) NOT NULL UNIQUE
   CHECK (comparison_report_sha256 ~ '^[a-f0-9]{64}$'),
 checked_at timestamptz NOT NULL,
 error_code text CHECK (error_code ~ '^[A-Z0-9_]{3,96}$'),
 CHECK ((outcome='TEXT_CORRESPONDS' AND full_act_normalized_sha256 IS NOT NULL
         AND act_boundary_start IS NOT NULL AND act_boundary_end IS NOT NULL
         AND error_code IS NULL)
    OR (outcome<>'TEXT_CORRESPONDS' AND error_code IS NOT NULL))
);
CREATE INDEX ix_tax13_dou_correlation_act
 ON public.tax13_dou_act_correlations(child_act_version_id,checked_at DESC);

CREATE TABLE public.tax13_dou_temporal_review_events (
 id uuid PRIMARY KEY,
 correlation_id uuid NOT NULL
   REFERENCES public.tax13_dou_act_correlations(id) ON DELETE RESTRICT,
 device_ref text NOT NULL CHECK (length(device_ref) BETWEEN 1 AND 240),
 event_type text NOT NULL CHECK (event_type IN (
  'ORIGINAL_PUBLICATION','RATIFICATION','EFFECTS_FROM','EXCEPTIONAL_DEADLINE',
  'REFERENCE_PERIOD','CORRECTION','AMENDMENT','REVOCATION','SUPERSESSION',
  'REVIEW_PENDING','REVIEW_UNVERIFIED')),
 event_date date, effect_from date, effect_to date,
 as_of date NOT NULL,
 official_evidence_url text NOT NULL CHECK (official_evidence_url LIKE 'https://%'),
 official_evidence_sha256 char(64)
   CHECK (official_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewer_actor text NOT NULL CHECK (length(reviewer_actor) BETWEEN 4 AND 120),
 reviewer_version text NOT NULL,
 legal_review_status text NOT NULL CHECK (legal_review_status IN (
  'PENDING','UNVERIFIED','REQUIRES_HUMAN_REVIEW')),
 supersedes_event_id uuid REFERENCES public.tax13_dou_temporal_review_events(id)
   ON DELETE RESTRICT,
 event_fingerprint char(64) NOT NULL UNIQUE
   CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK (effect_to IS NULL OR effect_from IS NULL OR effect_to>=effect_from),
 CHECK (supersedes_event_id IS NULL OR supersedes_event_id<>id)
);
CREATE INDEX ix_tax13_dou_temporal_by_device
 ON public.tax13_dou_temporal_review_events(correlation_id,device_ref,as_of DESC);
```

**Regras adicionais para aceitação da futura migration:** `tax13_dou_collection_jobs` só pode ser criado pelo scheduler interno, com role própria ou operação de provisionamento isolada; a DDL acima é **rascunho de contrato**, não decisão de manter scheduler no mesmo esquema. O revisor R9-DESIGN-R2 deve avaliar necessidade de manter entidade `jobs` e `runtime_credentials` versus reutilizar entidades existentes. Todos os registros são globais, imutáveis, e nenhuma tabela aceita `tenant_id` ou PDF `BYTEA`.

### 4.1. Canonicalização, fingerprint, idempotência, transações

`identity_fingerprint = SHA256(UTF8(canonical_JSON_V2))`, gerado pela aplicação fechada e **recalculado pelo verificador**, com serialização canônica (chaves ordenadas, UTF-8/NFC, datas ISO, URLs canonizadas por parser allowlisted, tipos explícitos, números como strings normalizadas, partes XML em ordem fixada por `filename`). Não concatene campos sem delimitador; rejeite duplicatas de chave e arrays em ordem inesperada. `event_fingerprint` usa `domain='TRIFAROS:DOU:FETCH:2'` + job UUID + attempt ordinal + purpose + URL reconstruída + `outcome` + digest de corpo quando CAPTURED + horários efetivos + versão de coletor. O fingerprint **não autentica a rede**; previne colidir/deduplicar outro evento por engano.

Criação do job: `UNIQUE internal_target_sha256+scheduled_for` **não** é segura contra retentativa operacional deliberada; permitir rechecks cronológicos sob IDs de jobs distintos, com tentativas por job serializadas/advisory lock e contador monotônico. `UNIQUE(job_id, attempt_number, purpose)` rejeita replays conflitantes; retries novos têm ordinal crescente e resultado distinto, sem sobrescrever erro anterior. Sem `UPDATE` em nenhum evento.

O trabalho real de rede nunca ocorre dentro de transação SQL. Após captura, em transação curta `BEGIN ... COMMIT`, insert em `fetch_events` com credencial collector, e depois verificador independente faz outra transação curta para `verification_events + act_correlations`, com FK,锁 serializado por `source_identity_id`, conflitos positivos vedados. Uma verificação positiva precisa dos três fetches observados com propósito certo, `outcome=CAPTURED`, URLs autorizadas, mesmos `job_id` e `source_identity_id` e hashes consistentes. Essas condições não são apenas CHECK declarativos: são validadores nas funções SECURITY DEFINER de admissão. Inserção conflitante é REJECTED com evento histórico, nunca overwrite.

**Condição futura de exclusividade:** índice parcial pode bloquear dois `TEXT_CORRESPONDS` simultâneos por `source_identity_id`, mas esse índice proibiria re-verificações válidas ao longo do tempo. Preferir `pg_advisory_xact_lock(hashtextextended(source_identity_id::text,0))`, projetar estado efetivo com `ORDER BY checked_at DESC, id` e detectar dois positivos incompatíveis na mesma data/artefato. Re-fetch do mesmo SHA tem evento novo e reavalia status corrente; não reusa captura antiga como nova rede. Rever performance do lock e transações no R9-R2.

### 4.2. ACL, RLS, funções e TRIGGER: minuta de contrato

```sql
-- DESIGN ONLY. Aplicar bloco de política individual por tabela da seção 4
-- com o owner NOLOGIN (inclusive tabelas jobs/credential_revocations).
-- Nenhuma concessão de SELECT/INSERT de tabela para app/worker/tenant.
ALTER TABLE public.tax13_dou_http_fetch_events OWNER TO radar_dou_evidence_owner;
ALTER TABLE public.tax13_dou_http_fetch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_dou_http_fetch_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tax13_dou_http_fetch_events FROM PUBLIC;
-- Políticas SELECT e INSERT são distintas: somente collector pode inserir,
-- owner NOLOGIN pode ler sob FORCE RLS e nenhum tenant tem SELECT.
CREATE POLICY dou_http_owner_insert ON public.tax13_dou_http_fetch_events
 FOR INSERT TO radar_dou_evidence_owner WITH CHECK (true);
CREATE POLICY dou_http_owner_read ON public.tax13_dou_http_fetch_events
 FOR SELECT TO radar_dou_evidence_owner USING (true);
-- NÃO conceder INSERT direto à role collector. Somente a função
-- SECURITY DEFINER, de propriedade do owner NOLOGIN, faz a gravação.
-- O owner possui política WITH CHECK; o session_user é o login real.

-- Usar trigger imutável que não pode ser invocado como ação de DML externa;
-- aplicar A TODAS as tabelas R9 e proibir TRUNCATE por ACL.
CREATE FUNCTION public.tax13_dou_no_mutation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 BEGIN
   RAISE EXCEPTION 'TAX13_DOU_APPEND_ONLY';
 END $$;
REVOKE ALL ON FUNCTION public.tax13_dou_no_mutation() FROM PUBLIC;
CREATE TRIGGER trg_dou_http_immutable BEFORE UPDATE OR DELETE
 ON public.tax13_dou_http_fetch_events FOR EACH ROW
 EXECUTE FUNCTION public.tax13_dou_no_mutation();

-- EXEMPLO de gateway; a implementação 049+ deve expor apenas EXECUTE
-- aos workload identities. Não oferecer p_http_status/p_sha/p_bytes/p_result
-- a API/tenants: são dados privativos do próprio código de coleta.
-- SECURITY DEFINER é apenas ACL, não prova TLS. Validar job/internal URL,
-- credencial não revogada, session_user exato, timestamp, purpose, idempotência.
-- A função deve rejeitar todos os INSERTs por chamadas fora do coletor.
-- Revogação dinâmico consulta tax13_dou_credential_revocations.
--
-- CREATE FUNCTION public.tax13_dou_record_verified_capture(...)
-- RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
-- SET search_path = pg_catalog,public,pg_temp AS $$
-- BEGIN
--   IF session_user <> 'radar_dou_collector_runtime' THEN
--     RAISE EXCEPTION 'TAX13_DOU_COLLECTOR_SESSION_REQUIRED';
--   END IF;
--   -- require registered job + exact target, actual collector identity;
--   -- check active unrevoked credential, replay/clock skew and constraints.
--   -- INSERT into global event after real collector observed the network.
-- END $$;
-- REVOKE ALL ON FUNCTION public.tax13_dou_record_verified_capture(...)
--   FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.tax13_dou_record_verified_capture(...)
--   TO radar_dou_collector_runtime;
```

**Aprovação SQL condicionada:** o SQL ilustrativo ainda contém **função de admissão intencionalmente não implementada** e policies demonstrativas. Revisão R9-DESIGN-R2 deve aprovar *contrato, papéis e DDL*, não a executoriedade do snippet. Na migration real, (a) todas as tabelas RLS/FORCE antes dos grants, (b) triggers imutáveis e owner restrito, (c) funções com `session_user` conferido + target recomputado + propósito/resposta/credencial verificadas, (d) `REVOKE ALL ON FUNCTION ... FROM PUBLIC` incluindo default EXECUTE, (e) audit `search_path`/schema, (f) SECURITY DEFINER para leitura apenas sobre as tabelas estritas e (g) migrator não vira role de runtime. Nenhum SQL genérico é parte do protocolo da API.

**Read path:** serviço comum recebe apenas `source_publication_status = VERIFIED / UNVERIFIED / PENDING` de função projetora invocada via `radar_dou_read_runtime` com SELECT restrito a metadados globais. Não expor registro de credenciais nem recargos HMAC, não permitir o usuário selecionar/outro tenant manipular identidades. Se tabelas de afinidade por tenant apontarem para `child_act_version_id`, isolamento no join desse módulo é obrigatório e avaliado separadamente.

### 4.3. Contrato de funções de admissão (minuta SQL para revisão)

A política de inserção é somente de **radar_dou_evidence_owner**. Nem coletor nem verificador recebe INSERT direto. A função SECURITY DEFINER é de propriedade do owner NOLOGIN; session_user continua sendo o login de conexão real (não muda com SET ROLE). Os alvos têm de ser cadastrados pelo scheduler: a URL escolhida não pode ser parâmetro independente do coletor.

**Extensão proposta da tabela jobs:** planned_pdf_url, planned_index_url e planned_archive_url, cada um com CHECK rigoroso de host/caminho/query por finalidade e NOT NULL na versão migratória. A função abaixo mostra a exigência de que a tentativa esteja vinculada ao alvo. Não é prova criptográfica de rede: sem um processo coletor confiável, qualquer hash do corpo declarado pode ser falso.

~~~sql
-- DESIGN ONLY, NÃO EXECUTAR EM PRODUÇÃO.
ALTER TABLE public.tax13_dou_collection_jobs
 ADD COLUMN planned_pdf_url text,
 ADD COLUMN planned_index_url text,
 ADD COLUMN planned_archive_url text;

CREATE FUNCTION public.tax13_dou_record_capture(
 p_job uuid, p_attempt integer, p_purpose text, p_url text,
 p_http_status integer, p_content_type text, p_len bigint,
 p_sha char(64), p_started timestamptz, p_finished timestamptz,
 p_credential uuid, p_collector_version text,
 p_error text, p_fingerprint char(64)
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $
DECLARE
 j public.tax13_dou_collection_jobs%ROWTYPE;
 c public.tax13_dou_runtime_credentials%ROWTYPE;
 expected_url text; outcome text;
 new_id uuid := gen_random_uuid();
BEGIN
 IF session_user IS DISTINCT FROM 'radar_dou_collector_runtime' THEN
  RAISE EXCEPTION 'DOU_COLLECTOR_SESSION_REQUIRED';
 END IF;
 SELECT * INTO j FROM public.tax13_dou_collection_jobs WHERE id=p_job;
 SELECT * INTO c FROM public.tax13_dou_runtime_credentials WHERE id=p_credential;
 IF j.id IS NULL OR c.id IS NULL OR c.principal<>'COLLECTOR'
    OR p_started<c.active_from OR p_finished>=c.expires_at
    OR EXISTS(SELECT 1 FROM public.tax13_dou_credential_revocations r
              WHERE r.credential_id=c.id)
    OR p_finished<p_started
    OR p_finished>statement_timestamp()+interval '30 seconds'
    OR p_finished<statement_timestamp()-interval '120 seconds' THEN
   RAISE EXCEPTION 'DOU_CAPTURE_IDENTITY_INVALID';
 END IF;
 expected_url:=CASE p_purpose
  WHEN 'DOU_PDF' THEN j.planned_pdf_url
  WHEN 'DOU_INDEX' THEN j.planned_index_url
  WHEN 'INLABS_ARCHIVE' THEN j.planned_archive_url ELSE NULL END;
 IF expected_url IS NULL OR p_url IS DISTINCT FROM expected_url THEN
   RAISE EXCEPTION 'DOU_CAPTURE_TARGET_INVALID';
 END IF;
 -- O banco NÃO vê os bytes TLS: é o código de coleta isolado que origina
 -- os parâmetros. Verificação independente é obrigatória depois.
 outcome:=CASE WHEN p_error IS NOT NULL THEN 'ERROR'
  WHEN p_http_status=200 THEN 'CAPTURED' ELSE 'REJECTED' END;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_job::text||':'||p_purpose,0));
 INSERT INTO public.tax13_dou_http_fetch_events(
   id,job_id,attempt_number,source_identity_id,purpose,outcome,
   requested_url,final_url,http_status,content_type,byte_count,document_sha256,
   started_at,finished_at,collector_credential_id,collector_version,
   sanitized_error_code,event_fingerprint
 ) VALUES (
   new_id,p_job,p_attempt,j.source_identity_id,p_purpose,outcome,
   p_url,CASE WHEN outcome='CAPTURED' THEN p_url ELSE NULL END,
   p_http_status,p_content_type,p_len,
   CASE WHEN outcome='CAPTURED' THEN p_sha ELSE NULL END,
   p_started,p_finished,p_credential,p_collector_version,
   CASE WHEN outcome='CAPTURED' THEN NULL ELSE COALESCE(p_error,'HTTP_NOT_ACCEPTED') END,
   p_fingerprint
 );
 RETURN new_id;
END $;
REVOKE ALL ON FUNCTION public.tax13_dou_record_capture(
 uuid,integer,text,text,integer,text,bigint,char(64),
 timestamptz,timestamptz,uuid,text,text,char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax13_dou_record_capture(
 uuid,integer,text,text,integer,text,bigint,char(64),
 timestamptz,timestamptz,uuid,text,text,char(64))
 TO radar_dou_collector_runtime;
~~~

**Verificador segregado:** função de admissão, com session_user obrigatório **radar_dou_verifier_runtime** e pertencente ao owner, recebe apenas referências a eventos que já existam e digests de comparação. Valida internamente, em transação serializada: três fetches CAPTURED, purpose PDF/INDEX/INLABS correspondentes, mesmo job + identity, IDs não iguais, URLs estritas, credenciais não expiradas/não revogadas, hash da resposta PDF coincidente com bytes vistos no verificador, índice → journal/sufixo/documento, digest real de ZIP/partes XML, despacho/ato e delimitação textual. Faz INSERT de verification + correlation na mesma transação ou rollback. Nenhum parâmetro verified=true nem DTO externo constitui validação. A verificação do conteúdo da rede/XML acontece em processo confiável separado; SQL não pode reexecutar parser PDF apenas a partir de hashes.

**Lacuna residual explícita:** a segunda função completa não é fornecida como função SQL executável nesta RFC, porque modelá-la como aceitação de um boolean validado pelo próprio chamador criaria a falha R9-D01. O futuro código de integração precisa ser projetado e testado conjuntamente. O R9-DESIGN-R2 deverá julgar se o contrato e a separação proposta são suficientes como desenho; não se deve declarar aprovado um verificador cujo código ainda não existe.

## 5. Conteúdo e extração — R9-D03 / R9-D07

`correlateOfficialDouPdfActText` é função unitária de comparação, construível a partir de objetos manuais; só retorna **candidato não admissível** (`sqlSourceAdmissionAllowed=false`). O status textual sozinho nunca alimenta `tax13_dou_act_correlations` positivo. O algoritmo de admissão (futuro) deve exigir capturas verificador + coletor + bytes originais correlacionados.

Normalização versionada: `DOU_PDF_TEXT_BOUNDARIES_V2` usa NFKC, normalização de espaço e símbolos tipográficos específicos, **preserva acentos, dígitos, pontuação material, números, ordem e cláusulas**. Guarda SHA do texto normalizado e `act_boundary_start/end`. Exigir no cabeçalho: rótulo DIÁRIO OFICIAL, Seção 1/3, edição 80 vs 80-A vs 80-B, data; cabeçalho não pode ser inferido do corpo. Identificar despacho pai, título do ato filho e posição exata do início, texto integral cláusula a cláusula e limites de término. Texto excedente/confuso exige REJECTED/UNVERIFIED; outro ato correto na página é permitido apenas quando os limites e ordem forem conhecidos. Captura de fragmentos separados precisa preservar geometria e origem (parser e versão). Uma comparação `includes` ou remoção indiscriminada de pontuação não é admissível por si.

`PDFJS_NATIVE_SPATIAL_V2` prepara espaçamento por coordenadas/hasEOL e falha fechado para ordem ascendente/movimentação lateral ambígua. Esse algoritmo **não foi calibrado** com PDF oficial 80-B da resposta Railway, cujos bytes foram descartados. Testes sintéticos não substituem corpus real multi-bloco/multi-coluna de páginas únicas. Qualquer extração inconsistente é `UNVERIFIED`, nunca CURRENT.

## 6. Cronologia por dispositivo — R9-D08

`tax13_dou_temporal_review_events` registra eventos distintos com `device_ref`/cláusula, `as_of`, evidence URL/digest, períodos, revisão, fonte, versão e supersession. Reunião factual não gera CURRENT. O Convênio ICMS 15/24 possui publicação original em 25/04/2024, prazo excepcional em 25/04, ratificação em 02/05, efeitos declarados em 01/04 e período referenciado março/2024. Uma deadline transcorrida **não** demonstra revogação ou ausência de vigência; ratificação **não** implica efeito operacional geral atual. Revisões de alterações, retificações, dispositivos afetados e aplicabilidade em data de referência continuam PENDING, e qualquer alteração posterior exige novo evento append-only (sem reescrever histórico). Não reaproveitar `CURRENT` do CONFAZ/048 para DOU.

## 7. Falha, consulta e retenção — R9-D05/D06

Fluxo de estados por coleta: `PLANNED` → `FETCH_ATTEMPT` → `CAPTURED` ou `UNAVAILABLE/ERROR/REJECTED`. Consultas completas sem matches podem gerar um **evento de resultado de run** `NO_RELEVANT_PUBLICATIONS` somente se TODAS as fontes/partições previstas do run tiveram término verificado. Nenhum erro parcial pode ser transformado em resultado negativo de publicação. A ausência de fonte/XML/índice gera status de evidência `PENDING/UNVERIFIED`.

Retenção mínima: manter metadados, SHA, URLs oficiais exatas, latência/status, código de erro sanitizado, referências de edição, job, versões e eventos imutáveis. Não armazenar corpo PDF/JPG/ZIP, raw HTTP nem imagens no PostgreSQL. **Limitação explícita:** sem os bytes, não se pode repetir extração, provar equivalência textual retrospectiva ou reconstruir a antiga resposta se a origem mudar. Re-fetch futuro é **novo evento** potencialmente com novo SHA; jamais equivale à captura anterior automaticamente. Objeto original único, imutável e com lifecycle fora do banco, referenciado por hash, é opção futura a dimensionar/autorização específica (não implementada aqui). Retenção desses metadados jurídicos necessita política de prazo e proteção LGPD/operacional aprovada na implantação; nunca apagar trilha de auditoria enquanto vinculada a prova ativa.

## 8. Matriz de aceitação / gates

| Caso de ataque/erro | Resultado requerido e verificação |
| --- | --- |
| DTO `sourceCapture` criado manualmente | UNIT pode correlacionar candidato; banco **não** admite, pois falta IDs/roles/bytes/verificação |
| Seção impressa 3 com trace DO1 | `UNVERIFIED` |
| Regular 80/Extra 80-A/Extra 80-B | Mesmo base 80 nunca basta, exige índice oficial + sufixo |
| Jornal ID/matéria/ZIP/XML errados | `UNVERIFIED` com mismatch, nenhum `TEXT_CORRESPONDS` persistível |
| Despacho certo, cláusula truncada/trocada | `UNVERIFIED` |
| Corpo jurídico adicional conflitando | `UNVERIFIED`; não confiar só em `includes` |
| PDF malformado, tamanho, redirecionamento | `REJECTED`/ERROR de coleta, jamais sucesso |
| HTTPS indisponível | `UNAVAILABLE/ERROR` + retry, jamais `NO_RELEVANT_PUBLICATIONS` |
| Concorrência de dois coletores | 2 tentativas históricas separadas, 1 posição efetiva consistente |
| HMAC arbitrário/role de app/worker/curator/issuer/sealer | Nenhum `CAPTURED`/`VERIFIED`; chaves fora do banco |
| UPDATE/DELETE/TRUNCATE ou RLS bypass | Negados em PG16 e PG18; triggers + ACL/FORCE RLS |
| Tenant A/B | Apenas relatório de relevância individual isolado; fonte global read-only |
| Revogação da credential de qualquer etapa | Veredicto efetivo volta para `UNVERIFIED` sem apagar eventos |
| Repetição de job/ordinal ou evento forjado | Conflito imutável; um retry legítimo usa próximo ordinal |
| Prova documental + ratificação sem emendas revisadas | `LEGAL_CURRENT=PENDING`; 048 intocada |
| CI positivo sintético antigo | Falha 048 `TAX13_R8_ORIGINAL_HTTP_UNVERIFIED` permanece esperada |
| Captura real 80-B + XML + índice com mesmos bytes | **PENDENTE**, sem autorização para serviço Railway novo |

Executar TypeScript, unit DOU de layout e negativas com mocks sem origem oficial; PG16/18 de 049+ **somente após R9-DESIGN-R2 APPROVED e implementação aditiva autorizada**. Não desabilitar R7/TAX11, não criar recibos de fixture, não retomar DOU 1991/1997, sem merge/deploy/produção.

## 9. Questões explícitas ao revisor independente R9-DESIGN-R2

1. A autorização em duas sessões coletor/verificador, com verificações efetivamente independentes de índice e INLABS, é suficiente para o threat model definido, considerando que PostgreSQL não observa o TLS?
2. A composição de tabelas é mínima? Reutilizar `collection_runs` e registros de fontes existentes em vez da nova tabela jobs traz risco de integridade histórica? É necessário evento específico para resultados `NO_RELEVANT_PUBLICATIONS`?
3. A chave de identidade `journal_id + printed_edition + ZIP/XML + despacho/ato` é completa? Como atestar o índice governamental sem depender de parâmetro do cliente?
4. Os controles de RLS/FORCE RLS, ACL, session_user, transações atômicas e revogação descritos bastam como desenho, ou falta DDL de funções para aprovação?
5. A abordagem de delimitação do texto e a extração espacial sintética sustentam o *desenho*, enquanto a coleta real pendente sustenta futuro teste operacional?
6. A projeção SOURCE sem CURRENT, revogação, retenção sem bytes e multi-tenant mantém os gates da migration 048 sem risco de promoção automática?

**Parecer do executor: submetido para revisão, NÃO APPROVED.**