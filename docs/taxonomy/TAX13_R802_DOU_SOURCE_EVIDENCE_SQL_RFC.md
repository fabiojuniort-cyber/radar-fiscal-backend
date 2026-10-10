# Trifaros — TAX13-R8-02 | Proposal for DOU evidence persistence (design-only)

**Status: RFC for R9; not a migration.** This document makes no database changes and does not authorize legal CURRENT or deployment. Owner's controlling policy (2026-10-10): original PDF from trustworthy government HTTPS source with text/edition checks; **no PDF-signature/ICP/CRL/OCSP validation**.

## Why a new source path is necessary

The older `048_tax13_r802_authenticated_http_capture.sql` controls CONFAZ HTML authenticity with its collector-specific identity, private capture MAC and original HTTP evidence. It **cannot** be reused as an admission channel for DOU PDFs simply by changing a URL, filling in simulated HTTP fields or setting a boolean. Preserve migration 048 **unchanged**. Its recorded transport TLS peer checksum, when present, belongs to network transport audit; it is not a request to validate digitally signed PDF certificates.

As of 2026-10-10, a one-shot Railway Function fetched a government PDF from `pesquisa.in.gov.br` (HTTP 200, 865139 bytes, SHA `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`). Its bytes were deliberately **not stored** and the Function was immediately deleted. Uploaded Extra 80-B (1 page, SHA `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`) differs bytewise. The content of the captured PDF **was not parsed**, so parity cannot be claimed. More service creation is not authorized by the previous one-time approval.

## Proposed minimal additive model (not implemented)

### 1. `tax13_dou_http_fetch_events`

Append-only, collector-origin metadata of each attempted/successful official HTTP download, common fields:

- `event_id UUID` primary key, `source_code='dou'`, `source_publication_version_id`, `fetched_at`, `outcome` (`CAPTURED`, `UNAVAILABLE`, `ERROR`, `REJECTED`), sanitized `error_code`.
- `requested_url`, `final_url`, `http_status`, `content_type`, `byte_count`, `sha256`, `publication_date`, `journal`, `section`, `page`, `collector_job_id` and `collector_version`.
- `request_source` = internal INLABS matter trace; no arbitrary client-provided URL or raw HTTP receipt can become an official capture. `external_invoice`, tenant/user fields and PDF blob/text are deliberately **absent**.
- Preserve `UNAVAILABLE` and `ERROR` as execution outcomes, **not** zero publications found.
- On successful one-page match, retain only needed metadata + source URL + digest; single-copy original object storage, outside PG and behind retention policy, may be proposed later but requires separate approval.

### 2. `tax13_dou_act_correlations`

Append-only relation (`http_event_id`, `inlabs_archive_sha256`, `inlabs_matter_id`, `parent_dispatch_publication_version_id`, `child_act_version_id`, `printed_edition`, `extractor_version`, `text_match_algorithm_version`, `normalized_act_digest`, `status`, `checked_at`).

- Only the **same-byte** chain `controlled HTTPS GET → bounded one-page PDF → native-text extraction → exact, re-derived complete act match` may emit `TEXT_CORRESPONDS`; no role allowed to insert a pretended positive result based solely on a user-uploaded PDF, a pasted URL or independently supplied extracted text.
- Edition regular #80, Extra #80-A and Extra #80-B on the same day are **different** publication identities. Never join by date or bare edition number.
- Retry without losing audit trail; correlation fingerprint prevents duplicate candidate records, but unique raw HTTP event remains identifiable.
- `TEXT_CORRESPONDS` is a **source/text verdict only**, not `SOURCE_LEGALLY_CURRENT`.

### 3. `tax13_dou_temporal_review_events`

Append-only review facts from official URLs: original publication, ratification, declared retroactive effects, deadline per clause, scope period, correction/amendment/revocation notices, as-of review date, and reviewer conclusions with explicit evidence references.

- For **Convênio ICMS 15/24** (official CONFAZ pages), the original publication was 2024-04-25, national ratification 2024-05-02 by Ato Declaratório 10/24, declared effects retroactive to 2024-04-01, exceptional payment deadline 2024-04-25, and material subject to March 2024 SCANC facts.
- Deadline comparisons are factual; *expiry of a one-off deadline is not equivalent to revocation or legal invalidity*. Passage of time does not prove current operative application to an arbitrary taxpayer.
- Mandatorily store `amendment_review_status=PENDING` and `legal_current_review_status=PENDING` until independent evidence and separate approval; **never infer green from ratification alone**.

## Security requirements before writing migration 049+

- One explicit, minimal writer role for the bounded DOU collector with narrow functions or policies; forbid `radar_app_runtime`, customer tenants, scan-sealer and curators from fabricating official capture success. No ordinary INSERT permission on admission/proof tables. FORCE RLS, append-only and restrictive `SECURITY DEFINER` paths with pinned `search_path`.
- No owner/admin-supplied string can masquerade as network observation; isolate collector execution events from subsequent legal reviewer findings. A trusted internal collector identity/receipt is an operational access control, **not an ICP-Brasil signature requirement**.
- All outputs reject duplicates/conflicts and handle missing/inaccessible DOU as `ERROR/UNAVAILABLE`; use independent validation and PG16/PG18 malicious-input tests.
- Migration 048 is **not** relaxed or migrated in place, and the existing SQL selector for legal CURRENT is not changed in this RFC.
- No PDF, JPG, OCR archive, NCM global reprocessing, Railway production operations or tenancy fan-out as a side effect. If retention is needed later, store original bytes once in bounded object storage outside PostgreSQL.

## Exact execution gates

1. Design review of writer-role isolation, source-page identity, RLS, append-only and text-normalization false-positive/false-negative tests.
2. Obtain and compare actual content of a real official HTTP downloaded PDF with archived Extra 80-B and its original INLABS XML. The Railway function has already been removed; **do not recreate services without fresh permission**.
3. Implement SQL migration and corresponding new path in a separate small PR only after R9-design signoff. Fail-closed if any archive/PDF correspondence is missing.
4. Revalidate public-source ratification, later amendments and applicable dates by **device**, then legitimate legal-positive tests and independent R9. CI green and production gates still required.

**This file is technical preparation, not a verified source-admission claim.**
