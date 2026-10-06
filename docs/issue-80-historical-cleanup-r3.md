# Issue #80 / D-066 — historical cleanup R3 preparation

Status: **offline candidate planner only; destructive R3 is NOT implemented or approved.**
Nothing in this package connects to a database, changes rows, deletes objects,
pauses services, obtains a LOCK, or proves a deploy/backup/restore occurred.
Schema source was subsequently audited through GitHub migrations 001–032 at
`68a2b2ab01560db2df846bf8d1e634e08ab82ccd`. Relevant findings appear below.
This proves repository DDL, **not** installed production migrations, drift,
runtime permissions, or live dependency closure. The local execution snapshot
still does not contain those migrations or a database restoration.

## Binding policy

- DO2/DO2E are out of collection/backfill/coverage scope. Historical cleanup
  candidates require exact DOU provenance in every supplied origin and version.
  This section policy takes precedence over act type, CNPJ, and contract category.
- For enabled sections, only explicit `EXTRATO DE CONTRATO` with strict,
  unanimous `CONTRATACAO_ADMINISTRATIVA_ROTINEIRA / IGNORE` proof can become a
  provisional candidate. The classifier is imported unchanged and versioned.
- `TRIBUTARIO_FISCAL`, `REGULATORIO_CONCESSAO`, and `EMPRESARIAL_RELEVANTE`
  remain KEEP. Ambiguous, incomplete or conflicting evidence remains REVIEW.
- CNPJ by itself does not authorize removing a contract excerpt. Other act
  families remain KEEP in enabled sections, regardless of CNPJ.
- Cross-source publications, mixed included/excluded sections, missing origins,
  inconsistent provenance, and missing/invalid version inventories are REVIEW.
  The planner does not propose detaching individual origins from shared records.
- In enabled sections, persisted KEEP/REVIEW annotations are safety vetoes;
  persisted IGNORE is never sufficient evidence. Contradictory canonical act
  types and supplied archive filename/section/date evidence fail closed.
- Planner `dou-cleanup-candidates-v2` requires mutually consistent source date,
  section, edition and official matter ID; ZIP date/name/hash; every XML part's
  date, matter ID, edition, type, section, filename and hash; and the exact origin
  `external_id`. Parts must be unique and contiguous. A historical version must
  map to a supplied origin identity with the same filename/hash part inventory.
  Missing or contradictory proof is REVIEW,
  even when a coarse `dou.section` alone says DO2. Supplied download/certified
  URLs, row-level official URLs and the certified-page inventory are cross-checked
  against the XML part pages too. No undocumented journal-number-to-section map is
  invented; a real DO1E/603 fixture exercises the source's edition semantics.

## Safe local use

Run from the repository root using a separately prepared **offline JSON export**:

```sh
node --import tsx src/infrastructure/database/dou-historical-cleanup.ts --input=/absolute/path/snapshot.json
node --import tsx --test --test-isolation=none test/dou-historical-cleanup.unit.test.ts test/dou-scope.rules.unit.test.ts
npm run typecheck
```

`--dry-run` is optional; it is the only mode. `--execute`, `--confirm`, `--apply`,
`--delete`, unknown options, and ambiguous input arguments are rejected.
The CLI does not read environment credentials or import a database client.
It prints a JSON candidate report to stdout, not document bodies/metadata.
It emits only a generic failure on malformed input so parser errors cannot echo
source content or credentials.

The input schema is `DouCleanupSnapshot` in
`src/modules/collection/dou-historical-cleanup.plan.ts`: UTC capture timestamp,
non-secret database label, exact source identity (`code=connector_key=dou`), and
publications nested with **all** their origins and **all** versions. Use native
snake_case row fields. Preserve additional raw columns verbatim; fingerprints
include all supplied JSON, including metadata and fields not used by classifiers.
Duplicate row IDs, malformed row shapes, supplied conflicting parent IDs, and
invalid/duplicate supplied version numbers abort the whole report.

Do not manually change evidence to obtain a candidate. No export implementation
or source XML replay proof is supplied by this package. Missing publications,
columns, dependent rows or historical material cannot be recovered or proved
complete from a JSON document; the report always exposes that blocker.

## Why candidates are NOT exact deletion targets

The output always has `executionAllowed=false`. It carries snapshot/record/plan
SHA-256 values, exact IDs **within the supplied snapshot**, reason codes, and
counts for CANDIDATE/KEEP/REVIEW. These are audit aids, not approval tokens.
A different input, identity, body, metadata, or supplied extra field changes the
fingerprint. No hash proves authenticity or completeness of the export.

Historical body classification uses every version against every available
metadata envelope. In particular, origin-only abstract updates and material
continuations veto routine classification. `content_hash` alone is insufficient:
the normalizer does not include all DOU abstracts/continuations in that hash,
and origin metadata can be overwritten on re-observation.

Versions do not store an independent title, while `publications.title` is mutable.
Routine multiversion records are therefore REVIEW until historical title/body
identity can be reconstructed. A historical KEEP body still causes KEEP.

Routine proof additionally requires complete-shaped supplementary arrays,
explicit `scopeStructureIncomplete=false`, contract source types, and archive/
part hashes. The current parser normally omits the flag when false: those
ordinary legacy rows intentionally remain REVIEW. **Absence is not proof of
complete capture.** Do not fabricate the flag; source-level reconstruction and
its independent verification are future work. Even a provisional candidate
still requires title/capture authenticity and completeness verification before
any future executor may act.

Additional file inventories in metadata or supplied publication/version rows
block routine candidacy until their material content is examined. A PROVENANCE
label alone does not waive this check. Those attachments do not change the
separate DO2/DO2E section-exclusion policy.

DO2/DO2E candidates do not need a routine-text proof, but provenance conflicts
still block them. All other enabled act families are retained.

## In-database READ ONLY dry run (2026-10-06)

Production rows must not leave Railway, so the offline snapshot CLI above is
not used against production. `npm run db:dou-cleanup-dry-run` runs **inside a
Railway service** with `DOU_CLEANUP_DRY_RUN_DATABASE_URL` (private reference to
an unfiltered role, never printed):

- the session is forced `default_transaction_read_only=on`; everything runs in
  ONE `REPEATABLE READ READ ONLY` transaction (consistent snapshot) and always
  ends in `ROLLBACK`;
- DOU publications (any origin in the `dou` source) are streamed in UUID key
  order in batches of 500 with all their origins/versions; each batch goes
  through the unchanged `planDouHistoricalCleanup`;
- stdout carries only `DOU_CLEANUP_DRY_RUN={...}`: totals per disposition,
  publications per decisive reason (`byReason`), candidates per DOU section,
  `candidateSetSha256` (sorted `publicationId:evidenceSha256:reasons` lines)
  and `runSha256`. No identifier, title, text or connection detail;
- errors print a fixed label only; `--apply/--execute/--confirm/--delete/
  --suppress` are refused. There is no write branch.

`candidateSetSha256` is the anchor for the future executor: it must re-derive
the set from the database and refuse to suppress anything unless the digest
equals the approved dry run (any ingestion or metadata change in between
invalidates the approval). Batch size does not change it (integration test).

Since DOU-CLEAN-02 the executor target is SUPPRESS via
`apply_publication_scope_transition` (no DELETE); the runner proven by the
production canary (tribusca-control#84) is the template.

## Gated executor — SUPPRESS/RESTORE, no DELETE (2026-10-06)

`DOU_CLEANUP_MODE=verify|apply|restore npm run db:dou-cleanup-execute`, run in
the same one-shot Railway service as the dry run, with:

| variable | contract |
|---|---|
| `DOU_CLEANUP_DATABASE_URL` | private reference to an unfiltered role; never printed |
| `DOU_CLEANUP_APPROVED_CANDIDATE_SET_SHA256` / `_COUNT` | exactly the approved dry run |
| `DOU_CLEANUP_CONFIRM` | `SUPPRESS_APPROVED_DOU_CANDIDATES` (apply) or `RESTORE_APPROVED_DOU_CANDIDATES` (restore) |
| `R3_APPROVAL_SHA256` | required for `apply` |
| `DOU_CLEANUP_CHUNK_SIZE` | optional, default 200 per transaction |

Behaviour:

1. Every mode re-derives the candidate set in one `REPEATABLE READ READ ONLY`
   snapshot (same code as the dry run). `verify`/`apply` refuse unless digest
   AND count equal the approval, and refuse any candidate carrying a persisted
   `douScope` decision other than IGNORE.
2. `apply` calls `apply_publication_scope_transition(..., 'SUPPRESS', ...)` per
   candidate, in transactions of `CHUNK_SIZE`, with `lock_timeout` 5 s.
   Operation ids are deterministic (`sha256(purpose, manifest, publication)` as a
   UUID): a re-run after any interruption replays committed chunks
   (`applied=false`) and continues. `policy_key=DOU_CLEAN_01_HISTORICAL`,
   `reason_code=EXCLUDED_DOU_SECTION`, `manifest_sha256` = approved digest,
   `evidence_sha256` = the planner's per-publication evidence digest.
3. `verify` (read-only session) reports the state: suppressed by this policy and
   manifest, candidates still in scope, candidate feed rows, global
   OUT_OF_SCOPE and epoch. Suppression does not change the evidence, so the
   digest still matches after `apply`.
4. `restore` compensates only this manifest's current SUPPRESS events
   (optimistic lock on the event id); it does not depend on the set still
   matching. Afterwards the same manifest cannot silently re-suppress
   (`PUBLICATION_SCOPE_OPERATION_SUPERSEDED`): a new approval is required.
5. Errors print fixed labels or the `PUBLICATION_SCOPE_*` token only.

Integration test on the real schema runs as the last CI step (scope events are
append-only and cannot be cleaned up).

### Production execution record (2026-10-06)

Executed on production at 12:18 UTC with commit `a1c21fc`, between the 12:00
DOU backfill tick (finished 12:11:21) and the 13:00 collection cycle.

| step | deployment | outcome |
|---|---|---|
| fresh backup + isolated restore (`EXPECT_SCOPE_TABLES=present`) | `dc7a9d48` | `SCOPE_BACKUP_RESTORE_PASS`, `allPublicTableCountsEqual=true`, dump `fbdb31fb…` (455 MB) |
| `verify` (pre) | `c43856e0` | `DOU_CLEANUP_VERIFY_PASS` |
| `apply` | `e334dce2` | `DOU_CLEANUP_APPLY_PASS`, `applied=23024`, `replayed=0` |
| `verify` (post) | `6a9caba2` | `DOU_CLEANUP_VERIFY_PASS`, `applied=0`, `replayed=0` |

The approval gate was exercised for real: the backfill inserted 2,733 new
publications between the pre-`verify` and the `apply`, moving the inspected
universe from 111,242 to 113,975 (KEEP 78,692 -> 81,063, REVIEW 9,526 -> 9,888),
while `candidateSetSha256` stayed `0e18e37a…` at 23,024 candidates (DO2 23,002 +
DO2E 22). A set that had drifted by one act would have been refused with
`CANDIDATE_SET_DIFFERS_FROM_APPROVED_DRY_RUN` before any write.

Post-state, confirmed independently by the following `verify`:
`outOfScopeByThisPolicy=23024`, `inScopeCandidates=0`, `candidateFeedRows=0`,
`outOfScopeGlobal=23024`, scope epoch `2 -> 23026`. Nothing was deleted:
publications, versions, origins, taxonomy, NCM and telemetry are untouched, and
the 23,024 carry zero company links, matches, taxonomy runs or NCM mentions.
Zero `strict_routine_contract_excerpt` candidates, so no EXTRATO DE CONTRATO was
suppressed. Both one-shot services were disarmed afterwards
(`DOU_CLEANUP_MODE=disarmed`, runner back to `postdeploy-smoke.sh`/`preflight`).

NOT_PROVEN: the authenticated visual check of the Acervo UI. The database proof
is complete and the #84 canary already proved RLS end to end, but no one has yet
opened the product and confirmed the v2 total dropping from ~94.6k to ~71.5k.

## Required execution gates — future separately reviewed work

1. Record the Issue80 governance LOCK: owner, scope, expiry, exact code SHA,
   authorized operators, approvers and rollback window. This is distinct from
   database locks. No cleanup authority is inferred from credentials.
2. Verify the fixed collector/backfill/replay policy deployed to **every**
   worker/scheduler/admin execution path and replica; prevent old code or an
   in-flight run from reintroducing records. Retain observed deployment evidence.
3. Inventory the actual database schema, migration checksums, FK actions,
   trigger/view definitions, and non-FK references. Unknown dependencies or
   schema drift abort the operation. Freeze writers consistently, including
   scheduler, backfill, taxonomy and matching; drain or explicitly account for
   PENDING/RUNNING runs. `FOR UPDATE sources` alone is not the acquisition
   protocol used by all existing workers.
4. Take a consistent backup covering schema, data and referenced external
   objects. Record hashes, location, retention and recovery permissions. Restore
   into a **temporary isolated database/environment**, verify full relationships,
   current versions, objects and representative reads. Record successful restore
   results **before** proposing any production deletion.
5. Reconstruct missing historical title/text/supplementary evidence as needed.
   Preserve KEEP/REVIEW and all cross-source/shared dependencies. Obtain an
   exact, separately reviewed action list for every affected row/object.
6. Under the same writer exclusion protocol, perform an exact transactional
   dry-run against the restored copy: validate approved IDs + full row hashes +
   dependency closure, execute the proposed actions, verify postconditions,
   and roll back. Capture per-table before/after/delta counts and IDs. Changed
   rows, new dependencies, stale fingerprints or count mismatches must abort.
7. Independently review the exact manifest, deployment proof, restore test,
   rollback procedure and dry-run evidence. A future approved executor must
   revalidate these under lock immediately before an explicit commit.
8. Post-execution checks must show no changes to KEEP/REVIEW/out-of-scope data,
   exactly the approved removed records, referential integrity, and no re-entry.
   Keep the audit manifest and tested recovery path. Rolling back code does not
   restore deleted data.

Do not conflate this offline report with step 6, a production dry-run, a restore
test, an approval, or completion of R3.

## DDL audit and consequences for physical deletion

Repository:
[radar-fiscal-backend at 68a2b2a](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/tree/68a2b2ab01560db2df846bf8d1e634e08ab82ccd/migrations).
The complete relevant definitions were inspected, including 004, 005, 006,
009, 020, 021, 026, 028, 029, 030 and 031. Later migrations through 032 do not
remove the identified retention barriers.

| Migration | Verified behavior relevant to cleanup |
| --- | --- |
| `004_publications.sql` | Publications cascade to origins/versions and run-publication links; versions cascade to files. `collection_items.publication_id` and run-link `publication_version_id` use default NO ACTION, not explicit RESTRICT. |
| `005_monitoring_and_matching.sql` | Publications cascade to company-publication records, which cascade to matches. Deleting the root can erase tenant review/matching history. |
| `006_audit.sql`, `009_rls_policies.sql` | Audit entity IDs/JSON are logical references, not publication FKs. Runtime audit access is SELECT/INSERT; publication workers have table-level UPDATE, which matters when introducing a mutable scope field. |
| `020_taxonomy_classification.sql` | Taxonomy runs reference versions with RESTRICT. Assertions, spans and reviews have RESTRICT dependencies and BEFORE UPDATE/DELETE append-only guards. Run material identity cannot be rewritten. |
| `021_taxonomy_candidates.sql` | Unmapped occurrences reference runs with RESTRICT and are append-only. Candidate-occurrence links have RESTRICT references and a guard rejecting DELETE. |
| `026_company_product_ncm.sql` | NCM mentions reference versions with RESTRICT. Worker grants are SELECT/INSERT; this migration does not give mentions an append-only trigger. |
| `028_publication_ncm_scans.sql` | Derived NCM scans have a version FK with CASCADE. Do not confuse these with the separate taxonomy scan table. |
| `029_catalog_scale.sql` | `is_hidden` is GENERATED ALWAYS from title/type. Feed is a real table without publication FK, maintained by expected/refresh functions and origin/publication/source triggers; publication DELETE removes feed rows. |
| `030_archive_act_type_scale.sql` | The act-type catalog is append-only derived vocabulary; facets validate live visibility. It is not a deletion ledger or archive of publication evidence. |
| `031_taxonomy_curation.sql` | Taxonomy scans have no version FK but have a run FK (default NO ACTION). Curator tags have no version FK and do have an append-only UPDATE/DELETE guard. |

**Conclusion:** a blanket physical `DELETE publications` is not compatible with
preserving this audit/evidence graph. Some rows block deletion; other branches
cascade away and destroy collection or tenant history; FK-free references may
remain dangling. Copy-then-delete and child-first deletion do not avoid
append-only guards. Do not disable triggers, weaken RESTRICT/NO ACTION to
CASCADE, truncate evidence tables, or null out relationships as a cleanup trick.
An isolated record without these dependencies may have different mechanics, but
that does not authorize a general purge or prove evidence retention.

The previous logical dependency inventory remains a minimum export checklist:

| Root | Known logical dependencies in the local generated types |
| --- | --- |
| `publications` | `publication_origins`, `publication_versions`, `collection_items`, `collection_run_publications`, `company_publications`, `publication_source_feed` |
| `publication_versions` | `publication_files`, `collection_run_publications.publication_version_id`, `publication_taxonomy_runs` |
| `company_publications` | `publication_matches` |
| `publication_taxonomy_runs` | `publication_taxonomy_assertions`, `taxonomy_unmapped_occurrences`, superseding runs |
| `publication_taxonomy_assertions` | `publication_taxonomy_spans`, `publication_taxonomy_reviews`, superseding assertions |
| `taxonomy_unmapped_occurrences` | `taxonomy_candidate_occurrence_links` and shared candidate relationships |

Never infer a live cascade policy from generated types or this checklist.
Candidates, taxonomy/curation and company matches can be shared/user-relevant
and require explicit retention or review. Verify installed feed triggers/DDL.
Inventory audit-log entity/JSON references and external object
provider/bucket/key/hash references as well. Do not delete audit evidence.

Collection runs, attempts, checkpoints, archive receipts and operational status
are not deletion targets of this planner. If removal/scrubbing of any such
historical metadata is required, design a separate, explicit reviewed action;
do not remove mixed-section runs or pretend telemetry is covered by publication
counts. Coverage policy must ignore excluded sections independently of whether
old receipt hints remain stored.

## Proposed next step — reversible scope suppression, subject to approval

This is a **proposal**, not a migration or executor implemented by this PR.
It removes records from active product use while retaining all historical bytes
and identities. It does **not** satisfy a literal requirement to erase stored
history or release its disk space. Product/governance must explicitly choose
this retention contract, or authorize a separate physical-archive design.

### Migration A: independent scope state and immutable decision events

- Create `publication_scope_events`: immutable event ID, publication FK with
  RESTRICT, SUPPRESS/RESTORE action, prior/new scope, reason, rule/code versions,
  manifest/evidence hashes, operator/approval references, operation ID and time.
  Enforce unique `(operation_id, publication_id)`, valid transitions, and
  append-only guards. A restore adds an event, never removes the original.
- Create `publication_scope_state`: one row per decided publication, publication
  PK/FK with RESTRICT, `IN_SCOPE`/`OUT_OF_SCOPE`, current event FK, policy key,
  evidence hash and update time. Missing state means IN_SCOPE. KEEP and REVIEW
  are planner decisions and never authorize OUT_OF_SCOPE.
- Permit state/event writes only through a reviewed restricted procedure/role
  that verifies the expected current event and row hashes and writes both
  atomically under the publication's lock. Pin SECURITY DEFINER search paths,
  schema-qualify relations, revoke PUBLIC execute, and expose explicit admin
  evidence reads. Collector/app/ordinary worker must not receive generic
  suppression privileges. A separate state table avoids silently extending
  the worker's existing table-level UPDATE grant on `publications` to scope.
- If a denormalized `publications.catalog_scope_status` is chosen instead for
  measured performance, it needs the same event linkage plus narrowed table/
  column grants and a guarded projection update. Never reuse generated
  `is_hidden`, rewrite title/type to force it, or overwrite company review state.

### Migration B and application deployment: all consumers and derived state

- Define one shared in-scope predicate/repository contract, independent of the
  existing hidden-family predicate. Extend feed expected/refresh logic to omit
  OUT_OF_SCOPE and refresh on scope-state changes. Manual feed DELETE alone is
  temporary because its triggers reconstruct it from authoritative state.
- Update every product read: catalog, public lists/stats, facets/counts/caches,
  detail/direct-ID routes, company dashboards/matches, archive endpoints and
  taxonomy/curator-tag views. Audit/evidence administration has explicit access
  to suppressed records; operational history continues to report what actually
  happened and separates historical collected totals from currently visible ones.
- Update taxonomy, NCM and matching worker selections AND single-item execution/
  commit guards. A writer that selected work before suppression must recheck
  scope under the agreed lock before committing derived output. Do not mutate
  existing assertions/tags/matches to simulate suppression.
- Invalidate material evidence-bound contract decisions when title, type, body,
  version or origin/supplementary metadata changes. Revalidate under lock; a new
  KEEP/REVIEW must not inherit an old suppression. If revalidation cannot happen
  synchronously, reject that material write or append an audited RESTORE to
  IN_SCOPE pending review; do not leave new potentially relevant content hidden.
  Pure last-seen/operational timestamp updates need not invalidate scope proof.
  DO2 anti-reentry remains a collector policy, not a stale content verdict.
- Add indexes/updated types/permission verifiers and backfill only derived scope
  projections. Default all existing publications to IN_SCOPE. Deploy and verify
  every consumer/writer before enabling the administrative executor.

### Future executor: SUPPRESS/RESTORE only

After the already-required LOCK, verified deploy, backup and tested temporary
restore, a separately reviewed executor may recheck an approved manifest under
writer exclusion and transaction locks, then append events and update scope/feed
only. Its dry-run performs those exact operations in the restored environment
and ROLLBACKs; execution requires an explicit new approval and identical hashes.
It must not change originals, versions, files, taxonomy, tenant reviews, scan
evidence or operational telemetry. Postconditions compare their full hashes and
IDs, not just row counts. Test direct-ID/cache leaks, in-flight workers, stale
evidence, replay idempotence, mixed-source records, and RESTORE round trips.

RESTORE is the logical rollback, represented by a compensating event and rebuilt
feed. A code rollback to readers unaware of scope would re-expose suppressed
records; include compatible rollback builds in deployment governance.

### If physical history removal is still mandatory

Open a separate, approved evidence-retention/archive design before an executor.
It must define which complete connected graphs and blobs are copied, immutable
checksummed archive manifests and restore/read access, durable identity/tombstone
anchors for remaining references, and explicit migrations adapting every FK,
append-only evidence contract, non-FK reference and reader. Shared taxonomy/
company evidence cannot be moved as if it belongs solely to one publication.
Changing immutable relationships is a governance migration, not an admin flag.
Until that design is approved and restored successfully in isolation, physical
purge remains blocked. Logical suppression offers no claim of storage savings.
