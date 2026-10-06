# ACT-SCOPE-01 — central publication exception policy

Status: proposed R2 implementation on backend base `e59c4e9a82b63d6bb07574be9f3c9552d2b69e13`. No merge, deployment, production dry-run, SUPPRESS or DELETE has been performed by this work.

## Runtime contract

`src/modules/collection/publication-exclusion-policy.ts` is the single versioned exception list (`LEGAL_BASE_EXCLUSIONS`, `2026-10-06.v1`). The engine evaluates it after normalization and before the item transaction. EXCLUDE creates no publication, origin, version, file, collection item or run-publication link; operational runs/attempts and exclusion counters remain. Array collection, sealed spool replay and DOU backfill use this same gate. Source identity comes from `sources.code`, never an inferred connector alias.

Matching uses Unicode NFKD, accent removal, uppercase, punctuation/symbol-to-space and whitespace collapse, followed by exact source/type lookup. It never changes collected act_type, content, identity or version hashes. No substring, wildcard, prefix or fuzzy match selects an exception. KEEP and REVIEW both continue normal persistence. Missing/unknown type or source and insufficient evidence fail open.

The initial nine exact types are limited to source `dou`, sections `DO3`/`DO3E`, and positive proof of routine administrative content. A type match alone is insufficient. The official article type and every part's type/section must agree with the canonical exception; title refinement cannot override conflicting source evidence. Both publication and origin metadata must independently support exclusion, with KEEP/REVIEW vetoes preserved. Full body and supplementary inventories are required; unknown prose/object, conflicting title, CNPJ, fiscal/regulatory/corporate signals, attachments, omitted images or incomplete structure veto exclusion. Nonempty unexamined XML body fields and unexamined visual/CSS evidence mark structure incomplete without rewriting canonical text or hashes. Routine objects are intentionally restricted to literal office/cleaning/security/printing supplies/services. This may yield very few or zero actual exclusions.

Other sources are unchanged. DO1/DO1E, generic AVISO/EDITAL/EXTRATO/PORTARIA/RESOLUÇÃO/DECISÃO/DESPACHO/COMUNICADO/CONVÊNIO/ATO, personnel/academic/council categories and unmapped values are not newly excluded. Normative/fiscal types are explicitly protected or REVIEW. EXTRATO DE CONTRATO is not in the new list: existing D-066 `dou-scope-v4` remains authoritative, including KEEP/REVIEW vetoes. Outside that exception, any full CNPJ mention conservatively yields REVIEW; no tenant-private retention category or privacy bypass is introduced.

## Inventory and impact

The authenticated product inventory reported in this session on 2026-10-06 had **1,328 nonempty act_type options**, **77,497 visible publications**; the select additionally contains `Todos`. These are visible, unnormalized global types, not the historical SQL catalog and not distinct normalized families. This checkout does not contain the complete literal 1,328-value extraction.

The supplied first-pass inventory marked 117 types / 4,206 items for consideration: administrative procurement 93/4,070; personnel/selection 7/87; professional councils 16/48; ATO DE PESSOAL 1/1. These are triage, not approved exclusions. V1 implements only the nine notices in `act-scope-01-initial-matrix.csv`, whose **global type counts sum to 3,827**. That is a ceiling before source, section, body, CNPJ, provenance and dependency guards. The remaining 108 first-pass types stay REVIEW. The observed ATO DE PESSOAL in DO1 remains visible.

No actual historical exclusion volume or storage saving has been proven. Do not present 3,827 or 4,206 as a SUPPRESS count. Production counts change with collection/backfill.

## Read-only historical planner

`npm run db:publication-exclusion-dry-run -- --dry-run` uses only the dedicated private configuration `PUBLICATION_EXCLUSION_DRY_RUN_DATABASE_URL` (no generic URL fallback). It requires session read-only plus `REPEATABLE READ READ ONLY`, an unfiltered authorized role, and ends in ROLLBACK. All execution flags are rejected. No SUPPRESS/apply runner is implemented by this change.

The planner reuses the existing DOU provenance gate, reevaluates every supplied version/origin, and binds a deterministic candidate digest to the policy hash and evidence. It reports aggregate source/type/group counts and digests, without document bodies or credentials. Cross-source records, missing inventories, persisted KEEP/REVIEW, dependencies, multiple versions without immutable historical titles and unexamined presentations remain REVIEW. Complete parser envelopes may omit `scopeStructureIncomplete` when false; true is always a veto. Historical SANITIZED_HTML remains unexamined and vetoes candidacy. A zero-candidate dry-run is valid, not permission to weaken these guards.

This runner has been tested with controlled fixtures/simulated read-only clients, not executed against production PostgreSQL. SQL catalog privileges and current schema/role behavior still require the separately authorized preflight.

## Auditing, retries and changes to the list

The engine keeps `found` as connector output, `processed` as persisted work and `skippedByPolicy` separate from errors. Bounded counters identify source, normalized act_type, rule, policy key and version in attempt metadata/logs. A run with only valid skips succeeds; collection failures and malformed items retain their existing failure behavior. The attempt metadata update verifies run ownership; failure cannot silently terminalize the run as successful. Existing checkpoints and publication hashes are unchanged.

Adding/removing an exception means editing this one policy module, bumping its version and reviewing tests/manifest impact. DOU receipts prove unchanged ZIP bytes, not application of a different policy: removing an exception does not automatically replay previously skipped unchanged packages. Reprocessing and restoring historical visibility require their own explicit reviewed procedure. Raw-body historical exports must not be placed in public repository artifacts.

## Network, facets and future production gate

V1 reduces canonical persistence when EXCLUDE is proven; it does **not** claim network savings. DOU must download and parse a ZIP to learn act_type/body/supplements. These rules cannot safely skip body/attachment fetching using the title alone. DO2/DO2E remain separately excluded before download by the existing collector.

No frontend masking is added. Historical SUPPRESS would use the existing scope ledger/feed/RLS/epoch so facets naturally omit types with no visible publication; a type may correctly remain via another source or KEEP/REVIEW item. Refresh the authenticated panel after a future operation because its aggregate cache can last 30 minutes.

Before any production SUPPRESS: approve the complete candidate set and policy version, independently review exact SHA, obtain the R3 lock/authorization, revalidate drift and writer coordination, take/restore a fresh backup, pin manifest/counts, use the existing logical transition infrastructure with an explicitly reviewed executor, and verify KEEP/REVIEW plus API/UI. Never DELETE or disable append-only evidence. Removing a list entry and restoring an existing scope event are distinct operations.

## Validation

`npm test` includes all four new policy/history/CLI/engine suites; existing CI runs that command. Tests cover exact normalization, source scope, unknowns, protected types, CNPJ/supplements/media, array/spool pre-persistence behavior, audit ownership failure, replay, deterministic manifests and refusal of mutating flags. Typecheck/build and existing DOU/backfill regression tests are required. No database migration is introduced.

Local verification on 2026-10-06: `npm test` passed 645/645 with no skips; typecheck and build passed. Independent adversarial review rechecked the parser/normalizer/policy boundary, conflicting source/origin evidence, unexamined XML fields and HTML controls/media. Unknown nontext elements and content-bearing attributes fail open. Independent historical-runner review also verified read-only guards and deterministic summaries under provenance permutations. The initial fixture failure came from altered CRLF/trailing bytes in the reconstructed checkout; 18 fixtures were restored to exact base bytes and their expected hashes were not changed. Fixture files are not part of this change.

Remote CI, PostgreSQL integration gates, production dry-run and deployment have not run. GitHub write calls did not return success; the branch/Issue/PR have not been published. Do not treat local unit results or this document as R2/R3 approval. The dedicated production dry-run connection is not configured in this local environment.
