# TAX13-R8-02 — Transition from direct CONFAZ to certified DOU custody

**2026-10-09. Status: architecture and read-only trace candidate only. R9 BLOCK. No production changes.**

## Owner decision and authoritative evidence

CONFAZ direct HTTPS is not reachable from the tested cloud egress. TriBusca already ingests CONFAZ acts through INLABS/DOU. The owner approves reviewing a DOU-based publication source instead of repeated CONFAZ HTTP probes.

The Imprensa Nacional explicitly warns that INLABS XML **does not replace certified DOU publication** (https://inlabs.in.gov.br/acessar.php). Decree 9215/2017 art. 4 requires authenticity/integrity of electronic DOU publication (https://www2.camara.leg.br/legin/fed/decret/2017/decreto-9215-29-novembro-2017-785835-normaatualizada-pe.html). XML alone, hashes alone, hostnames and fabricated fixture receipts never authorize legal CURRENT.

## Repository investigation

- DOU connector uses authenticated INLABS, sections DO1/DO1E/DO3/DO3E, stores archive SHA256 metadata, records source failures independently.
- DOU parser stores date, edition, section, idMateria, certified page viewer URL, ZIP SHA256 and individual XML SHA256/size; DOES NOT retain raw source ZIP/XML or JPG in PostgreSQL.
- Multiple CONFAZ acts may be split from one DOU dispatch. Embedded children reference their original dispatch and archive, but no separately authenticated certified text has been captured.
- Existing legal scope 044 and V2 issuer/verifier/SQL 046–048 are hardbound to CONFAZ HTML and independent CONFAZ transport receipt. DO NOT loosen by accepting DOU metadata as a surrogate for actual authenticated HTTP.
- CONFAZ consolidated text and DOU original publication can differ. A cross-source identity map requires explicit human-reviewable versioned act reference and exact bounded text correspondence.

## Branch deliverables so far

- Read-only preflight: src/modules/taxonomy/legal-scope/dou-source-custody-preflight.ts
- Negative tests: test/tax13-r802.dou-source-preflight.unit.test.ts
- Ephemeral GitHub unit workflow: .github/workflows/tax13-r802-dou-transition.yml

The preflight validates source code, channel, archive URL, section, edition, matter ID, XML SHA shapes, official page URLs, and child dispatch boundary. Even a seemingly consistent metadata record returns only DOU_XML_TRACE_ONLY and authenticates neither the source nor legal validity. Synthetic test inputs remain untrusted.

## Security gates REQUIRED before changing CURRENT

1. Independently download the actual certified DOU edition/matter (not a user-uploaded PDF and not just an INLABS XML export). Verify its official signature/authenticity against an independently administered root. Record SHA256, signed edition identity, signature/certificate and verifier policy version.
2. Bind every normalized act to the precise original certified text span: idMateria, date/section/edition/page, parent dispatch, heading and exact act boundaries, multipart pages and corrections. No act identity from incidental citations.
3. Use a separate trusted collector/verifier and append-only, revocable evidence receipts. Fail closed on signature failures, unavailable official source, modified original or stale content. An admin with both database and HMAC keys is NOT constrained; an independent signing/KMS/HSM/audit root is a separate design gate.
4. Produce per-segment legal-effectivity attestation of amendments, revocations and reference day. Original publication alone proves neither consolidation nor current vigency. Old versions and nonnormative editorial text stay excluded.
5. Design additive versioned SQL (suggest migration 049 after ownership coordination) with independent DOU source trust, cross-source mapping, separate current gate, issuer/verifier/sealer signatures, privileges and RLS. No implicit OR fallback on existing strict 048.
6. PG16 and PG18 adversarial and legitimate positive cases; independent R9 approval required before considering any merge or production migration.

## Storage and data model

Reuse DOU publication version and origin. Save one content-addressed reference/attestation per certified edition, not one PDF/ZIP for every act, tenant or capture. Store hashes and bounded metadata in PostgreSQL. If forensic retention is needed, keep one immutable encrypted object outside PostgreSQL, with a measured size limit, expiry policy and a retained lookup pointer; confirm policy with owner. Never store JPG. If certified original expires and cannot be independently checked, mark source evidence unverified, not green.

## Explicit status

R8-02 old CONFAZ HTTPS path remains fail-closed; no DOU source has been promoted. No merges on #186/#192/#193/#194. No Railway deployment, production migrations, scans, global reprocessing or green legal tags. Independent R9 not performed.

Governance: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101


## 2026-10-09 — Historical acervo ingest staging (no decision about who downloads)

The official historical collection is https://incombeta.in.gov.br/diario-oficial-da-uniao (Biblioteca Machado de Assis, 1808–2001). The Imprensa Nacional expressly warns that historical scans may contain illegible or faulty images and gives biblioteca@in.gov.br as contact. A folder/index link establishes ONLY an archive lookup target, not an authenticated exact page.

User has neither readable 1991/1997 source scans nor a final decision whether to download them personally. The import architecture must support BOTH paths without changing the source trust determination. Do not force a bulk PDF download or direct DBA insert merely to continue engineering.

### Implemented prototype

- src/modules/taxonomy/legal-scope/dou-historical-intake.ts is a pure, non-persistent intake preflight shared by acquisitionChannel AUTO and MANUAL; its input is historical text, a source candidate URL or bounded file bytes.
- The accepted media types are PDF, PNG, JPEG scans and plain/HTML transcriptions. The parser checks simple format magic, bounded file size (16 MiB) and transcription length (200,000 UTF-16 code units), official archive URL host/scheme shape, original filename traversal, date, period, section, act type and canonical two-digit years. It computes SHA-256 over supplied bytes/text.
- The preflight NEVER stores or returns source bytes/transcription, only compact metadata and hashes. It NEVER claims certified publication or legal CURRENT. A validated official-domain URL is a pointer, not cryptographic source custody. An acervo index URL is explicitly INDEX_ONLY.
- The caller must keep user uploads and automated source downloads in a temporary short-lived staging store (not implemented here); delete or quarantine them after independent review and retention decisions. No new PostgreSQL table or migration was created. No upload API, admin UI, remote downloader, persistent object storage or legal provenance authorization was implemented.
- Synthetic adversarial tests in test/tax13-r802.dou-historical-intake.unit.test.ts exercise both acquisition channels, sample 52/91 and 100/97 metadata, spoofed URLs, invalid dates, PDF headers, oversized input, path traversal and no evidence. Dedicated DOU CI now checks these alongside the previous R802 source trace tests.

### Requisite future production design (BLOCK)

1. Govern an admin-only ingestion UI or bounded CLI, antivirus/file-type validation, upload size quotas, operator attribution and durable audited revision history. Upload must not be SQL superuser access.
2. Store ONE content-addressed source snapshot per original DOU edition when explicitly approved for retention, outside PostgreSQL; reference SHA/location/tenant-neutral identity inside PG. No JPG copies or per-tenant duplicates.
3. Isolated independent archive verifier must fetch or authenticate actual page and confirm it is legible and corresponds to source matter/date/edition/page; for older scanned material do NOT infer contemporary ICP-Brasil signatures on 1991/1997 originals.
4. DOU original trace + authentic publication + official amendment/revocation chain are separate flags. The text already available in CONFAZ archives remains an unverified source transcription until matched to the historical page.
5. Add a versioned DB staging/attestation migration only after assigning ownership and reviewing schema collisions, RLS/privilege and archival retention decisions. Keep migration 048 legal gates fail-closed; no automatic promotion to CURRENT. Independent R9 remains mandatory.
