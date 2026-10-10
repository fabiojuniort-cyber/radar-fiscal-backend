-- R9-DESIGN-R4 RELATIONAL DDL DRAFT ONLY — NOT migration 049+.
-- DO NOT EXECUTE; SQL compilability and PG16/18 security tests NOT VERIFIED.
-- Missing guarded functions, owner roles, RLS, append-only, official index adapter.
-- XML is canonical, PDF optional for selected documentary attestation only.

-- DESIGN ONLY / DO NOT APPLY
CREATE TYPE public.dou_r4_actor AS ENUM ('COLLECTOR','VERIFIER');
CREATE TYPE public.dou_r4_target AS ENUM ('PDF','OFFICIAL_INDEX','INLABS_ZIP');
CREATE TYPE public.dou_r4_outcome AS ENUM ('CAPTURED','UNAVAILABLE','ERROR','REJECTED');
CREATE TYPE public.dou_r4_verdict AS ENUM ('CORRESPONDS','REJECTED','UNVERIFIED');

-- One global XML matter, shared by all child acts and N customers.
CREATE TABLE public.tax13_dou_xml_matters (
 id uuid PRIMARY KEY,
 source_origin_id uuid NOT NULL REFERENCES public.publication_origins(id) ON DELETE RESTRICT,
 parent_publication_id uuid NOT NULL REFERENCES public.publications(id) ON DELETE RESTRICT,
 parent_publication_version_id uuid NOT NULL REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 parent_version_no integer NOT NULL CHECK(parent_version_no>0),
 parent_content_hash text NOT NULL,
 publication_date date NOT NULL,
 section_code text NOT NULL CHECK(section_code IN ('DO1','DO1E','DO3','DO3E')),
 numeric_edition integer NOT NULL CHECK(numeric_edition>0),
 journal_id text NOT NULL CHECK(journal_id ~ '^[0-9]+$'),
 page_number integer NOT NULL CHECK(page_number>0),
 matter_id text NOT NULL CHECK(matter_id ~ '^[0-9]+$'),
 parent_external_id text NOT NULL,
 archive_url text NOT NULL,
 archive_sha256 char(64) NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 xml_parts_sha256 char(64) NOT NULL CHECK(xml_parts_sha256 ~ '^[a-f0-9]{64}$'),
 matter_key_v4 char(64) NOT NULL CHECK(matter_key_v4 ~ '^[a-f0-9]{64}$'),
 matter_content_key_v4 char(64) NOT NULL UNIQUE CHECK(matter_content_key_v4 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(id,matter_key_v4), UNIQUE(id,parent_publication_version_id)
);
CREATE TABLE public.tax13_dou_xml_act_anchors (
 id uuid PRIMARY KEY,
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 child_publication_id uuid NOT NULL REFERENCES public.publications(id) ON DELETE RESTRICT,
 child_publication_version_id uuid NOT NULL REFERENCES public.publication_versions(id) ON DELETE RESTRICT,
 child_version_no integer NOT NULL CHECK(child_version_no>0),
 child_content_hash text NOT NULL,
 child_external_id text NOT NULL,
 embedded_index integer CHECK(embedded_index IS NULL OR embedded_index>=1),
 act_version_key_v4 char(64) NOT NULL UNIQUE CHECK(act_version_key_v4 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(id,xml_matter_id), UNIQUE(id,child_publication_version_id),
 UNIQUE(xml_matter_id,child_publication_version_id)
);

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
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 selection_reason text NOT NULL CHECK(selection_reason ~ '^[A-Z0-9_]{3,64}$'),
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
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(id,xml_matter_id)
);
CREATE INDEX dou_r4_job_lookup ON public.tax13_dou_collection_jobs
 (publication_date,section_code,official_journal_id,page_number);
CREATE TABLE public.tax13_dou_http_fetch_events (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id)
  ON DELETE RESTRICT,
 actor public.dou_r4_actor NOT NULL,
 purpose public.dou_r4_target NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 1000),
 credential_id uuid NOT NULL REFERENCES public.tax13_dou_runtime_credentials(id),
 outcome public.dou_r4_outcome NOT NULL,
 requested_url text NOT NULL, final_url text,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 mime_type text, byte_count bigint,
 CHECK(outcome<>'CAPTURED' OR
  (purpose='PDF' AND byte_count BETWEEN 1 AND 20971520) OR
  (purpose='OFFICIAL_INDEX' AND byte_count BETWEEN 1 AND 2097152) OR
  (purpose='INLABS_ZIP' AND byte_count BETWEEN 1 AND 67108864)),
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
CREATE INDEX dou_r4_fetch_lookup ON public.tax13_dou_http_fetch_events
 (job_id,actor,purpose,finished_at DESC);
CREATE TABLE public.tax13_dou_archive_manifest (
 id uuid PRIMARY KEY,
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 zip_inventory_sha256 char(64) NOT NULL CHECK(zip_inventory_sha256 ~ '^[a-f0-9]{64}$'),
 zip_total_entries integer NOT NULL CHECK(zip_total_entries BETWEEN 1 AND 5000),
 zip_uncompressed_bytes bigint NOT NULL CHECK(zip_uncompressed_bytes BETWEEN 0 AND 134217728),
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 collector_zip_event_id uuid NOT NULL, verifier_zip_event_id uuid NOT NULL,
 collector_actor public.dou_r4_actor NOT NULL DEFAULT 'COLLECTOR'
  CHECK(collector_actor='COLLECTOR'),
 verifier_actor public.dou_r4_actor NOT NULL DEFAULT 'VERIFIER'
  CHECK(verifier_actor='VERIFIER'),
 zip_purpose public.dou_r4_target NOT NULL DEFAULT 'INLABS_ZIP'
  CHECK(zip_purpose='INLABS_ZIP'),
 zip_sha256 char(64) NOT NULL CHECK(zip_sha256 ~ '^[a-f0-9]{64}$'),
 matter_parts jsonb NOT NULL CHECK(jsonb_typeof(matter_parts)='array' AND
  jsonb_array_length(matter_parts) BETWEEN 1 AND 48 AND
  pg_column_size(matter_parts) <= 16384),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(id,job_id), UNIQUE(id,xml_matter_id),
 UNIQUE(job_id,xml_matter_id,zip_sha256,manifest_sha256),
 FOREIGN KEY(job_id,xml_matter_id)
  REFERENCES public.tax13_dou_collection_jobs(id,xml_matter_id),
 FOREIGN KEY (collector_zip_event_id,job_id,collector_actor,zip_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose),
 FOREIGN KEY (verifier_zip_event_id,job_id,verifier_actor,zip_purpose)
  REFERENCES public.tax13_dou_http_fetch_events(id,job_id,actor,purpose)
);
CREATE TABLE public.tax13_dou_edition_bindings (
 id uuid PRIMARY KEY,
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL REFERENCES public.tax13_dou_collection_jobs(id),
 manifest_id uuid NOT NULL,
 collector_index_event_id uuid NOT NULL, verifier_index_event_id uuid NOT NULL,
 collector_pdf_event_id uuid NOT NULL, verifier_pdf_event_id uuid NOT NULL,
 collector_actor public.dou_r4_actor NOT NULL DEFAULT 'COLLECTOR'
  CHECK(collector_actor='COLLECTOR'),
 verifier_actor public.dou_r4_actor NOT NULL DEFAULT 'VERIFIER'
  CHECK(verifier_actor='VERIFIER'),
 index_purpose public.dou_r4_target NOT NULL DEFAULT 'OFFICIAL_INDEX'
  CHECK(index_purpose='OFFICIAL_INDEX'),
 pdf_purpose public.dou_r4_target NOT NULL DEFAULT 'PDF'
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
 UNIQUE(id,job_id), UNIQUE(id,xml_matter_id),
 FOREIGN KEY(manifest_id,xml_matter_id) REFERENCES public.tax13_dou_archive_manifest(id,xml_matter_id),
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
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 binding_id uuid NOT NULL,
 verifier_credential_id uuid NOT NULL REFERENCES
  public.tax13_dou_runtime_credentials(id),
 result public.dou_r4_verdict NOT NULL,
 normalized_dispatch_sha256 char(64)
  CHECK(normalized_dispatch_sha256 ~ '^[a-f0-9]{64}$'),
 normalization_version text NOT NULL,
 report_sha256 char(64) NOT NULL UNIQUE
  CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
 failure_code text, verified_at timestamptz NOT NULL,
 UNIQUE(id,binding_id), UNIQUE(id,xml_matter_id),
 FOREIGN KEY(binding_id,xml_matter_id) REFERENCES public.tax13_dou_edition_bindings(id,xml_matter_id),
 FOREIGN KEY(binding_id,job_id)
  REFERENCES public.tax13_dou_edition_bindings(id,job_id),
 CHECK((result='CORRESPONDS' AND normalized_dispatch_sha256 IS NOT NULL
  AND failure_code IS NULL)
  OR (result<>'CORRESPONDS' AND failure_code IS NOT NULL))
);
CREATE TABLE public.tax13_dou_act_correlations (
 id uuid PRIMARY KEY, verification_event_id uuid NOT NULL,
 xml_matter_id uuid NOT NULL REFERENCES public.tax13_dou_xml_matters(id) ON DELETE RESTRICT,
 xml_act_anchor_id uuid NOT NULL,
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
 UNIQUE(id,xml_act_anchor_id), UNIQUE(verification_event_id,xml_act_anchor_id),
 FOREIGN KEY(xml_act_anchor_id,xml_matter_id) REFERENCES public.tax13_dou_xml_act_anchors(id,xml_matter_id),
 FOREIGN KEY(xml_act_anchor_id,child_act_version_id)
  REFERENCES public.tax13_dou_xml_act_anchors(id,child_publication_version_id),
 FOREIGN KEY(xml_matter_id,parent_dispatch_version_id)
  REFERENCES public.tax13_dou_xml_matters(id,parent_publication_version_id),
 FOREIGN KEY(verification_event_id,xml_matter_id) REFERENCES public.tax13_dou_verification_events(id,xml_matter_id),
 FOREIGN KEY(verification_event_id,binding_id)
  REFERENCES public.tax13_dou_verification_events(id,binding_id)
);
CREATE INDEX dou_r4_correlations_act ON public.tax13_dou_act_correlations
 (child_act_version_id,correlated_at DESC);
CREATE TABLE public.tax13_dou_xml_temporal_review_events (
 id uuid PRIMARY KEY,
 xml_act_anchor_id uuid NOT NULL REFERENCES public.tax13_dou_xml_act_anchors(id) ON DELETE RESTRICT,
 optional_documentary_correlation_id uuid,
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
  public.tax13_dou_xml_temporal_review_events(id),
 review_status text NOT NULL CHECK
  (review_status IN ('PENDING','UNVERIFIED','FACTS_ONLY')),
 event_sha256 char(64) NOT NULL UNIQUE
  CHECK(event_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(optional_documentary_correlation_id,xml_act_anchor_id)
  REFERENCES public.tax13_dou_act_correlations(id,xml_act_anchor_id) ON DELETE RESTRICT,
 UNIQUE(id,xml_act_anchor_id),
 FOREIGN KEY(supersedes_event_id,xml_act_anchor_id)
  REFERENCES public.tax13_dou_xml_temporal_review_events(id,xml_act_anchor_id),
 CHECK(effect_until IS NULL OR effect_from IS NOT NULL),
 CHECK(effect_until IS NULL OR effect_until>=effect_from),
 CHECK(supersedes_event_id IS NULL OR supersedes_event_id<>id)
);
CREATE INDEX dou_r4_temporal_by_device ON public.tax13_dou_xml_temporal_review_events
 (xml_act_anchor_id,device_ref,legal_as_of DESC);
