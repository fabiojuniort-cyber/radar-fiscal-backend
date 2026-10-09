# TAX13-R8-02 — Transition from direct CONFAZ to certified DOU custody

**2026-10-09. Status: architecture and read-only trace candidate only. R9 BLOCK. No production changes.**

## Owner decision and authoritative evidence

CONFAZ direct HTTPS is not reachable from the tested cloud egress. Trifaros already ingests CONFAZ acts through INLABS/DOU. The owner approves reviewing a DOU-based publication source instead of repeated CONFAZ HTTP probes.

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


## Scope update — 2026-10-09: historical archive work SUSPENDED

The owner directed that historic DOU data and document recovery/import work be **removed from the active TAX13-R8-02 scope**. Do not download digitized 1991/1997 editions, create a manual importer, activate the historical intake CLI, or allocate database/object storage for archival scans at this stage. The previous prototype and rationale remain in Git commit history and the governance issue; they are not active deployables.

This scope adjustment does **not** delete, overwrite, reclassify, or reprocess any historical documents already existing in Trifaros. Existing legal claims lacking positive authenticated evidence remain UNVERIFIED/BLOCK. The existing defensive guard which refuses to misrepresent pre-2020 publications as INLABS XML is retained as an input validation rule, not a historical extraction project.

**Current target:** contemporary DOU INLABS transport/certified publication provenance, exact CONFAZ dispatch-to-act integrity, independently managed legal verification, PostgreSQL 16/18 security negatives, and R7/main CI without weakening 048. No merge, no production deployment, no green CURRENT without genuine external official evidence and independent R9 review.


## Contemporary certified PDF byte preflight — 2026-10-09 (R9 BLOCK)

The independent PDF-byte preflight in `src/modules/taxonomy/legal-scope/dou-pdf-byte-preflight.ts` is an **additional untrusted, read-only stage**, not official certification. It accepts bounded bytes (max 20 MiB) from a separately controlled HTTPS fetch, checks only basic PDF framing and the direct `pesquisa.in.gov.br/imprensa/servlet/INPDFViewer` URL's exact edition date, journal and page against the pre-existing INLABS matter trace, and calculates SHA-256. It deliberately returns `authenticatedOfficialPublication=false` and `grantsLegalCurrent=false` for **every outcome**. It never downloads files, validates certificate chains, persists PDF content, or authorizes the SQL worker.

Independent review statements can also be cross-checked against the actual supplied PDF's SHA-256, but even a successful reviewer signature/hash match proves only consistency with the signed assertion, not that the independently trusted Imprensa Nacional certified that PDF. A separate certificate-chain/official authenticity verifier, independent key root, exact PDF text-to-dispatch span comparison, corrections, vigency and R9 are still required.

**Official contemporary publication reference only:** Imprensa Nacional's certified-edition PDF URL `https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1` identifies 25 April 2024 extraordinary issue no. 80-B, page 1, `DESPACHO Nº 16`, which contains `CONVÊNIO ICMS Nº 15/2024`. The search index exposes text, but PDF byte download from this tool context failed. No PDF hash or ICP-Brasil validation is claimed; no INLABS/XML custody or legal effectivity linkage is established by merely identifying this source.

**Requirement for continuation:** access to actual certified PDF bytes from the official primary source and an independently administered official verification method. Never substitute a search snippet, third-party mirror, unverified reader's PDF, hash-only attestation or the reviewer's signature. Keep the historical 1991/1997 work paused.

**Naming:** Product name is Trifaros. Historical code identifiers, immutable proof signature domain separators, repository names and URLs retain legacy strings until a separately versioned compatible migration; do not silently replace cryptographic message bytes.
