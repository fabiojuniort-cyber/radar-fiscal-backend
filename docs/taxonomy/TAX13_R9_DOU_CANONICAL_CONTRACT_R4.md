# Trifaros — TAX13 / R9-DESIGN-R4: contrato canônico XML-first e atestação DOU seletiva

**STATUS: PROPOSTA DE DESENHO PARA REVISÃO INDEPENDENTE. BLOCK ATÉ PARECER R4. NÃO É MIGRATION 049+ E NENHUM SQL ABAIXO DEVE SER APLICADO EM PRODUÇÃO.**

Data: 2026-10-10. Base acumulada: PR #197 SHA e21c792d599bb9f70cf5f7b268cd9476ce987c8d, sobre #196 SHA f2ebd1a134157e3fa0fa549155a5908dad63e37f. Parecer independente R3 BLOCK: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094470892. Este contrato R4 é a **única proposta normativa futura** nesta branch; R3 e anteriores permanecem históricos e não aprovados. Política vinculante: docs/taxonomy/TAX13_DOU_XML_FIRST_OWNER_DECISION_20261010.md.

A fronteira aqui é intencional: (A) XML INLABS é fonte canônica global para persistir e processar norma, taxonomia, relevância e IA **independentemente de PDF**; (B) PDF e índice oficiais são cotejo documental **seletivo**, sem motor jurídico paralelo, sem DOWNLOAD de PDF para cada XML; (C) análise temporal por dispositivo nasce do XML, mesmo quando nenhum job PDF foi agendado; (D) comprovação da PUBLICAÇÃO nunca confere CURRENT. Nenhuma exigência de ICP-Brasil, ITI, assinatura de PDF, OCSP/CRL.

## 1. Correções mandatórias R3 → R4

| Achado | Correção R4 | Evidência posterior necessária |
|---|---|---|
| P1 R3-01 — fatos jurídicos dependiam de PDF | Evento temporal referencia âncora de versão XML **obrigatoriamente**; referência a correlação PDF **opcional** e tipada pela mesma âncora | Teste sem job PDF, evento jurídico por dispositivo persistido sem CURRENT |
| P1 R3-02 — ZIP barrado por limite de PDF | CHECK por finalidade: PDF <= 20 MiB; índice <= 2 MiB; ZIP <= 64 MiB; expansão ZIP <= 128 MiB, arquivo individual <= 8 MiB, até 5000 entradas | PG16/18 aceita evento ZIP 25 MiB e rejeita PDF 25 MiB; parser e streaming respeitam teto |
| P1 R3-03 — identidade XML e dedupe | Âncora global tipada em publication_versions + publication_origins + hashes do texto e das partes; versionamento/correção e conflitos entre jobs definidos | Negativos origem diferente, XML adulterado, content_hash divergente, conflito dois jobs |
| P1 R3-04 — índice/manifests | Fonte de índice com adaptador allowlisted versionado e autoridade verificada, sem supor URL não confirmada; inventário completo do ZIP por digest e partes selecionadas **por matéria** | 80/80-A/80-B; jornal, seção, página, matéria, ZIP e parte incompatíveis falham; índice ausente PENDING |
| P1 R3-05 — gateways, RLS e revogação | Assinaturas, papéis e invariantes por função, FORCE RLS/trigger e ACL de cada tabela; projeção global independente de dados de tenant | PG16/18 duas sessões, replay, revogação concorrente, DML negado, tenant A/B |
| P2 R3-06 — cardinalidade | 1 verification_event por despacho/matéria; 1:N act_correlations por ato XML derivado, mesma verificação compartilhada | 2 atos, 1 PDF, 2 correlations para 1 verification, zero novas capturas |
| P2 R3-07 — estados operacionais | XML_PARSED e revisão temporal não dependem de PDF; documental NOT_REQUESTED/PENDING/VERIFIED/MISMATCH/UNAVAILABLE/REVOKED; sem status de CURRENT implícito | PDF down e mismatch não descartam XML; status de origem permanece pendente |

### 1.1. Limites do que se pode afirmar agora

O coletor atual src/modules/collection/dou.connector.ts chama downloadXml() e parseDouZip(), sem downloadPdf(); teste dedicado provou 39/39 PASS no CI #38028965169 (mocks/sintéticos). Existe função downloadPdf no cliente INLABS, mas não é chamada pela coleta regular. Código atual src/modules/collection/inlabs.client.ts permite ZIP até 64 MiB por padrão; o parser src/modules/collection/dou.parser.ts limita ZIP comprimido 64 MiB, soma descomprimida 128 MiB, entrada individual 8 MiB e 5000 nomes. Não substituir esses fatos por configuração documental inventada.

O banco existente possui public.publications(id, identity_hash,...), public.publication_origins(id, publication_id, source_id, external_id, official_url, metadata), public.publication_versions(id, publication_id, version_no, content_hash, content_text, source_metadata, is_current,...). **publication_versions.is_current é marcador editorial da versão, NÃO LEGAL_CURRENT.** Não assumir que version.content_hash é o SHA dos XML originais; ele representa o hash do conteúdo armazenado, com algoritmo a confirmar na implantação. Para provar bytes XML, usar os digests de partes originais separadamente.

A captura Railway PDF anterior SHA 9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44 diverge do PDF upload SHA e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201, e os bytes Railway foram descartados: equivalência **UNVERIFIED**; não retrocriar CAPTURED.

## 2. Duas cadeias com ciclo de vida separado

**Ingestão regular e análise (SEM PDF):**
ZIP INLABS autenticado → XMLs por matéria → publicação canônica global e publication_versions → validação de identidade/metadados → taxonomia/IA/filtros/busca → fatos jurídicos por dispositivo ligados a versão XML → relevância por tenant sob RLS. Falha em PDF não é falha desta cadeia.

**Atestação documental (SELEÇÃO EXPLÍCITA):**
â ncora XML → scheduler restrito → GETs oficiais independentes COLLECTOR/VERIFIER para PDF, índice reconhecido e ZIP INLABS (3 alvos, 6 eventos **somente por job selecionado**) → manifesto arquivo + partes desta matéria → identidade seção/jornal/edição sufixada/página → cotejo integral do despacho com texto XML → verification_event de matéria → 0..N act_correlations → projeção documental sob rechecagem de revogação.

Não exigir agendar atestação para toda publicação XML. Seleção e orçamento devem ser auditáveis. Um XML pode ser PARSED/CLASSIFIED/TEMPORAL_FACTS_REVIEWED enquanto documental=NOT_REQUESTED/PENDING/UNAVAILABLE/REJECTED, sem criar SOURCE_ATTESTED nem CURRENT.

## 3. Identidade canônica: versão XML, parte e ato

### 3.1 Âncora XML global, NÃO aprovação documental

Uma âncora corresponde a uma **versão de um ato** derivado de matéria INLABS; para um despacho com dois Convênios, duas âncoras de child act podem apontar à mesma versão pai e à mesma matéria/ZIP.

Campos mínimos obrigatórios:
- anchor_id uuid imutável; child_publication_version_id UUID FK public.publication_versions(id); child_publication_id UUID FK public.publications(id).
- parent_publication_version_id UUID FK public.publication_versions(id); parent_publication_id UUID FK public.publications(id); source_origin_id UUID FK public.publication_origins(id).
- child_version_no, parent_version_no e child_content_hash, parent_content_hash capturados do DB e verificados **em transação** contra os registros originais.
- source_code literal 'dou', original external_id da matéria, publication_date, section, numeric_edition, matter_id, journal_id obtido do **nome do XML original**, page_number derivada de pdfPage de cada parte; certified_page_url original; original_zip_url e zip_sha256, matter_xml_parts_manifest_sha256 e parent_dispatch_external_id, child_act_external_id, embedded_child_index / ato normal.
- XML matter candidate key versionada: SHA256 de domain 'DOU:MATTER:4' + publication_date + section + journal_id + numeric_edition + matter_id + parent dispatch external_id + original source origin id. Não inferir 80-A/80-B do número 80 isolado. Versão de conteúdo id + SHA texto + SHA XML por parte compõe o **content_version_key**, sem sobrescrever histórico.
- String/hash recebidos da aplicação não bastam: gateway compara publication_versions.publication_id/content_hash/version_no, publication_origins.publication_id/source_id/external_id e source_metadata.dou.archive/parts rederivados com o parser, inclusive ZIP da coleta original. Se origem metadata carecer de prova suficiente, âncora=UNVERIFIED e não sustenta atestação. A integridade de bytes de captura original depende de seu conector confiável, não de JSON autoatribuído.

Invariantes DB: FK composta (child_publication_version_id,child_publication_id), (parent_publication_version_id,parent_publication_id), (source_origin_id,parent_publication_id) exigem respectivas UNIQUE(id,publication_id) nas tabelas existentes **se não existirem**; não adicionar sem inspeção de migrations/carga e gate DBA. Alternativa robusta caso migração das UNIQUE originais seja inviável: apenas FKs simples + verificação EXPLÍCITA sob locks no writer e no leitor para todas as três igualdades. **Não declarar cross-table garantido por FK simples.**

UNIQUE(child_publication_version_id,source_origin_id,content_version_key); dois jobs de atestação para essa âncora são permitidos, porém o registro canônico não é duplicado por job/tenant. Correção de XML cria nova publication_version e âncora nova, preservando a anterior; se duas publicações canônicas reivindicarem mesmo matter-key com payload conflitante, suspender resultado positivo para ambas (CONFLICT_PENDING) e enviar auditoria, sem merge silencioso. O veredito certificado inclui sufixo impresso da edição após cotejo oficial, formando **document_identity_key** (data+seção+journal+sufixo+página+matéria+versão XML + conteúdo/ato).

### 3.2 CSV/JSON/ZIP não são XMLs externos admitidos

O ZIP do INLABS é o pacote de origem autenticado; cada parte XML selecionada tem filename /^\\d+_YYYYMMDD_matter(-n)?.xml$/, digest SHA256 dos bytes originais, sizeBytes, número de parte e campos validados pelo parser. Ordenar (filename UTF-8 e índice n) canonicamente, exigir part=1..N sem gaps/duplicatas, todos attrs da matéria coerentes, e digests rederivados do ZIP que o VERIFIER efetivamente capturou. Os campos source_metadata e urls não substituem isso.

**Inventário integral do ZIP** e **manifesto das partes da matéria** são coisas diferentes:
- ZIP inventory: digest de todos os até 5000 nomes/CRC32/tamanho/hash bruto relevantes, inclusive entradas não-XML. Contagem e digest guardados; inventário completo fica efêmero. Limites: zip compressed <=64MiB, cumulative uncompressed <=128MiB, entry <=8MiB. Proibir path traversal/zip slip, duplicatas e criptografia; não guardar binários no PG.
- XML matter parts: JSONB limitado de 1..48 partes (48 é teto **por matéria**, nunca do ZIP completo), com filename, rawSha256, sizeBytes, partIndex. SHA do manifesto calculado sobre ordem canônica; os arquivos selecionados devem ser subconjunto fechado do inventário original, sem partes extras da mesma matéria omitidas.
- Se não for possível enumerar todas as entradas ou houve falha parcial de parsing, falhar com MANIFEST_UNVERIFIED; não atestar usando só dois ou três arquivos escolhidos pelo caller.
- O manifesto vincula zip_capture_pair e matter_id, não armazena o ZIP ou XML raw.

### 3.3 Edição 80, 80-A e 80-B

Os metadados do XML incluem editionNumber numérico; DO1E é extra mas **não determina sufixo**. O binding documental exige referência oficial independente ao jornal ID, **impressão real** da edição e sufixo no PDF e vínculo à página. Um valor printedEdition fornecido por parâmetro só produz candidato; nunca prova positiva. O resultado final pode separar 80 de 80-A de 80-B somente após fonte editorial independente e cotejo.

**Fonte do índice (exigência fail-closed, SEM inventar endpoint):** não existe no material R3 evidência suficiente de um endpoint estável e máquina-legível que associe oficialmente journal=601 a 80-B + data/seção/página/matter. O contrato de integração deve registrar um **adapter_id + parser_version + allowlist de scheme/host/path/query + captura da resposta da Imprensa Nacional**, proveniência da listagem e regras determinísticas de extração de data, seção, journal, número+sufixo, página e matter. O scheduler não aceitará index_url arbitrária. Se o portal real não expuser listagem independente, o produto não fabricará INDEX_CAPTURED: status INDEX_PENDING, mesmo com PDF impresso e XML íntegro. Selecionar e demonstrar o endpoint/adaptador com artefatos oficiais reais é *gate de aprovação de implementação* e pode demandar ajuste do desenho, sujeito a revisão adicional. Página visualiza/index.jsp do XML e PDF INPDFViewer **não devem ser chamados de índice independente sem evidência**. Nenhum website privado nem snippet de buscador torna-se prova SQL.

## 4. Contrato DDL v4 — especificação para futura migration (não aplicar)

A camada de evidência é global, sem tenant_id. As FKs para publication_versions/publication_origins são parte da integração existente e devem usar exatamente os nomes e tipos reais após inspeção DBA. **Toda role escrita é NOINHERIT/NOBYPASSRLS; owner NOLOGIN, sem acesso indireto por app.**

### 4.1 Tipos/colunas/constraints essenciais

~~~sql
-- DESIGN REFERENCE ONLY — NOT migration 049+, DO NOT RUN IN PRODUCTION.
CREATE TYPE public.dou_r4_actor AS ENUM ('COLLECTOR','VERIFIER');
CREATE TYPE public.dou_r4_target AS ENUM ('PDF','OFFICIAL_INDEX','INLABS_ZIP');
CREATE TYPE public.dou_r4_outcome AS ENUM ('CAPTURED','UNAVAILABLE','ERROR','REJECTED');
CREATE TYPE public.dou_r4_documentary_status AS ENUM
 ('NOT_REQUESTED','PENDING','VERIFIED','MISMATCH','UNAVAILABLE','REVOKED','CONFLICT');

CREATE TABLE public.tax13_dou_xml_anchors (
 id uuid PRIMARY KEY,
 source_origin_id uuid NOT NULL REFERENCES public.publication_origins(id),
 parent_publication_id uuid NOT NULL REFERENCES public.publications(id),
 parent_publication_version_id uuid NOT NULL REFERENCES public.publication_versions(id),
 child_publication_id uuid NOT NULL REFERENCES public.publications(id),
 child_publication_version_id uuid NOT NULL REFERENCES public.publication_versions(id),
 parent_version_no integer NOT NULL CHECK(parent_version_no>0),
 child_version_no integer NOT NULL CHECK(child_version_no>0),
 parent_content_hash text NOT NULL, child_content_hash text NOT NULL,
 publication_date date NOT NULL,
 section_code text NOT NULL CHECK(section_code IN ('DO1','DO1E','DO3','DO3E')),
 numeric_edition integer NOT NULL CHECK(numeric_edition>0),
 journal_id text NOT NULL CHECK(journal_id ~ '^[0-9]+$'),
 page_number integer NOT NULL CHECK(page_number>0),
 matter_id text NOT NULL CHECK(matter_id ~ '^[0-9]+$'),
 parent_external_id text NOT NULL,
 child_external_id text NOT NULL,
 archive_url text NOT NULL, archive_sha256 char(64) NOT NULL
   CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 xml_parts_sha256 char(64) NOT NULL CHECK(xml_parts_sha256 ~ '^[a-f0-9]{64}$'),
 matter_key_v4 char(64) NOT NULL CHECK(matter_key_v4 ~ '^[a-f0-9]{64}$'),
 content_version_key_v4 char(64) NOT NULL CHECK(content_version_key_v4 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(child_publication_version_id,source_origin_id,content_version_key_v4),
 UNIQUE(id,child_publication_version_id),
 UNIQUE(id,matter_key_v4),
 UNIQUE(id,archive_sha256)
);
-- Purpose-specific limit, NOT a single 20MiB constraint:
CREATE TABLE public.tax13_dou_http_fetch_events (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 actor public.dou_r4_actor NOT NULL,
 purpose public.dou_r4_target NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 1000),
 credential_id uuid NOT NULL REFERENCES public.tax13_dou_runtime_credentials(id),
 outcome public.dou_r4_outcome NOT NULL,
 requested_url text NOT NULL, final_url text,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 mime_type text,
 byte_count bigint,
 sha256 char(64) CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL CHECK(finished_at>=started_at),
 runtime_version text NOT NULL,
 error_code text,
 event_fingerprint_v4 char(64) NOT NULL UNIQUE CHECK(event_fingerprint_v4 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(job_id,actor,purpose,attempt_no),
 UNIQUE(id,job_id,actor,purpose),
 CHECK(
   (outcome='CAPTURED' AND http_status=200 AND requested_url=final_url
     AND byte_count>0 AND sha256 IS NOT NULL AND error_code IS NULL)
   OR (outcome<>'CAPTURED' AND sha256 IS NULL AND error_code IS NOT NULL)
 ),
 CHECK(outcome<>'CAPTURED' OR
  (purpose='PDF' AND byte_count BETWEEN 1 AND 20971520)
  OR (purpose='OFFICIAL_INDEX' AND byte_count BETWEEN 1 AND 2097152)
  OR (purpose='INLABS_ZIP' AND byte_count BETWEEN 1 AND 67108864))
);
-- The final CREATE TABLE order must create jobs/credentials first (see section 4.2).
-- Example manifest has one row PER MATTER (not a global 48-file ZIP inventory):
CREATE TABLE public.tax13_dou_archive_manifest (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 matter_id text NOT NULL,
 zip_sha256 char(64) NOT NULL CHECK(zip_sha256 ~ '^[a-f0-9]{64}$'),
 zip_inventory_sha256 char(64) NOT NULL CHECK(zip_inventory_sha256 ~ '^[a-f0-9]{64}$'),
 zip_total_entries integer NOT NULL CHECK(zip_total_entries BETWEEN 1 AND 5000),
 zip_total_uncompressed_bytes bigint NOT NULL CHECK(zip_total_uncompressed_bytes BETWEEN 0 AND 134217728),
 matter_parts jsonb NOT NULL CHECK(jsonb_typeof(matter_parts)='array'
   AND jsonb_array_length(matter_parts) BETWEEN 1 AND 48
   AND pg_column_size(matter_parts)<=16384),
 matter_parts_sha256 char(64) NOT NULL CHECK(matter_parts_sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(id,job_id),
 UNIQUE(job_id,matter_id,zip_sha256,matter_parts_sha256)
);
-- Temporal facts attach to XML anchor, regardless of PDF:
CREATE TABLE public.tax13_dou_xml_temporal_review_events (
 id uuid PRIMARY KEY,
 xml_anchor_id uuid NOT NULL REFERENCES public.tax13_dou_xml_anchors(id) ON DELETE RESTRICT,
 device_ref text NOT NULL CHECK(length(device_ref) BETWEEN 1 AND 240),
 event_kind text NOT NULL CHECK(event_kind IN
 ('PUBLICATION','RATIFICATION','RETROACTIVE_EFFECT','DEADLINE',
 'REFERENCE_PERIOD','CORRECTION','AMENDMENT','REVOCATION','SUPERSESSION',
 'REVIEW_PENDING','REVIEW_UNVERIFIED')),
 legal_as_of date NOT NULL,
 event_date date,
 effect_from date, effect_until date,
 official_evidence_url text NOT NULL,
 evidence_sha256 char(64) CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 optional_documentary_correlation_id uuid NULL,
 reviewer_credential_id uuid NOT NULL
   REFERENCES public.tax13_dou_runtime_credentials(id),
 supersedes_event_id uuid REFERENCES public.tax13_dou_xml_temporal_review_events(id),
 review_status text NOT NULL CHECK(review_status IN ('PENDING','UNVERIFIED','FACTS_ONLY')),
 event_sha256 char(64) NOT NULL UNIQUE CHECK(event_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK(effect_until IS NULL OR effect_from IS NOT NULL),
 CHECK(effect_until IS NULL OR effect_until>=effect_from)
);
-- In the FINAL migration, add FK (optional_documentary_correlation_id,xml_anchor_id)
-- to UNIQUE(id,xml_anchor_id) on act_correlations. NULL allows XML-only review.
~~~

**DDL reference, not executable as a whole**: the excerpt above intentionally isolates the changed columns; a production-ready additive migration must include the unchanged R3 jobs, credentials, revocations, binding and verification definitions **normalized into a single chronological CREATE script**, and must not leave the cross-table checks as merely comments. In particular the CREATE TABLE order above is illustrative, not deployable. Do not claim schema compiled or PG integration passed at this point.

### 4.2 DDL complementar fixado por contrato, para evitar decisões implícitas na 049+

Tabela / vínculo / constraint obrigatórios:
- runtime_credentials (id PK, role_name exact scheduler/collector/verifier/temporal, epoch monotonic UNIQUE(role,epoch), valid_from/until, secret_ref no plaintext) e credential_revocations (credential_id PK FK, timestamp/reason; apenas INSERT).
- collection_jobs (id PK, xml_anchor_id FK, credential scheduler FK, data/seção/journal/página/matéria herdadas por seleção autenticada da âncora, pdf_url/index_url/zip_url fixadas por adapters internos; unique(job_id,xml_anchor_id), selected_reason/selected_at; target_fingerprint_v4 **NOT unique** por permitir recaptura) com FK (xml_anchor_id, archive_sha256 se materializado) referencial quando aplicável. **Não** aceitar URL do cliente/curador.
- http_fetch_events com FK tripla/quadrupla typada (id,job_id,actor,purpose); registrar cada tentativa imutável, inclusive erros e retries. Collector/Verifier não compartilham LOGIN/secret nem processo/egress. Atestação exige pares de SHA iguais, job e URLs coincidentes; evento ERROR/UNAVAILABLE não equivale a zero publicações.
- archive_manifest **por matéria**, referenciando par de eventos COLLECTOR/VERIFIER INLABS_ZIP com FKs compostas; comparar ambos SHA da resposta ao zip_sha256 e zip original da âncora. Se o archive original já arquivado tiver bytes divergentes, bloquear atestação em vez de mudar hash silently.
- edition_bindings (id PK, job_id FK, archive_manifest_id/job_id FK, quatro FKs tipadas PDF/INDEX dos dois atores, printed_edition incluindo A/B, publication_date, section, journal, page, matter, pdf_sha256, index_sha256, document_identity_key_v4 UNIQUE versionada; identidade = função dos bytes verificados + âncora).
- verification_events (id PK, job_id FK, binding_id/job_id FK, credential verifier FK, parsed index/whole-dispatch report SHA/versions e outcome REJECTED/UNVERIFIED/CORRESPONDS); um verificador para um despacho pode produzir múltiplos child correlations.
- act_correlations (id PK, verification_event_id FK **SEM UNIQUE na verification_event_id**, xml_anchor_id FK, parent/child version ids comparados à âncora, spans do despacho/ato, full_match_sha256, algorithm_version, unique(verification_event_id,xml_anchor_id) e unique(id,xml_anchor_id)). Não permitir dois positivos conflitantes para o mesmo anchor/document_identity em diferentes jobs sem projetor fail-closed.
- xml_temporal_review_events: FK obrigatória apenas para xml_anchor; optional_documentary_correlation_id tipada para o mesmo anchor e NULL permitido. O gateway temporal NÃO executa nem invoca criação de job PDF. Fatos registrados não provam vigência automaticamente.
- todas as FKs referem-se a objetos globalmente canônicos; NEVER tenant_id nas tabelas de origem. Sem duplicação de PDF por child/empresa.
- recomendação de único cadastro de estados de coleta existente: usar collection_runs/collection_attempts para diagnósticos XML sem criar mais uma tabela de "nenhum documento", e derivar NO_RELEVANT_PUBLICATIONS por tenant somente com consultas completas.

Cardinalidade: 1 job → 3 alvos x 2 actors → 1 manifesto por matéria → 1 binding por edição/página/matéria/versão → 1 verification_event por despacho → N act_correlations de atos do despacho; N âncoras XML compartilham o mesmo manifesto e verification_event, e um evento temporal refere-se a 1 anchor independente de PDF.

## 5. Contrato definitivo de gateways e controles SQL

### 5.1 Papéis e isolamento

| Login | EXECUTE permitido | Tabelas diretas |
|---|---|---|
| radar_dou_scheduler_runtime | schedule_evidence_job | NONE |
| radar_dou_collector_runtime | record_collector_fetch | NONE |
| radar_dou_verifier_runtime | record_verifier_fetch; admit_documentary_chain | NONE |
| radar_dou_credential_admin_runtime | add_credential; revoke_credential | NONE |
| radar_dou_temporal_runtime | append_xml_temporal_fact | NONE |
| radar_dou_read_runtime | read_global_documentary_status_by_version | NONE |
| radar_app_runtime, worker, curator, issuer, scan-sealer, tenant | NONE em origem/ledger | NONE |
| radar_dou_ledger_owner NOLOGIN | OWNER de dados e funções SECURITY DEFINER | OWNER com FORCE RLS |

Runtimes LOGIN sem BYPASSRLS, sem SUPERUSER, sem CREATEROLE/CREATEDB, NOINHERIT. Sem grant membership em owner, collector ou verifier para app/worker. Todas as tabelas REVOKE ALL FROM PUBLIC, APP, WORKER e login runtime; ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY, policies exatas SELECT/INSERT apenas para owner NOLOGIN, ausência explícita de UPDATE/DELETE/TRUNCATE, trigger que RAISE BEFORE UPDATE OR DELETE mesmo quando alguma role com permissão obtida por erro. REVOKE CREATE ON SCHEMA public FROM PUBLIC e runtimes; funções e views fora de schema gravável, search_path seguro = pg_catalog,pg_temp e nomes public totalmente qualificados, owner NOLOGIN, REVOKE EXECUTE FROM PUBLIC após criação e default ACL idem.

**Papel separado credencial e scheduler:** dono de credencial não pode ser collector/verifier. Tabela de credenciais guarda apenas referência, nunca password, cookie, HMAC key ou token. Revogação é novo evento, não UPDATE em event histórico.

### 5.2 Interfaces congeladas propostas (assinatura, pré e pós)

Abaixo são **interfaces de design** para gerar futura SQL e testes PG após aprovação; não são funções criadas neste PR. Qualquer implementação que exponha boolean verified, raw body, SQL user URL arbitrária, ou contorne papéis invalida o contrato.

1. schedule_evidence_job(p_xml_anchor_id uuid, p_reason_code text, p_request_fingerprint char(64)) RETURNS uuid, EXECUTE exclusivamente scheduler; compara âncora ao banco, motivo em allowlist e política de custo; rederiva URL ZIP de arquivo origin e URL PDF de certifiedPageUrl; escolhe index adapter somente se fonte oficial aprovada; congela job por identidade de versão XML, sem confundir job com publicação; LOCK anchor; idempotência por request_fingerprint para pedidos iguais, permitindo rechecks explícitos distintos.
2. record_collector_fetch(p_job_id uuid,p_purpose dou_r4_target,p_attempt_no int,p_observation struct_capture_v4) RETURNS uuid, EXECUTE exclusivamente collector, com session_user exatamente collector e credencial vigente; observation nasce do client HTTPS interno, sem endpoint externo com acesso ao login; valida job/purpose/URL planejada, host, TLS, no redirect, response MIME e byte_count propósito, SHA real dos bytes, timestamps, locked credential epoch, fingerprint v4; grava CAPTURED ou ERROR/UNAVAILABLE/REJECTED, nunca "ausência publicada".
3. record_verifier_fetch(p_job_id uuid,p_purpose dou_r4_target,p_attempt_no int,p_observation struct_capture_v4) RETURNS uuid, EXECUTE exclusivamente verifier, exige GET HTTPS **novo e independente** com chave e rede separadas; as mesmas validações; não reutiliza hashes declarados pelo collector; emit em ledger imutável.
4. admit_documentary_chain(p_job_id uuid,p_pdf_collector uuid,p_pdf_verifier uuid,p_index_collector uuid,p_index_verifier uuid,p_zip_collector uuid,p_zip_verifier uuid,p_manifest_report_v4 jsonb,p_edition_report_v4 jsonb,p_dispatch_report_v4 jsonb) RETURNS uuid, EXECUTE verifier; não aceita verified=true nem status client. Valida, sob locks no job e credenciais, os seis eventos por FK typada e mesmo job/target/URL/hash, fonte índice oficial independently parsed, ZIP inventory+partes rederivados dos mesmos bytes do verifier, SHA contra âncora original e parent/child DB versions, PDF whole-dispatch completo e sufixo da edição; verifica assinatura de artefato de parser/version dentro da mesma sessão confiável e commit manifest+binding+verification+N act correlations atomicamente. **Relatórios JSON são dados a validar, não declarações de autenticidade**. Sem memória/processo confiável com bytes correspondentes, retornar UNVERIFIED/erro e não gravar positivo.
5. append_xml_temporal_fact(p_xml_anchor_id uuid,p_device_ref text,p_event_kind text,p_as_of date,p_fact_payload_v4 jsonb,p_optional_correlation_id uuid DEFAULT NULL) RETURNS uuid, EXECUTE temporal; nunca agenda PDF, exige âncora XML válida e fatos com fonte oficial (URL/hash se disponível), data e fragmento, nunca aceita set_CURRENT, checa se correlação opcional aponta à mesma âncora, grava append-only PENDING/FACTS_ONLY/UNVERIFIED.
6. read_global_documentary_status_by_version(p_child_version_id uuid) RETURNS (status dou_r4_documentary_status,evidence_id uuid,observed_at timestamptz) com somente **status público global** da norma, sem tenant/relevância/IDs privados. Antes de VERIFIED exige FK/roles/URLs/hashes pares/reports/fingerprint/document_key, ausência de conflitos entre jobs, credenciais não revogadas em transação com mesmo conjunto de locks do revoker. Leitura de relevância para cliente ocorre **fora desta função**, em associação com RLS e tenant auth efetiva. Não confiar em p_tenant_id do cliente ou GUC arbitrária. Se nenhum job: NOT_REQUESTED; se incompleto: PENDING; divergência: MISMATCH; interrupção: UNAVAILABLE; revogado: REVOKED; claims positivos contraditórios: CONFLICT.
7. add_credential(p_role,p_epoch,p_key_ref,p_valid_from,p_valid_until) e revoke_credential(p_credential_id,p_reason) somente credential_admin; lock na credencial e registro de revogação irreversível, processar ordem de locks consistente com escrita/projeção. Credencial revogada retroativamente invalida positividade de projeção, preserva histórico.
8. read_xml_temporal_facts(p_child_version_id uuid) é projeção **independente da função documentary** e somente disponibiliza fatos para avaliação tributária; nunca retorna CURRENT derivado. Proteção tenant no consumidor de relevância, revisão de fragmentos/corpus legal específica.

**NOTA sobre struct_capture_v4:** não criar tipo SQL facilmente invocável por API comum. O contrato de implantação precisa especificar como runtime autorizado usa a própria conexão/observação interna e como garantir que app/worker não obtêm credencial exclusiva; o banco não observa TLS e não pode autenticar rede só por SHA/HMAC/JSON. Na etapa 049+ o gateway deve usar colunas tipadas e entrada controlada; validar os dois workloads sob ameaça de forja de um deles. Se verificador comprometido e collector comprometido simultaneamente, isso é risco residual reconhecido, não "prova criptográfica".

### 5.3 Transação, autorização, reprodução de ataques

- Runtime chamadas SQL ficam sob session_user do LOGIN dedicado. Nenhuma role pode fazer SET ROLE para obter bypass, usar conexão de outra role, executar CREATEROLE ou escrever schema. Funções SECURITY DEFINER qualificam todos os objetos e recusam sessão do actor errado mesmo em caso de GRANT acidental.
- Uma capture event por (job,actor,purpose,attempt_no). Hash versionado: SHA256 JSON canônico/domínio, incluindo SHA dos bytes, URL final, epoch, horários, versão. Replay idêntico retorna id conhecido; replay divergente lança DOU_REPLAY_CONFLICT, nunca sobrescreve eventos. Retry novo aumenta attempt_no e preserva erro anterior.
- Não travar banco durante download; só transações curtas para eventos, validação de staging de digest e atestação. Locks advisory por job → credencial IDs ordenadas → xml_anchor, mesma ordem em revoker e projector; snapshot READ COMMITTED consistente ao concluir status; documentar linearização e invalidar cache positivo após revoke.
- Conflito cross-jobs: a projeção agrega resultados por child_publication_version_id + document_identity_key_v4; dedupe por SHA/versão, não por job. Dois positivos com digests diferentes para mesma versão/edição → CONFLICT, sem "winner takes last"; novo conteúdo normativo cria nova versão XML e revisão. Conflito entre status ao mesmo tempo → fail closed.
- CHECK/FK de forma sozinhos não provam dados rederivados de bytes: verificar ZIP, XML e PDF em função confiável interna; se qualquer parte do manifesto não fechar com ZIP original ou um dos atores divergir, não publicar positivo.
- Separação de parser PDF e motor jurídico: PDF parse só coteja; normalização não apaga números/negações, valida despacho inteiro e siblings anteriores/posteriores; char offsets e layout ambíguo permanecem UNVERIFIED.
- Superuser desonesto, dois workloads comprometidos, edição oficial retroativamente modificada e PDF descartado são riscos explícitos; retenção de metadados não confere audit replay dos bytes. Objeto original imutável fora de PG exige autorização futura.

### 5.4 Testes de segurança obrigatórios na futura 049+ (somente após R4 APPROVED)

1. PG16/18: FORCE RLS em TODAS as tabelas, owner NOLOGIN; app/worker/curator/issuer/sealer não SELECT nem INSERT nem EXECUTE; owner sem UPDATE/DELETE/TRUNCATE; search_path injection e SET ROLE negados.
2. Duas sessões collector/verifier: um actor isolado não obtém status VERIFIED mesmo fabricando SHA/DTO; dois eventos de papel igual falham; credencial expirada/revogada falha.
3. ZIP 25 MiB aceito como CAPTURED (se stream/parser válido); PDF 25 MiB rejeitado; ZIP 65 MiB rejeitado; decompressed >128 MiB rejeitado; 5001 entradas e entry >8 MiB rejeitados.
4. ZIP de 100 XML, 2 partes de uma matéria: zip_inventory_count=100, matter_parts_count=2, sem limitação indevida a 48 arquivos ZIP. Falha se parte faltante/duplicada ou filename pertencente a outro matter.
5. XML sem PDF agenda zero GET; permite facts-only temporal por dispositivo e taxonomia; SOURCE status NOT_REQUESTED e CURRENT permanece PENDING.
6. Uma única edição/verificação/GET PDF para 2 children do despacho; 2 correlações distintas ligadas a 2 âncoras corretas; nenhum acesso de outro tenant a relevância.
7. 80 vs 80-A vs 80-B: não admitir numérico 80 com DO1E sem índice oficial e cabeçalho PDF compatíveis. Alterar jornal/página/matter no índice ou XML impede positivo.
8. Conflito entre job recheck do mesmo XML com hash PDF diferente → CONFLICT e auditoria, não última escrita ganha; re-fetch nunca vira recibo retroativo.
9. Padrões de falha HTTP/PDF indisponível, 429, 503, XML ausente, índice rejeitado retornam UNAVAILABLE/ERROR/PENDING sem NO_RELEVANT_PUBLICATIONS global e sem deixar de classificar XML válido.
10. Credencial revogada concorrentemente ao commit de correlação e à leitura documental: projeção após revogação nunca VERIFIED; eventos permanecem append-only.
11. Teste relatório JSON e sourceCapture maliciosos com role app/verifier isolado; nenhum deles cria publicação oficial admitida sem cadeia de origens separadas.
12. SOURCE publicação, ratificação, retroatividade, alterações e prazo vencido não autorizam automaticamente LEGAL_CURRENT; migration 048 continua intocada, com R7/TAX11 bloqueados.

## 6. Critérios para encerrar DESENHO R4 e seguir à migração 049+

A revisão independente deve avaliar **a suficiência das interfaces e invariantes**, não presumir código ou SQL positivo já implementado. Há limites que precisam ser resolvidos ANTES de escrever migration 049+: (i) escolher e provar endpoint/editorial INDEX realmente independente com regra de parsing fail-closed; (ii) validar as reais keys/indexes/fontee metadata de publication_versions/publication_origins no head cumulativo; (iii) definir detalhes exatos do handoff de provas do parser confiável e dos grupos de funções transacionais para não deixar qualquer status positivo dependente de JSON arbitrário; (iv) final DDL de tabelas remanescentes e autorização tenant SQL testáveis sem confiar em prompt; (v) tratamento de race com revogação.

**NÃO declarar este documento SQL compilável nem o desenho APPROVED.** A aprovação independente pode concluir BLOCK caso alguma das questões acima ainda seja fundamental para a segurança arquitetural; informar risco P1/P2 concretamente. O objetivo da R4 é corrigir as contradições demonstradas na R3, preservando o desenho XML-first e deixando as interfaces abertas visíveis, e não mascará-las com testes sintéticos positivos.

**Nenhuma migração 049+, CI positivo de origem real, Railway, deploy, merge, reprodução histórica ou marcação jurídica CURRENT foi autorizada.**