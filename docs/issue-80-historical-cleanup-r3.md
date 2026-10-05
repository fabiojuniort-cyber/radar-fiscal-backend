# Issue #80 / D-066 — historical cleanup R3 preparation

Status: **offline candidate planner only; destructive R3 is NOT implemented or approved.**
Nothing in this package connects to a database, changes rows, deletes objects,
pauses services, obtains a LOCK, or proves a deploy/backup/restore occurred.
The local snapshot does not include `migrations/`; generated TypeScript types
cannot establish live FK actions, triggers, RLS, views, or dependency closure.

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

DO2/DO2E candidates do not need a routine-text proof, but provenance conflicts
still block them. All other enabled act families are retained.

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

## Dependency inventory to verify against real DDL

| Root | Known logical dependencies in the local generated types |
| --- | --- |
| `publications` | `publication_origins`, `publication_versions`, `collection_items`, `collection_run_publications`, `company_publications`, `publication_source_feed` |
| `publication_versions` | `publication_files`, `collection_run_publications.publication_version_id`, `publication_taxonomy_runs` |
| `company_publications` | `publication_matches` |
| `publication_taxonomy_runs` | `publication_taxonomy_assertions`, `taxonomy_unmapped_occurrences`, superseding runs |
| `publication_taxonomy_assertions` | `publication_taxonomy_spans`, `publication_taxonomy_reviews`, superseding assertions |
| `taxonomy_unmapped_occurrences` | `taxonomy_candidate_occurrence_links` and shared candidate relationships |

Never infer a cascade policy from this table. Candidates, taxonomy/curation and
company matches can be shared/user-relevant and require explicit retention or
review. `publication_source_feed` may be table/view/trigger-maintained; verify.
Inventory audit-log entity/JSON references and external object
provider/bucket/key/hash references as well. Do not delete audit evidence.

Collection runs, attempts, checkpoints, archive receipts and operational status
are not deletion targets of this planner. If removal/scrubbing of any such
historical metadata is required, design a separate, explicit reviewed action;
do not remove mixed-section runs or pretend telemetry is covered by publication
counts. Coverage policy must ignore excluded sections independently of whether
old receipt hints remain stored.
