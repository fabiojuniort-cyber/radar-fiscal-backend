# F3 read-only type simulation

Scope: existing publications with a DOU or DOE-SP origin. This command neither captures new publications nor applies a purge. It does not import the collection runtime (which can clean discard records), call privileged policy functions, run migrations, change policy rules, or write database rows.

## Frozen comparison

`ops/f3/ccfaa15.baseline-engine.ts.txt` is the original engine from backend commit `ccfaa15cffd322bb364c99f44eb04f759b781d1e`, tree `efef43653685de26636f2bd6e3d568d3b24bbe82`. `ccfaa15.baseline-engine.mjs` is that source with types erased by Node 24 `stripTypeScriptTypes`; there are no business logic changes. Source/module SHA256 and tool version are in `ccfaa15.baseline-provenance.json`. Reproduce with `node ops/f3/freeze-baseline.mjs`. The simulation verifies the module digest before loading it. CI tests exercise the original #215 conflict outcome and new Pompeia outcome independently.

The OLD column runs that exact engine on stored `act_type` and official metadata, with its exact old conflict check and raw saved section. DOE-SP's old policy baseline is KEEP because the generic policy was not enforced there. Its connector-specific capture selection is not replayed. Both columns evaluate TITLE/BODY only, matching capture and F3 historical adapters; stored relevant excerpts are not used as a separate SUMMARY. Both columns evaluate the same archived body/material evidence; they are not historical proof of what a past worker actually did. Missing/deleted/discarded publications cannot be reconstructed from this snapshot.

The NEW column uses the F3 engine with official and initial-title types. Contradictory origin/current-version metadata or missing/multiple current versions prevent destructive eligibility. An additional origin of any source is conservatively protected even when it might itself be excluded. A company match is protected regardless of status. Publications are counted once, never once per origin.

## Temporary Railway service

Build: `npm ci && npm run build`.

Start: `node dist/infrastructure/database/f3-type-simulation.js`.

Optional temporary artifact: append `--output /tmp/f3-type-simulation.json`. The file must not already exist; it contains only public publication metadata and aggregated policy data. No full legal body, excerpt, company identity, tenant ID, official URL, or database secret is emitted. The sanitized report is emitted as bounded JSON records in logs: `F3_SIMULATION_SUMMARY=`, `F3_SIMULATION_SAMPLE=`, `F3_SIMULATION_UNKNOWN=`, `F3_SIMULATION_POMPEIA_STATUS=`, `F3_SIMULATION_POMPEIA=` and `F3_SIMULATION_REDUNDANCY=` (one candidate pair per line). Bounded records avoid per-line log truncation. Archive all those records/artifact before neutralizing the temporary service.

Configure only `F3_SIMULATION_DATABASE_URL` as a private database reference. Do not print it. No `DATABASE_URL`, worker/scheduler start, predeploy command, migration, automatic redeploy, source import or backfill is needed. Use restart policy NEVER, no cron, no healthcheck and no shared production service override. This temporary service must use an unfiltered database role (superuser or BYPASSRLS) to ensure company-match guards cannot silently miss rows; the role is made read-only from connection startup via `default_transaction_read_only=on`. The transaction is `REPEATABLE READ READ ONLY`. A static keyset SELECT reads 500 publications at a time and every relevant origin in the same snapshot. The command ends with ROLLBACK.

After gathering evidence: stop/remove the deployment, preserve restart policy NEVER, remove the database-reference credential and any other credentials from the temporary service. Verify no running instance/restart/cron remains. A successful simulation is not authorization to merge or delete; obtain Fábio's OK on the actual results before merge. Retroactive deletion remains prohibited in this stage.

## Required output

- Snapshot time and identifier; approved policy ID/version/revision/document SHA256, engine SHA256 and exact frozen provenance.
- Dedicated Pompeia evidence for publication `65411060-690d-46ac-8153-ce51562ea1f4`: found/not found; source, raw origin/current-version sections and official types, initial-title type, OLD decision/reason and NEW decision/reason, winning saved rule ID/type/mode/creation timestamp, policy creation timestamp, protections and provenance conflict. Capture timestamps explicitly come from `publication_versions.captured_at` (first version and current version); `publications.first_collected_at` is separately reported. Rule creation later than first capture is reported when dates are available, but is not proof of the last mode edit or the historical worker decision. A raw normalized section mismatch (e.g. saved DO3E versus DO3) conservatively blocks eligibility even though inheritance governs rule matching.
- Unique publication counts: kept, eligible (policy DISCARD and no company/additional origin), protected (policy DISCARD but company/additional origin).
- Up to ten actual public metadata examples of each bucket, including both types, before/after decision, source/section and protection reason. Fewer are returned if the bucket has fewer than ten records; never fabricate examples.
- DO1/DO3 old type conflicts: unique publications; old/new KEEP/DISCARD totals and transitions. Extra sections are grouped under their principal for reporting; the OLD engine still receives the raw section.
- Top twenty unmatched official/title normalized types, counts by distinct publication, separated by input role, source and section. Blank inputs are not classified as a type.
- Rule normalization collisions and prefix variants (BF, CE, PE SRP, etc.) listed for review only. No redundancy is deleted, merged or assigned a new mode.

Accept only a PASS with a read-only unfiltered snapshot, no database writes/deletions, explainable Pompeia outcome and all required counts/examples. An approved-policy collision is an activation blocker, not permission to rewrite the rules during simulation. Investigate failures without emitting raw pg exceptions because those can expose connection details.
