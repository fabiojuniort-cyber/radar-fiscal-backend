# Trifaros / TAX13-R9 — DOU source-evidence persistence RFC v2 (R9-DESIGN-R2)

**STATUS: DESIGN ONLY — NOT A MIGRATION, NOT APPROVED, NOT EXECUTED.** Branch `fix/tax13-r9-design-remediation-r2` builds on frozen R9-DESIGN BLOCK at backend SHA `e21334fa1b34f6af21c83d661a705fbd6ce58dfb`; decision and deficiencies in [governance #101](https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6093945807). All DDL below is an **illustrative review contract**, must be revised and separately authorized before an additive migration 049+. No existing table or migration 048 may be weakened. R9-DESIGN-R2 is **not yet APPROVED**.

## 1. Contract, threat boundaries, and non-goals (R9-D01)

**Evidence of government PUBLICATION**: a fresh, controlled HTTPS retrieval from a government hostname, its actual PDF bytes, exact printed section/date/edition/journal/page, full normative body, dispatch, and a matched original INLABS XML/ZIP matter with matching edition index. PDF digital signing/ICP-Brasil/ITI/OCSP/CRL is **NOT REQUIRED**. SHA-256 is integrity/dedupe, **not proof of network origin**. Publication does not grant ratification, legal validity, legal CURRENT, or tenant relevance.

Four separate principals, independent login credentials and deployment secrets:
1. `radar_dou_capture_runtime`: internal collector worker; controls official HTTPS networking, bounded byte streaming and direct parser invocation. Only this locked-down workload can submit source capture observations. **No client API/curator/user-supplied URLs, receipt JSON, digest or arbitrary body enter it.**
2. `radar_dou_correlator_runtime`: correlation worker consumes an internal immutable capture result (same in-memory bytes and checked digest) through an authenticated internal queue and checks against independently downloaded INLABS XML, the official DOU index and legal act. It must not mint HTTP captures. The authoritative correlation processor is NOT the exported `correlateOfficialDouPdfActText` function, which remains a pure testable `SYNTHETIC/NON_OFFICIAL` comparator. Its `sqlSourceAdmissionAllowed=false` field is informational, not an authentication gate.
3. `radar_dou_temporal_runtime`: reviewer writes evidence of ratification, deadlines, amendments, effectivity and supersession **per clause/device**, only after source registration. Cannot create `CAPTURED`.
4. `radar_app_runtime`, normal workers, issuers, scan-sealers, curators and tenant users: **no DOU raw-ledger INSERT/UPDATE/DELETE or collector admission function EXECUTE**. Only tightly constrained, non-privileged read projections.

The DB cannot prove HTTPS occurred merely from a passed digest, HMAC or `session_user`: trusted workload identity, locked code/release, TLS verification, separate secret custody and operator audit are outside SQL. A compromised authorized collector plus privileged DB administrator is residual risk. Run credentials are rotated; revoke in database **and** secret manager. The model is not evidence of cryptographic notarization. Existing `048` remains **strictly CONFAZ**; do not reuse its receipt tables/issuer proof path for DOU.

**Atomicity:** the collector computes observations from internally held bytes (not caller-supplied), hashes the same buffer, compares size/MIME/content and signs a bounded internal run envelope using an independent, service-held secret. The DB accepts the envelope **only** through the collector's restricted service identity and registered connector version. An HMAC on arbitrary user data is never admissible. The bundle includes monotonically generated `run_id`, unique `fetch_event_id`, purpose, URL, timestamps, HTTP details, source hash and message correlation digest. Index/ZIP/XML/PDF are distinct captures. No replay or manual import of a previous receipt is permitted.

## 2. State machine, source identity, and classification (R9-D02/D05)

Stages **must not be skipped**:
`RUN_STARTED → FETCH_ATTEMPT → HTTP_CAPTURED → PDF_PARSED + INDEX_CAPTURED + ZIP_CAPTURED + XML_CAPTURED → XML_CORRELATED → SOURCE_PUBLICATION_ATTESTED`.
Any stage may emit an immutable `ERROR`, `UNAVAILABLE` or `REJECTED`; none can be promoted to a success or zero-publication assertion. A collection cycle whose sources were consulted and evaluated completely can separately record `NO_RELEVANT_PUBLICATIONS` (relevance is client-specific and never a transport response). An empty result after a failed download is **UNKNOWN**, not zero.

Natural identity of each DOU edition/source document:
`(publication_date, section_code, official_journal_id, printed_edition, page_number, inlabs_matter_id, inlabs_zip_sha256, xml_parts_manifest_sha256, parent_dispatch_id, normative_act_id)`.
Use `edition_type=REGULAR/EXTRA` and **exact** `printed_edition='80'/'80-A'/'80-B'`. Numeric `editionNumber=80` and `DO1E` alone do not resolve suffix A/B. An independently captured **official DOU index** must bind the exact `journal=601` and printed `80-B` to date, section, page and matter; an authenticated original INLABS ZIP/parts must then bind the matter to dispatch and act. `printedEdition` passed by a caller or a public snippet is insufficient to admit a SQL positive. Failure to obtain either side leaves `INDEX_PENDING`/`XML_PENDING`, not `SOURCE_PUBLICATION_ATTESTED`.

Network captures retain `run_id + event_id` per attempt, even for repeated byte-identical content. Only an admitted identity+text-match fingerprint is unique, preventing conflicting positive conclusions. SHA disagreement between the former Railway capture (`9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`) and uploaded Extra 80-B (`e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`) remains **TEXT_EQUIVALENCE_UNVERIFIED**: no retained original GET bytes, so no retroactive comparison or invented replay.

## 3. Proposed types and relational DDL (NOT TO EXECUTE)

The explicit DDL specifies column types, keys, checks, provenance link and constraints. Ownership, role management, and admission functions below are **schematic** and must be transactionally implemented and tested in disposable PG16/PG18 **only after APPROVED R9-DESIGN-R2**. Check that `publication_versions(id)` and existing role names match the exact target migrations first.

```sql
-- PROPOSED MIGRATION 049+, DESIGN CONTRACT ONLY, DO NOT RUN.
CREATE TYPE dou_fetch_outcome AS ENUM ('CAPTURED','UNAVAILABLE','ERROR','REJECTED');
CREATE TYPE dou_target_kind AS ENUM ('INDEX','PDF','INLABS_ZIP','INLABS_XML');
CREATE TYPE dou_match_outcome AS ENUM
 ('INDEX_PENDING','XML_PENDING','TEXT_UNVERIFIED','TEXT_REJECTED','TEXT_CORRESPONDS');
CREATE TYPE dou_temporal_kind AS ENUM
 ('PUBLISHED','RATIFIED','RETROACTIVE_EFFECT','DEADLINE','CORRECTED',
  'AMENDED','REVOKED','SUPERSEDED','REVIEW_PENDING','REVIEW_COMPLETED');
CREATE TYPE dou_review_state AS ENUM ('PENDING','INSUFFICIENT','REVIEWED_FACTS_ONLY');

-- Each process/job is globally canonical, NEVER owned by a tenant.
CREATE TABLE tax13_dou_collector_runs (
 id uuid PRIMARY KEY,
 connector_code text NOT NULL CHECK(connector_code='dou'),
 connector_version text NOT NULL CHECK(length(connector_version) BETWEEN 4 AND 96),
 runtime_identity text NOT NULL CHECK(length(runtime_identity) BETWEEN 8 AND 128),
 credential_epoch bigint NOT NULL CHECK(credential_epoch>0),
 started_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,credential_epoch)
);

CREATE TABLE tax13_dou_http_fetch_events (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES tax13_dou_collector_runs(id) ON DELETE RESTRICT,
 target_kind dou_target_kind NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 100),
 requested_url text NOT NULL CHECK(length(requested_url) BETWEEN 20 AND 2048),
 final_url text,
 outcome dou_fetch_outcome NOT NULL,
 observed_at timestamptz NOT NULL,
 completed_at timestamptz NOT NULL,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 mime_type text,
 byte_count bigint CHECK(byte_count BETWEEN 0 AND 20971520),
 body_sha256 char(64) CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 source_envelope_sha256 char(64) NOT NULL CHECK(source_envelope_sha256 ~ '^[a-f0-9]{64}$'),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z0-9_]{3,80}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(completed_at >= observed_at),
 CHECK(
   (outcome='CAPTURED' AND http_status=200 AND byte_count>0
     AND body_sha256 IS NOT NULL AND final_url IS NOT NULL AND error_code IS NULL)
   OR
   (outcome<>'CAPTURED' AND body_sha256 IS NULL AND byte_count IS NULL
     AND error_code IS NOT NULL)
 ),
 UNIQUE(run_id,target_kind,attempt_no),
 UNIQUE(id,target_kind),
 UNIQUE(source_envelope_sha256)
);
CREATE INDEX ix_dou_fetch_recent
 ON tax13_dou_http_fetch_events(run_id,observed_at DESC);
CREATE INDEX ix_dou_fetch_body
 ON tax13_dou_http_fetch_events(target_kind,body_sha256)
 WHERE outcome='CAPTURED';

-- Account for *all* XML part hashes (never only a caller-supplied archive hash).
CREATE TABLE tax13_dou_archive_manifest (
 id uuid PRIMARY KEY,
 zip_fetch_event_id uuid NOT NULL UNIQUE,
 zip_kind dou_target_kind NOT NULL DEFAULT 'INLABS_ZIP'
   CHECK(zip_kind='INLABS_ZIP'),
 archive_sha256 char(64) NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 xml_parts_manifest_sha256 char(64) NOT NULL CHECK(xml_parts_manifest_sha256 ~ '^[a-f0-9]{64}$'),
 part_count integer NOT NULL CHECK(part_count BETWEEN 1 AND 48),
 parser_version text NOT NULL,
 verified_at timestamptz NOT NULL,
 FOREIGN KEY(zip_fetch_event_id,zip_kind)
  REFERENCES tax13_dou_http_fetch_events(id,target_kind) ON DELETE RESTRICT
);

-- Official-index binding must be independently sourced from observed response,
-- NOT deduced from caller printedEdition or XML numeric edition alone.
CREATE TABLE tax13_dou_edition_bindings (
 id uuid PRIMARY KEY,
 index_fetch_event_id uuid NOT NULL,
 index_kind dou_target_kind NOT NULL DEFAULT 'INDEX' CHECK(index_kind='INDEX'),
 pdf_fetch_event_id uuid NOT NULL,
 pdf_kind dou_target_kind NOT NULL DEFAULT 'PDF' CHECK(pdf_kind='PDF'),
 archive_manifest_id uuid NOT NULL REFERENCES tax13_dou_archive_manifest(id),
 publication_date date NOT NULL,
 section_code text NOT NULL CHECK(section_code IN ('DO1','DO1E','DO3','DO3E')),
 official_journal_id text NOT NULL CHECK(official_journal_id ~ '^[0-9]{1,4}$'),
 edition_type text NOT NULL CHECK(edition_type IN ('REGULAR','EXTRA')),
 printed_edition text NOT NULL CHECK(printed_edition ~ '^[0-9]{1,4}(-[A-Z])?$'),
 page_number integer NOT NULL CHECK(page_number BETWEEN 1 AND 9999999),
 inlabs_matter_id text NOT NULL CHECK(inlabs_matter_id ~ '^[0-9]+$'),
 original_xml_external_id text NOT NULL,
 index_content_sha256 char(64) NOT NULL CHECK(index_content_sha256 ~ '^[a-f0-9]{64}$'),
 xml_matter_sha256 char(64) NOT NULL CHECK(xml_matter_sha256 ~ '^[a-f0-9]{64}$'),
 binding_fingerprint_v1 char(64) NOT NULL UNIQUE
  CHECK(binding_fingerprint_v1 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL,
 CHECK((edition_type='REGULAR' AND section_code IN ('DO1','DO3')
          AND printed_edition !~ '-')
     OR(edition_type='EXTRA' AND section_code IN ('DO1E','DO3E')
          AND printed_edition ~ '-[A-Z]$')),
 FOREIGN KEY(index_fetch_event_id,index_kind)
  REFERENCES tax13_dou_http_fetch_events(id,target_kind) ON DELETE RESTRICT,
 FOREIGN KEY(pdf_fetch_event_id,pdf_kind)
  REFERENCES tax13_dou_http_fetch_events(id,target_kind) ON DELETE RESTRICT,
 UNIQUE(publication_date,section_code,official_journal_id,printed_edition,
        page_number,inlabs_matter_id,archive_manifest_id)
);

CREATE TABLE tax13_dou_act_correlations (
 id uuid PRIMARY KEY,
 binding_id uuid NOT NULL REFERENCES tax13_dou_edition_bindings(id) ON DELETE RESTRICT,
 source_publication_version_id uuid NOT NULL REFERENCES publication_versions(id),
 parent_dispatch_external_id text NOT NULL,
 act_external_id text NOT NULL,
 act_type text NOT NULL,
 act_number text NOT NULL,
 normalized_text_sha256 char(64) CHECK(normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
 matcher_version text NOT NULL,
 extractor_version text NOT NULL,
 match_outcome dou_match_outcome NOT NULL,
 report_sha256 char(64) NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
 reported_at timestamptz NOT NULL,
 verdict_fingerprint_v1 char(64) NOT NULL UNIQUE
   CHECK(verdict_fingerprint_v1 ~ '^[a-f0-9]{64}$'),
 CHECK(match_outcome<>'TEXT_CORRESPONDS' OR normalized_text_sha256 IS NOT NULL)
);
CREATE INDEX ix_dou_act_correlation_version
 ON tax13_dou_act_correlations(source_publication_version_id,reported_at DESC);

CREATE TABLE tax13_dou_temporal_review_events (
 id uuid PRIMARY KEY,
 source_correlation_id uuid NOT NULL REFERENCES tax13_dou_act_correlations(id),
 normative_fragment_id text NOT NULL,
 event_kind dou_temporal_kind NOT NULL,
 review_state dou_review_state NOT NULL,
 as_of_date date NOT NULL,
 effective_from date,
 effective_until date,
 deadline_date date,
 evidence_official_url text NOT NULL,
 evidence_digest char(64) NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 reviewed_by text NOT NULL,
 reviewer_policy_version text NOT NULL,
 replaces_event_id uuid REFERENCES tax13_dou_temporal_review_events(id),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(effective_until IS NULL OR effective_from IS NOT NULL),
 CHECK(effective_until IS NULL OR effective_until>=effective_from),
 CHECK(replaces_event_id IS NULL OR replaces_event_id<>id)
);
CREATE INDEX ix_dou_temporal_by_fragment
 ON tax13_dou_temporal_review_events
 (source_correlation_id,normative_fragment_id,as_of_date,recorded_at DESC);
```

**Integrity that CHECK/FK alone cannot establish:** the writer function must verify that every referenced fetch event has `CAPTURED`, matches hash/URL/expected MIME, belongs to the same authorized run/credential epoch, matches archive manifest and official index date/section/journal/edition, and that the XML matter is parsed from the **retrieved ZIP bytes** (not caller strings). Enforce capture observation and correlation entry in a single service-led unit of work with durable run ID and an idempotency key, or use signed internal queue with exact payload commitment and outbox. A SQL `CHECK (outcome=CAPTURED)` on its own does not establish governmental authenticity.

## 4. Authorization, append-only and RLS/FORCE RLS matrix (R9-D01/D04)

Create distinct NOLOGIN owner and privilege group roles, independent LOGIN identities; never grant collector role to app/worker/issuer/sealer or any tenant. Avoid relying on mutable session settings as credential checks. Example **non-executable template**:

```sql
-- Illustrative only. Owner role is NOLOGIN, not an application runtime.
CREATE ROLE radar_dou_ledger_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE radar_dou_capture_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE radar_dou_correlator_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE radar_dou_temporal_runtime LOGIN NOSUPERUSER NOBYPASSRLS;

-- Execute in deployment migration only, with actual owner/grant audit.
ALTER TABLE tax13_dou_http_fetch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax13_dou_http_fetch_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dou_owner_write ON tax13_dou_http_fetch_events
 FOR ALL TO radar_dou_ledger_owner USING (true) WITH CHECK (true);
REVOKE ALL ON tax13_dou_http_fetch_events FROM PUBLIC;
-- No regular INSERT grant to collector. Only a narrow SECURITY DEFINER
-- function accepts the captured internal bundle, guarded by session_user,
-- verifies registered connector runtime epoch and unique event IDs.
-- Ownership of tables/functions is radar_dou_ledger_owner. Revoke CREATE
-- in writable schemas and fix search_path='pg_catalog,public' with no pg_temp.

CREATE FUNCTION public.tax13_dou_append_observation(p_run uuid, p_event uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path = pg_catalog, public AS $$
 BEGIN
  IF session_user <> 'radar_dou_capture_runtime' THEN
   RAISE EXCEPTION 'DOU_COLLECTOR_IDENTITY_REQUIRED';
  END IF;
  -- IMPLEMENTATION OMITTED BY DESIGN:
  -- no generic JSON/URL/hash accepted from callers; function must receive
  -- an internally registered immutable collection request/envelope,
  -- created by authorized service + verified by separate private channel.
  RAISE EXCEPTION 'DOU_R9_DESIGN_ONLY_NOT_EXECUTABLE';
 END $$;
REVOKE ALL ON FUNCTION public.tax13_dou_append_observation(uuid,uuid)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax13_dou_append_observation(uuid,uuid)
 TO radar_dou_capture_runtime;
```

This function is **NOT** implementation-ready: there is no approved persistent internal envelope/queue API. It deliberately fails closed. For the actual proposal, every table above requires owner-only RLS insert/select policy under FORCE RLS, explicit append-only BEFORE UPDATE/DELETE trigger, REVOKE ALL from PUBLIC and app roles, constrained function grants **only** to the correct dedicated role. For index/manifest/bindings/correlations, only collector/correlator-owner definer functions may insert; temporal writer can insert only review facts and cannot produce `CURRENT`. A denied UPDATE/DELETE is tested both via ACL and trigger (including owner WITH RLS). A policy `TO PUBLIC USING(true)` without narrow GRANT review is **not sufficient** and is forbidden here.

**Role ↔ operation matrix:**

| Actor | Run / fetch | Edition binding | Correlation | Temporal facts | Tenant projection |
| --- | --- | --- | --- | --- | --- |
| Capture login | Append via guarded collector function | none | none | none | none |
| Correlator login | Read evidence via guarded reader | Append via guarded function | Append via guarded function | none | none |
| Temporal reviewer | Read derived source | Read derived identity | Read verified source | Append facts via guarded function | none |
| App/worker/curator/issuer/sealer | NO | NO | NO | NO | Scoped, read-only approved projection |
| Tenant end user | NO | NO | NO | NO | Own-tenant relevance only |
| DB owner NOLOGIN | Definer access, audited | Definer access | Definer access | Definer access | NO direct customer access |

**Never expose a `TEXT_CORRESPONDS` as `SOURCE_PUBLICATION_ATTESTED` solely because an exported TypeScript comparator returns success.** Positive admission requires **both** collectors' observed fetch chain and independently verified same-buffer PDF + index + ZIP/XML matter. Each operation has deterministic signed versioned canonical payload (UTF-8 NFC, stable field order and Unicode rules), generation from raw bytes by trusted service, and explicit algorithm version. Normalization upgrades produce new immutable evidence, never rewrite history.

## 5. State transitions, retry, idempotence, replay, locking

- A run represents one scheduled consultation, with stable UUID per execution and one `credential_epoch`. All independent attempts are events; **no UPDATE of a failed attempt to CAPTURED**. Retry is a **new event with attempt_no+1** and its own UTC timestamps and immutable run envelope.
- Two workers competing for the same target acquire `pg_advisory_xact_lock(hashtextextended(canonical_source_identity,0))` or a stable target-row `SELECT FOR UPDATE`. Always lock in deterministic (source/date/journal/matter) order. Use a deterministic `binding_fingerprint_v1` (version label + ordered canonical identity fields + raw source digests). Conflicting claims for a natural identity must reject and alert; do not overwrite the old positive.
- A service crash after HTTPS but before DB commit causes an `ERROR/UNKNOWN` run in audit and a new authenticated retry; **never fabricate CAPTURED retrospectively from SHA**. Atomic commit of admitted `fetch_event` and `correlation` needs durable internal proof chain; partial stage is PENDING and not externally affirmative.
- Enforce unique event UUID and internal envelope signature/nonce. Replay of previous credential epoch, duplicate event ID, changed payload with same signature or expired/revoked key is rejected. Rotate credential epoch and workload secret with overlap policies, but source positives relying on revoked credentials become `UNVERIFIED` under the read projection; raw evidence stays append-only.
- `UNAVAILABLE` (official site unreachable), `ERROR` (network/parser/runtime), `REJECTED` (untrusted/inconsistent) are **not** `NO_RELEVANT_PUBLICATIONS`. The latter exists only in a post-success relevance evaluation per tenant, never as HTTP outcome.
- The ingestion and evidence tables are **global, canonical and tenant-free**. Tenant relevance joins a separate tenant-owned table with FK to publication identity and FORCE RLS using request tenant context verified by backend auth; tenant A must never SELECT/modify tenant B's relevance.
- Superseding act/legal analysis appends new events referencing earlier evidence, preserving scan fingerprints. Legal `CURRENT` is never inferred from event state; existing multi-step legal V2/attestation gates remain separate and OFF by default.

## 6. Text extraction and matching (R9-D03/D07)

- Use same PDF buffer for SHA-256 and `pdfjs-dist` page extraction. One page only; bound raw size to 20 MiB and text to 300k characters. Do not convert JPGs or run OCR.
- Verify actual masthead first edition/date/**section** and EXTRA label; check journal ID via captured official index (not from PDF header alone); check parent dispatch and child legal act exact identity and all clauses. Validate entire normalized act **at its heading**, delimit the end and ensure subsequent material is either fully accounted for as separately parsed sibling acts or explicitly UNVERIFIED.
- Comparator output is `DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY`, `grantsLegalCurrent=false`, `sqlSourceAdmissionAllowed=false` with `normalizationVersion`. A full privileged admission event may only be emitted by authorized collector/correlator services after verifying the entire chain.
- Treat `hasEOL`, item transforms, word spacing, vertical/y reorder, overlapping two-column text and PDFs that extract unusually as possible **layout ambiguity**; fail `UNVERIFIED` if ordering cannot be reconstructed safely. Test real one-page DOU PDFs, including extra 80-B, only if legitimately available; synthetic tests never become live proof.
- Include a diagnostic-only bounded mismatch report (reason, normalized digest, limited item offsets, parser version; **not** raw PDF/long legal paragraphs). NFKC, Unicode case, dash and whitespace normalization can conceal material changes: version each algorithm, test numbers, negation, clause boundaries, punctuation, columns, and visually confusable digits.

## 7. Retention/audit (R9-D06)

Store only source URL, official edition identity, capture attempt outcomes, timestamps, sanitized errors, digest, extractor and parser versions, and provenance links. **Never store original PDF, JPG, ZIP blobs in PostgreSQL.** Multi-tenant clients reference one canonical publication.

Without raw PDF bytes, later replay of the historical text extraction may be impossible if official URL changes, disappears or is reissued. On re-fetch **never label new bytes as old bytes**. A future object-storage option may hold exactly one immutable original file per SHA with TTL/legal hold, strong IAM, signed lifecycle evidence and separate encryption keys, only after owner approval and cost/retention review. No storage service or new paid resource in this phase.

Audit metadata has a documented retention window (proposal: positive source identity, legal review and SHA indefinitely while product/legal requirements apply; attempt errors for 180 days, aggregated statuses longer; actual retention requires legal/product approval). Retention deletion must be audited and not break referenced proofs (FK protects positives). Avoid collecting credentials, private headers, cookies or personal data in fetch logs.

## 8. Temporal review by device (R9-D08)

Event types are distinct: original PUBLISHED, RATIFIED, RETROACTIVE_EFFECT, DEADLINE, CORRECTED, AMENDED, REVOKED, SUPERSEDED and reviewer state PENDING. Each review event binds **source correlation, specific normative fragment/clause, exact official URL, source SHA, as-of date, reviewer identity/policy, effective date/window, superseded event ID**, never a global yes/no based on an act title.

Convênio ICMS 15/24: publicized 2024-04-25; exceptional deadline 2024-04-25; ratification on 2024-05-02; retroactive effects declared from 2024-04-01; March/2024 SCANC facts. An expired exceptional deadline is not equivalent to revoked act; ratification is not current operative application in October 2026. Later amendments and device-specific effects remain PENDING. NO automatic CURRENT or green highlighting.

## 9. R9-DESIGN-R2 acceptance matrix

| Finding | Target remedy | Proof/gate |
| --- | --- | --- |
| P1 D01 trust boundary | Dedicated collector identity and non-SQL-observable workload receipts; no DTO admission | Synthetic fake capture must fail external admission; PG role matrix future |
| P1 D02 80 vs A vs B | Independent official index+PDF+INLABS binding with composite key | 80/A/B, journal and archive mismatch tests |
| P1 D03 full content | Masthead section, bounded act end, sibling matching, algorithm version | Negative extra clause/section/different wording; PDF ordering |
| P1 D04 SQL contract | This DDL + ACL / FORCE RLS + concurrency/retries | R9 review **before implementing 049+**; PG16/18 only after approval |
| P1 D05 missing real bytes | explicit UNVERIFIED and no replay | Real same-buffer GET+XML **pending separate authorization** |
| P2 D06 retention | minimal metadata with replay limitation | reviewer approval of retention policy |
| P2 D07 extractor | order diagnostics and fail-closed ambiguity | synthetic layout tests + real PDF tests pending |
| P2 D08 temporal | independent per-clause events and dates | ratification/deadline not CURRENT |

**Required final gates**: independent R9-DESIGN-R2 **APPROVED for design alone**; then approved additive migration implementation, adversarial PG16/18, actual official capture and original INLABS match with legitimate credentials, R7/TAX11 positive tests, full CI and final R9 with SHA pinned; separate explicit owner approval before any merge/production/extra Railway services. Failure of any gate = BLOCK.
