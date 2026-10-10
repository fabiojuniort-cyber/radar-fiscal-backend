# Trifaros — TAX13 / R9-DESIGN-R3: ÚNICO CONTRATO NORMATIVO DOU

**STATUS: PROPOSTA PARA REVISÃO ADVERSARIAL. NÃO APPROVED. NÃO É MIGRATION 049+. NÃO EXECUTAR SQL EM PRODUÇÃO.**

Este documento substitui, para decisões futuras, AMBOS os RFCs v2 de PR #195: TAX13_R9_DOU_EVIDENCE_SQL_RFC_V2.md e TAX13_R9_DOU_SOURCE_EVIDENCE_SQL_RFC_V2.md. Esses arquivos são históricos, não alternativas executáveis. Revisão R9-R2: BLOCK em https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094176735, SHA auditado 29dbae16e6b2cf1475b43450a280090a1ea7ff03. Este R3 é incremental no draft PR #196 sobre #195. Preservar migration 048 e bloqueios R7/TAX11, nunca criar prova CONFAZ sintética. PDF obtido diretamente de HTTPS governamental, com identidade/texto correlacionados, basta para PUBLICAÇÃO; jamais equivale a CURRENT. NÃO exigir certificados de assinatura documental, ICP, ITI, OCSP ou CRL.

## 1. Modelo único e política da confiança (D01/D02/D04)

Sete papéis exclusivos, provisionados fora do app, todos sem BYPASSRLS nem credencial compartilhada:

- radar_dou_ledger_owner: NOLOGIN, dono de tabelas e funções restritas.
- radar_dou_scheduler_runtime: LOGIN, cria jobs cujos alvos são derivados de templates internos governamentais.
- radar_dou_collector_runtime: LOGIN isolado, realiza o primeiro GET HTTPS direto e registra apenas seus próprios eventos.
- radar_dou_verifier_runtime: LOGIN e deployment/segredos isolados, repete INDEPENDENTEMENTE os GETs governamentais, reextrai e compara conteúdo; não recebe bytes/hash declarados pelo collector como substituto da própria aquisição.
- radar_dou_credential_admin_runtime: LOGIN, emite/revoga credenciais, sem poder capturar.
- radar_dou_temporal_runtime: LOGIN, registra fatos jurídicos por dispositivo, sem atestar origem.
- radar_dou_read_runtime: LOGIN, somente EXECUTE de uma projeção read-only do status documental; a aplicação usa este gateway, não recebe acesso ao ledger bruto.

Tabelas canônicas GLOBAIS, sem tenant_id: (1) runtime_credentials; (2) credential_revocations; (3) collection_jobs; (4) http_fetch_events; (5) archive_manifest; (6) edition_bindings; (7) verification_events; (8) act_correlations; (9) temporal_review_events. Todas prefixadas tax13_dou_. Não manter outras tabelas redundantes para jobs ou identidade. Relevância por empresa pertence a associações separadas com RLS de tenant. PDF, ZIP, JPG e outros binários NÃO entram em PostgreSQL.

Três alvos por job: PDF da Imprensa Nacional, ÍNDICE OFICIAL da edição e ZIP INLABS. As partes XML vêm de dentro do ZIP original, NÃO há quarto GET XML externo falsificável. Cada tipo tem dois eventos de rede, um COLLECTOR e outro VERIFIER, portanto SEIS observações distintas por job. Dois GETs técnicos não significam duas publicações canônicas: uma publicação é deduplicada pelo fingerprint documental e relacionada a N empresas com filtros isolados.

Máquina de estados: SCHEDULED → FETCH_ATTEMPT por tipo/ator → CAPTURED ou ERROR/UNAVAILABLE/REJECTED. Depois, somente por verificador independente e com seis observações convergentes: TRANSPORT_AGREED → ZIP_XML_PARSED → INDEX_EDITION_LINKED → WHOLE_DISPATCH_CORRESPONDS → DOCUMENTARY_SOURCE_CORRESPONDS. Atestação efetiva SOURCE_PUBLICATION_ATTESTED é PROJEÇÃO DINÂMICA, não boolean persistível, revalidada contra revogação, conflitos e credenciais vigentes. Nenhuma publicação ou ratificação gera LEGAL_CURRENT.

Se a segunda captura diferir do primeiro SHA, houve alteração operacional ou diferença de resposta não explicada: permanecer UNVERIFIED; não afirmar adulteração. Se um índice oficial verificável não existir para 80-B, permanecer INDEX_PENDING. HMAC ou SHA-256 de DTO enviado pela mesma role não prova TLS. O banco não vê TLS: a integridade dos dois workloads e de suas chaves isoladas é pré-condição explícita. Um comprometimento simultâneo de ambos os workloads, ou superuser desonesto, está fora da garantia; documentar como risco.

## 2. DDL v3 — projeto para revisão, NÃO MIGRATION

~~~sql
-- DESIGN ONLY / DO NOT APPLY
CREATE TYPE public.dou_r3_actor AS ENUM ('COLLECTOR','VERIFIER');
CREATE TYPE public.dou_r3_target AS ENUM ('PDF','OFFICIAL_INDEX','INLABS_ZIP');
CREATE TYPE public.dou_r3_outcome AS ENUM ('CAPTURED','UNAVAILABLE','ERROR','REJECTED');
CREATE TYPE public.dou_r3_verdict AS ENUM ('CORRESPONDS','REJECTED','UNVERIFIED');

CREATE TABLE public.tax13_dou_runtime_credentials (
 id uuid PRIMARY KEY, role_name text NOT NULL CHECK (role_name IN
 ('radar_dou_scheduler_runtime','radar_dou_collector_runtime',
 'radar_dou_verifier_runtime','radar_dou_temporal_runtime')),
 epoch bigint NOT NULL CHECK(epoch>0), key_ref text NOT NULL UNIQUE,
 valid_from timestamptz NOT NULL,
 valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(role_name,epoch)
);
CREATE TABLE public.tax13_dou_credential_revocations (
 credential_id uuid PRIMARY KEY REFERENCES
 public.tax13_dou_runtime_credentials(id) ON DELETE RESTRICT,
 revoked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_]{4,80}$')
);
CREATE TABLE public.tax13_dou_collection_jobs (
 id uuid PRIMARY KEY,
 scheduler_credential_id uuid NOT NULL REFERENCES
  public.tax13_dou_runtime_credentials(id) ON DELETE RESTRICT,
 publication_date date NOT NULL CHECK(publication_date >= DATE '2020-01-01'),
 section_code text NOT NULL CHECK(section_code IN ('DO1','DO1E','DO3','DO3E')),
 official_journal_id text NOT NULL CHECK(official_journal_id ~ '^[0-9]{1,4}$'),
 numeric_edition integer NOT NULL CHECK(numeric_edition BETWEEN 1 AND 9999),
 page_number integer NOT NULL CHECK(page_number BETWEEN 1 AND 999999),
 matter_id text NOT NULL CHECK(matter_id ~ '^[0-9]+$'),
 pdf_url text NOT NULL, index_url text NOT NULL, zip_url text NOT NULL,
 target_fingerprint_v3 char(64) NOT NULL CHECK
  (target_fingerprint_v3 ~ '^[a-f0-9]{64}$'),
 planned_at timestamptz NOT NULL,
 scheduler_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX dou_r3_job_lookup ON public.tax13_dou_collection_jobs
 (publication_date,section_code,official_journal_id,page_number);
CREATE TABLE public.tax13_dou_http_fetch_events (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id)
  ON DELETE RESTRICT,
 actor public.dou_r3_actor NOT NULL,
 purpose public.dou_r3_target NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 1000),
 credential_id uuid NOT NULL REFERENCES public.tax13_dou_runtime_credentials(id),
 outcome public.dou_r3_outcome NOT NULL,
 requested_url text NOT NULL, final_url text,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 mime_type text, byte_count bigint CHECK(byte_count BETWEEN 0 AND 20971520),
 sha256 char(64) CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
 runtime_version text NOT NULL, error_code text,
 event_fingerprint_v3 char(64) NOT NULL UNIQUE
  CHECK(event_fingerprint_v3 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(job_id,actor,purpose,attempt_no),
 UNIQUE(id,job_id,actor,purpose),
 CHECK(finished_at>=started_at),
 CHECK(
  (outcome='CAPTURED' AND http_status=200
   AND requested_url=final_url AND byte_count>0 AND sha256 IS NOT NULL
   AND error_code IS NULL)
  OR (outcome<>'CAPTURED' AND sha256 IS NULL AND error_code IS NOT NULL)
 )
);
CREATE INDEX dou_r3_fetch_lookup ON public.tax13_dou_http_fetch_events
 (job_id,actor,purpose,finished_at DESC);
CREATE TABLE public.tax13_dou_archive_manifest (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 collector_zip_event_id uuid NOT NULL, verifier_zip_event_id uuid NOT NULL,
 collector_actor public.dou_r3_actor NOT NULL DEFAULT 'COLLECTOR'
  CHECK(collector_actor='COLLECTOR'),
 verifier_actor public.dou_r3_actor NOT NULL DEFAULT 'VERIFIER'
  CHECK(verifier_actor='VERIFIER'),
 zip_purpose public.dou_r3_target NOT NULL DEFAULT 'INLABS_ZIP'
  CHECK(zip_purpose='INLABS_ZIP'),
 zip_sha256 char(64) NOT NULL CHECK(zip_sha256 ~ '^[a-f0-9]{64}$'),
 parts jsonb NOT NULL CHECK(jsonb_typeof(parts)='array' AND
  jsonb_array_length(parts) BETWEEN 1 AND 48 AND
  pg_column_size(parts) <= 16384),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(id,job_id),
 UNIQUE(job_id,zip_sha256,manifest_sha256),
 FOREIGN KEY (collector_zip_event_id,job_id,collector_actor,zip_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 FOREIGN KEY (verifier_zip_event_id,job_id,verifier_actor,zip_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose)
);
CREATE TABLE public.tax13_dou_edition_bindings (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 manifest_id uuid NOT NULL,
 collector_index_event_id uuid NOT NULL, verifier_index_event_id uuid NOT NULL,
 collector_pdf_event_id uuid NOT NULL, verifier_pdf_event_id uuid NOT NULL,
 collector_actor public.dou_r3_actor NOT NULL DEFAULT 'COLLECTOR'
  CHECK(collector_actor='COLLECTOR'),
 verifier_actor public.dou_r3_actor NOT NULL DEFAULT 'VERIFIER'
  CHECK(verifier_actor='VERIFIER'),
 index_purpose public.dou_r3_target NOT NULL DEFAULT 'OFFICIAL_INDEX'
  CHECK(index_purpose='OFFICIAL_INDEX'),
 pdf_purpose public.dou_r3_target NOT NULL DEFAULT 'PDF'
  CHECK(pdf_purpose='PDF'),
 printed_edition text NOT NULL CHECK
  (printed_edition ~ '^[0-9]{1,4}(-[A-Z])?$'),
 publication_date date NOT NULL,
 section_code text NOT NULL CHECK(section_code IN ('DO1','DO1E','DO3','DO3E')),
 journal_id text NOT NULL CHECK(journal_id ~ '^[0-9]{1,4}$'),
 page_number integer NOT NULL CHECK(page_number BETWEEN 1 AND 999999),
 matter_id text NOT NULL CHECK(matter_id ~ '^[0-9]+$'),
 index_sha256 char(64) NOT NULL CHECK(index_sha256 ~ '^[a-f0-9]{64}$'),
 pdf_sha256 char(64) NOT NULL CHECK(pdf_sha256 ~ '^[a-f0-9]{64}$'),
 verified_identity_fingerprint_v3 char(64) NOT NULL UNIQUE
  CHECK(verified_identity_fingerprint_v3 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL, bound_at timestamptz NOT NULL,
 UNIQUE(id,job_id),
 FOREIGN KEY(manifest_id,job_id)
  REFERENCES public.tax13_dou_archive_manifest(id,job_id),
 FOREIGN KEY (collector_index_event_id,job_id,collector_actor,index_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 FOREIGN KEY (verifier_index_event_id,job_id,verifier_actor,index_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 FOREIGN KEY (collector_pdf_event_id,job_id,collector_actor,pdf_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 FOREIGN KEY (verifier_pdf_event_id,job_id,verifier_actor,pdf_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 CHECK ((section_code IN ('DO1E','DO3E'))=
  (printed_edition ~ '-[A-Z]$'))
);
CREATE TABLE public.tax13_dou_verification_events (
 id uuid PRIMARY KEY, job_id uuid NOT NULL,
 binding_id uuid NOT NULL,
 verifier_credential_id uuid NOT NULL REFERENCES
  public.tax13_dou_runtime_credentials(id),
 result public.dou_r3_verdict NOT NULL,
 normalized_dispatch_sha256 char(64)
  CHECK(normalized_dispatch_sha256 ~ '^[a-f0-9]{64}$'),
 normalization_version text NOT NULL,
 report_sha256 char(64) NOT NULL UNIQUE
  CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
 failure_code text, verified_at timestamptz NOT NULL,
 UNIQUE(id,binding_id),
 FOREIGN KEY(binding_id,job_id)
  REFERENCES public.tax13_dou_edition_bindings(id,job_id),
 CHECK((result='CORRESPONDS' AND normalized_dispatch_sha256 IS NOT NULL
  AND failure_code IS NULL)
  OR (result<>'CORRESPONDS' AND failure_code IS NOT NULL))
);
CREATE TABLE public.tax13_dou_act_correlations (
 id uuid PRIMARY KEY, verification_event_id uuid NOT NULL UNIQUE,
 binding_id uuid NOT NULL,
 parent_dispatch_version_id uuid NOT NULL
  REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 child_act_version_id uuid NOT NULL
  REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 parent_start integer NOT NULL CHECK(parent_start>=0),
 parent_end integer NOT NULL CHECK(parent_end>parent_start),
 child_start integer NOT NULL CHECK(child_start>=parent_start),
 child_end integer NOT NULL CHECK(child_end>child_start),
 CHECK(child_end<=parent_end),
 norm_version text NOT NULL,
 comparison_sha256 char(64) NOT NULL UNIQUE
  CHECK(comparison_sha256 ~ '^[a-f0-9]{64}$'),
 correlated_at timestamptz NOT NULL,
 FOREIGN KEY(verification_event_id,binding_id)
  REFERENCES public.tax13_dou_verification_events(id,binding_id)
);
CREATE INDEX dou_r3_correlations_act ON public.tax13_dou_act_correlations
 (child_act_version_id,correlated_at DESC);
CREATE TABLE public.tax13_dou_temporal_review_events (
 id uuid PRIMARY KEY,
 correlation_id uuid NOT NULL REFERENCES public.tax13_dou_act_correlations(id),
 device_ref text NOT NULL CHECK(length(device_ref) BETWEEN 1 AND 240),
 event_kind text NOT NULL CHECK(event_kind IN
 ('PUBLICATION','RATIFICATION','RETROACTIVE_EFFECT','DEADLINE',
 'REFERENCE_PERIOD','CORRECTION','AMENDMENT','REVOCATION','SUPERSESSION',
 'REVIEW_PENDING','REVIEW_UNVERIFIED')),
 legal_as_of date NOT NULL, event_date date,
 effect_from date, effect_until date,
 official_evidence_url text NOT NULL, evidence_sha256 char(64) NOT NULL
  CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewer_credential_id uuid NOT NULL REFERENCES
  public.tax13_dou_runtime_credentials(id),
 supersedes_event_id uuid REFERENCES
  public.tax13_dou_temporal_review_events(id),
 review_status text NOT NULL CHECK
  (review_status IN ('PENDING','UNVERIFIED','FACTS_ONLY')),
 event_sha256 char(64) NOT NULL UNIQUE
  CHECK(event_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK(effect_until IS NULL OR effect_from IS NOT NULL),
 CHECK(effect_until IS NULL OR effect_until>=effect_from),
 CHECK(supersedes_event_id IS NULL OR supersedes_event_id<>id)
);
CREATE INDEX dou_r3_temporal_by_device ON public.tax13_dou_temporal_review_events
 (correlation_id,device_ref,legal_as_of DESC);
~~~

## 3. Cross-table invariants — exigidos em funções de admissão

Todas as invariantes abaixo devem ser verificadas na mesma transação de verificação e novamente no projetor; não são dados declarativos da API:

1. Job imutável criado por scheduler autenticado; URLs PDF, índice, ZIP são *geradas* por templates estritos, jamais pelo caller. Referências de job devem ligar data, seção, journal, página, matter INLABS.
2. Para CADA purpose existem dois eventos CAPTURED, exatamente um por role COLLECTOR/VERIFIER, com o MESMO job, URLs solicitadas/finais iguais a job.url[purpose], HTTP 200, MIME, limites, SHA e timestamps plausíveis. Qualquer evento ERROR/UNAVAILABLE não pode fornecer prova.
3. PDFs dos dois atores têm o MESMO sha256; índices têm o MESMO sha256; ZIPs têm o MESMO sha256. A igualdade significa mesmo conteúdo entre as duas capturas, não comprova a autenticidade por si só. Se divergirem, nenhuma admissão positiva.
4. Manifesto ZIP deriva-se dos próprios bytes obtidos pelo verifier, com nome de partes XML ordenados lexicograficamente em UTF-8, hash/tamanho por arquivo e limite de 48, sem XML importado ou partes omitidas. Digest de ZIP concorda com os dois eventos, manifest id e binding compartilham job_id por FK.
5. Índice oficial foi efetivamente lido pelo verifier; seu hash corresponde aos dois GETs. Conteúdo comprova data, seção, jornal, edição com sufixo (80, 80-A ou 80-B) e página. Esse vínculo independe de printedEdition fornecido à função de comparação unitária.
6. XMLs do mesmo ZIP comprovam matter ID, data, section, edition numeric, filename/journal, despacho pai e ato; cadeia partes sem lacunas. O valor numeric edition 80 junto de DO1E nunca basta para decidir entre A/B.
7. PDF imprime o mesmo cabeçalho data/seção/sufixo e texto integral do DESPACHO, inclusive introdução, siblings anteriores e posteriores, cláusulas completas e rodapé versionado. O comparador puro segue NON_OFFICIAL mesmo que resultado textual positivo.
8. Verifier possui credential independente vigente e não revogada; collector idem, inclusive epoch e validade de cada evento. Qualquer credential revogada torna projeção UNVERIFIED; eventos históricos permanecem imutáveis.
9. FOREIGN KEY(parent/child publication_versions) é confrontada ao manifesto real e aos spans exatos na função de admissão; nenhum join por texto do caller, id de outro job ou matéria concorrente.
10. Conflict/retry: event fingerprint v3 versionado e canônico, unique(job_id,actor,purpose,attempt_no). Retry novo preserva anterior e aumenta ordinal; idempotência exata exige fingerprint igual; divergência rejeita sem UPDATE. Veredictos incompatíveis para mesma identidade documental bloqueiam projeção.
11. Registro de binding+manifest+verification+correlation é atômico sob advisory lock do job e credenciais (ordem estável) com transação curta. Network GET fora de transação. Revogação usa mesma ordem de lock, reavalia antes de gravar; projector sempre consulta revocations.
12. SOURCE_PUBLICATION_ATTESTED é resultado dinâmico calculado pela função do reader, não campo inserível. Nunca entra em tax13_v2_original_exists_for_issuer e não concede CURRENT. Relevância e NO_RELEVANT_PUBLICATIONS são projeções tenant-specific depois de todas as fontes serem consultadas com sucesso.

Fingerprints: SHA256 sobre JSON canônico RFC8785 (perfil definido, chaves ordenadas, NFC/UTF-8, arrays XML ordenados por filename, domínios TRIFAROS/DOU/TARGET/3, TRIFAROS/DOU/FETCH/3, TRIFAROS/DOU/IDENTITY/3, TRIFAROS/DOU/VERIFY/3). Incluir job_id, actor, purpose, attempt_no, UTC ISO, status, URL rederivada, hash da resposta e credential_epoch. Testar invariância de locale C / pt-BR. HMAC por si não substitui duplo GET de endpoints oficiais. Superuser/comprometimento simultâneo são riscos residuais explícitos.

## 4. Matriz de grants, RLS, atomicidade e gateways (contrato definitivo de comportamento)

A owner role é NOLOGIN e possuirá todas as nove tabelas. Para TODAS: REVOKE ALL FROM PUBLIC, ENABLE RLS, FORCE RLS, policy FOR ALL para owner NOLOGIN, trigger BEFORE UPDATE/DELETE que sempre RAISE DOU_APPEND_ONLY, nenhuma permissão TRUNCATE; schema public CREATE revogado a PUBLIC e funções search_path fixo com objetos totalmente qualificados. Nenhuma role runtime recebe INSERT/UPDATE/DELETE ou SELECT bruto. Somente funções SECURITY DEFINER com owner correto, session_user exato, REVOKE EXECUTE FROM PUBLIC e GRANT EXECUTE apenas ao principal correspondente.

| Gateway | EXECUTE | Escreve ou lê |
| --- | --- | --- |
| create_job | scheduler | jobs (somente target governamental derivado) |
| register_collector_event | collector | http_fetch_events com actor COLLECTOR |
| register_verifier_event | verifier | http_fetch_events com actor VERIFIER |
| admit_documentary_chain | verifier | manifest, edition_bindings, verification_events, act_correlations em transação atômica |
| revoke_credential | credential_admin | credential_revocations somente INSERT |
| add_credential | credential_admin | runtime_credentials somente INSERT |
| append_temporal_fact | temporal | temporal_review_events somente INSERT |
| read_documentary_status | read_runtime | JOIN restrito sobre ledger, retorna VERIFIED_PUBLICATION ou UNVERIFIED, sem CURRENT |

**Anti-forgery operativo:** register_collector_event pode receber campos observados pela própria aplicação collector, mas isoladamente NUNCA produz atestação. Verifier não confia em campo/fingerprint de collector para seu próprio download, faz novo GET TLS governamental e reextrai hashes; roles/senhas/rede são segregados. Um auditor com credential somente collector, worker comum, UI, sealer ou curator não tem como materializar ambos os tipos de evento. A função admit_documentary_chain não recebe verified=true nem DTO sourceCapture; recebe IDs do job e das observações preexistentes e só confere a rede via digest das DUAS sessões e conteúdo XML/índice/PDF verificado no processo autorizado. O SQL não executa TLS nem consegue detectar um verifier comprometido que fabricou seu relato: isso é risco residual, não prova de segurança absoluta.

**SQL de proteção demonstrativo, sintaticamente consistente (não aplicar):**

~~~sql
CREATE FUNCTION public.tax13_dou_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $r3$
BEGIN
  RAISE EXCEPTION 'DOU_R3_APPEND_ONLY';
END
$r3$;
REVOKE ALL ON FUNCTION public.tax13_dou_immutable_guard() FROM PUBLIC;
-- Repetir trigger em CADA uma das nove tabelas e FORCE RLS em cada.
CREATE TRIGGER no_dou_http_update_delete BEFORE UPDATE OR DELETE
 ON public.tax13_dou_http_fetch_events
 FOR EACH ROW EXECUTE FUNCTION public.tax13_dou_immutable_guard();
~~~

**Funções de negócio não são stubs que "RAISE sempre"; estão especificadas por pré-condições/postcondições de §§1–4.** A assinatura SQL compilável de cada gateway é parte da FUTURA 049+, somente após revisão independente R3. Não criar ficção de função SQL que acredita em um boolean verified passado pelo chamador. Revisores devem distinguir aprovação do contrato de implementação verificável do binário confiável.

Revogação/concorrência: locks por credential_id obtidos em ordem crescente nos gateways, revocation e projector; funções de escrita fazem check após lock e antes de COMMIT, transaction READ COMMITTED com retry de serialização quando necessário. Projeção é não persistida e reavalia revogação em cada SELECT (concorrência com revogação requer linearização transacional). Se status muda depois da consulta, não manter cache positivo persistente.

### 4.1. Condições de segurança fechadas em chamadas transacionais

O futuro gateway de captura opera com a combinação de credencial de sessão, alvo planejado e função de papel único. Nenhum registro de `CAPTURED` gravado por `radar_dou_collector_runtime` é, isoladamente, credencial de admissão: `read_documentary_status` deve retornar `UNVERIFIED` até serem inseridos *separadamente* os três eventos do verificador, e estes precisam ter o mesmo conteúdo HTTP original (hash para cada alvo) efetivamente reobtido. Os registros positivos usam a **mesma identidade de job**, mas não o mesmo segredo nem o mesmo processo.

**Pré-condições precisas de `admit_documentary_chain`:** sessão do verificador exata; transação read committed com lock exclusivo no `job_id`; status das seis capturas CAPTURED e roles/propósitos coerentes; lookup de `job.pdf_url / index_url / zip_url` idêntico a `requested_url / final_url` em cada par; SHA256 idêntico dentro de cada par; atestação de integridade TLS dos GETs feita pelo próprio serviço em egress segregado; certificado TLS normal do transporte válido na hora (sem certificação de assinatura do PDF); registro do índice rederivado, ZIP e partes/XML rederivados na memória do verificador; edição impressa data/seção/número/sufixo vinculados ao índice; referências INLABS/Despacho/ato compatíveis; correspondência textual integral; credentials collector/verifier/scheduler não revogadas, check temporal e audit fingerprint. Apenas após isso o gateway insere manifestação, binding, verificação e correlação na **mesma transação**. O SQL não extrai novamente bytes PDF: exige integridade dos dois processos como parte explícita do trust model. Se qualquer requisito falhar, a transação positiva não grava *nenhum* dos quatro eventos e fica UNVERIFIED.

**Projeção read-only:** ao receber correlation_id, o projetor localiza seus quatro níveis de FK, localiza seis eventos por referência *tipada*, reexige status=CAPTURED, compara SHA dos pares, URLs versus job, checa report=CORRESPONDS, key revocations para scheduler/collector/verifier e eventuais correlatos conflitantes que partilhem (data, seção, journal, edição sufixada, página, matter). Se faltar campo, chave, igualdade ou revalidação temporal → UNVERIFIED. Não há operação que transforme isso automaticamente em atestação jurídica CURRENT. Nenhum parâmetro pode ignorar a checagem por `skipVerification`, `issuer`, `admin`, `force` ou `sourceCapture.status`.

**Races e idempotência:** geradores de job usam UUIDs e targets fechados. Cada role faz `pg_advisory_xact_lock` para (job_id,actor,purpose); credenciais e revogações seguem ordem determinística (sorted credential_id) em todos os gateways. `ON CONFLICT` não muda resultado: se chave e fingerprint iguais, replay é identificado como mesma tentativa; se diferentes, erro `DOU_R3_REPLAY_CONFLICT`. Toda falha de transporte deixa evento próprio, nunca `NO_RELEVANT_PUBLICATIONS`. Para assegurar atomicidade com revogação, o tratamento deve ser linearizável nos gates de escrita e projeção, inclusive quando duas transações ocorrem durante a rotação; testes adversariais com duas sessões PG16 e PG18 serão obrigatórios na 049+ **após gate R3**.

**Acesso por tenant:** a informação canônica é global, mas o projetor somente devolve estado documental associado a um identificador de publicação que já tenha sido autorizado pela camada de relevância tenant. O gateway `radar_dou_read_runtime` não pode expor SELECT genérico de todas as publicações a uma API de cliente sem autorização tenant. Testes A/B devem demonstrar que associação do tenant A não pode ser lida por B.

**Risco formal declarado:** hash coincidente de respostas de dois GETs não demonstra autenticidade absoluta sob colusão de processos; integridade do release assinado, segregação de rede/segredos, rotação e revogação de credenciais compõem o limite de confiança. Não mascarar isso com HMAC de DTO, TypeScript readonly ou coluna de status SQL.


## 5. Texto, timeline, retenção e critérios de aceite

R9-R2-D03: PDF deve conter o DESPACHO inteiro começando na Identifica e seguido pelo seu Texto/ementa e todos os siblings; não basta encontrar o ato selecionado isoladamente. Código R3 reconstrói o heading separado da fonte XML e exige coincidência exata do envelope, checa child offset, rejeita preâmbulo adulterado e sibling anterior modificado. Text normalization versionada, perda de acento/número/pontuação material proibida; as extrações nativas sem coordenadas confiáveis são UNVERIFIED quando não permitem ordenação inequívoca. Unit tests SYNTHETIC/NON_OFFICIAL não provam PDF original real.

D06 retenção: PostgreSQL somente hash, metadata de captura, URL, key ids, datas, versões e manifesto pequeno JSONB, NÃO PDF/JPG/ZIP. Sem bytes, não é possível repetir extração ou provar equivalência histórica após fonte alterar arquivo; re-fetch cria evento novo. Objeto único imutável externo é possibilidade futura com autorização separada, não requisito de implantação da RFC.

D08 temporal: append-only eventos per-device PUBLICAÇÃO/RATIFICAÇÃO/RETROATIVIDADE/PRAZO/CORREÇÃO/EMENDA/REVOGAÇÃO/SUPERSESSION com as-of e URL próprios; só fatos, nenhuma cláusula se torna CURRENT por prazo passado, vigência de ratificação ou publicação. Caso Convênio 15/24: GET Railway 9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44 x PDF upload e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201 são hashes distintos, bytes GET descartados; equivalência REAL NÃO VERIFICADA, não afirmar fraude nem igualdade.

Próximo gate: parecer independente R9-DESIGN-R3 especificamente neste RFC único; nenhuma migration 049+ antes de APPROVED. Após, implementar PG16/18 com 2 sessões, ACL, RLS/FORCE, UPDATE/DELETE/TRUNCATE, races e credential revoke, idempotência, tenant A/B, fake DTO reject, joins exatos, e somente após autorização operacional distinta realizar GET governamental real. R7 e TAX11 anteriores continuam BLOCK com a migration 048 intacta. **DESENHO AINDA BLOCK PARA PRODUÇÃO.**
