# Worker concurrency — NCM and classification

Governance: tribusca-control Issue #74.

The main collection claim already uses transactional row locking with SKIP LOCKED and the DOU backfill creation is serialized under the existing table lock. WORKER-CONC-01 does not replace either mechanism.

NCM enrichment and taxonomy classification may be selected concurrently by two Worker replicas. Persistence is idempotent, but two correctness guards are required:

- a late NCM failure cannot downgrade an existing SUCCESS scan;
- definitive taxonomy classification only becomes eligible after the matching NCM detector/version has a SUCCESS scan.

On-demand preview may still inspect an act without a successful NCM scan, but persisted single-publication classification fails closed with NCM_SCAN_NOT_SUCCESS until NCM succeeds. Tests cover failed-NCM blocking, recovery, and success-seal monotonicity.

Whether a claim/lease is justified purely to reduce duplicate CPU work remains a measurement question. Do not add a queue/migration solely from the theoretical race.
