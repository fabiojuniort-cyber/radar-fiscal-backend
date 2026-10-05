# Worker concurrency — NCM and classification

Governance: tribusca-control Issue #74.

The main collection claim already uses transactional row locking with SKIP LOCKED and the DOU backfill creation is serialized under the existing table lock. WORKER-CONC-01 does not replace either mechanism.

NCM enrichment and taxonomy classification may be selected concurrently by two Worker replicas. Persistence is idempotent, but two correctness guards are required:

- a late NCM failure cannot downgrade an existing SUCCESS scan;
- definitive taxonomy classification only becomes eligible after the matching NCM detector/version has a SUCCESS scan.

On-demand preview may still inspect an act without a successful NCM scan, but persisted single-publication classification fails closed with NCM_SCAN_NOT_SUCCESS until NCM succeeds. Tests cover failed-NCM blocking, recovery, and success-seal monotonicity.

Whether a claim/lease is justified purely to reduce duplicate CPU work remains a measurement question. Do not add a queue/migration solely from the theoretical race.

## Deterministic concurrency checks

`test/worker-concurrency.checks.ts` runs inside the dedicated TAX-11 integration gate, using its published release and official NCM catalog. Two independent pools authenticate as `radar_worker_runtime`; their PostgreSQL backend PIDs must differ. Test-only barriers hold both real selection results before either worker can persist the same version. Six scenarios cover NCM and classification with simultaneous success, success before failure, and failure before success.

The assertions measure two work reads for one selected version, one physical NCM mention, one classification run/assertion/span, successful NCM recovery before an NCM-derived tag, and classification `attempt_count`. Two successes or failure then success record two attempts; a failure arriving after SUCCESS leaves the seal, timestamp, and attempt count unchanged. This measures redundant work in a forced overlap, not its production frequency or CPU cost; no claim/lease or migration is introduced.

`collection.run-lifecycle.integration.test.ts` revalidates the existing main claim with two pools, a start barrier, and a held row lock. `dou-backfill.integration.test.ts` checks concurrent backfill creation, refusal while another run is open, and the existing post-completion throttle.

## Backfill retry versus stale recovery

The characterization at PR #149 head `2c74a314810c7ceddddb60f9432c853f51d26f74` passed the Collection persistence integration step of CI #859. It reproduced a real retry after an INLABS 503: heartbeat interval 100 ms, stale threshold 1 s, and retry wait approximately 20 s. During that wait, the engine's per-attempt heartbeat had stopped and `reclaimRun` had erased `next_attempt_at`; another pool could take ownership and the original owner failed before its second attempt. The default stale threshold of 120 s did not reproduce that gap.

The correction preserves the existing `next_attempt_at` when the backfill reclaims ownership. The existing stale claim requires both the heartbeat/lock fallback and any retry deadline to be older than `staleAfterMs`: equivalently, the later of the two timestamps must be stale. Checking only whether the deadline is due would leave a takeover window between the wake-up and the next periodic heartbeat. The full stale grace after that deadline gives the owner time to resume, and the backfill renews its heartbeat immediately after `sleep`, before starting the next attempt. If ownership has already changed, that renewal fails and the old owner stops before making another request.

No lock, throttle, queue, migration, pool configuration, or infrastructure is replaced. Unowned scheduled retries retain their existing eligibility. An abandoned owner remains recoverable after both its heartbeat and retry deadline have exceeded the stale window; the deadline does not reserve the run indefinitely.

The characterization is now a regression: neither the default nor a 1 s stale threshold may take the owned run before its retry deadline or 100 ms after it. The original owner renews and completes attempt two. Periodic heartbeats are disabled only for this fixture so they cannot mask a missing immediate renewal. A separate abandoned-owner fixture is refused inside the grace and recovered after `deadline + staleAfterMs`. Fixture timestamps and a scoped `Date.now` mock make the boundary checks deterministic without real waiting; the mock is restored in `finally`, and PostgreSQL time and `new Date()` heartbeats remain real. Validation of this corrected head must be read from its own CI result; the earlier characterization PASS proves the defect, not the correction or production behavior.
