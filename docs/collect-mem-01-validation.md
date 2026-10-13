# COLLECT-MEM-01: local implementation and validation

Date: 2026-10-05. Logically rebased against exact main commit
`5351a70e46bd9abed17efb4db9790961f36e1c59` after the initial PR148/PR149 snapshot.
No GitHub writes, live INLABS requests, database writes, pool tuning or infrastructure changes.

All 19 initial patch paths were compared read-only against that exact GitHub
commit. Seven new paths were confirmed absent. Existing main changes were
preserved, including the PR149 retry-deadline stale grace and the
`taxonomy:retire-legacy-segments` package script. Exact remote originals are
retained locally for diff review; the upload must use the named commit as base,
not replace the repository with this partial snapshot.
The added backfill integration regression is the twentieth changed path; its
existing contents also matched the same main commit byte-for-byte before editing.

## Collection boundary and compatibility

- `DouConnector.collect()` remains the array compatibility API.
- The executor opts into `collectIncremental()`, whose sink awaits a write of
  each **complete** publication to an attempt-private, single-file spool.
- ZIP validation and multipart assembly finish before an archive emits items.
  All packages finish collecting before the spool seals and the executor
  reports success. The engine only then replays/persists sequentially.
- A late archive/source failure, sink failure, timeout or cancellation discards
  staging; it cannot expose publications or receipts as a successful result.
- The engine keeps its existing normalization, dedupe/versioning and per-item
  transactions. Counts in attempt metadata and run status include the spool.
- Temporary cleanup precedes successful terminal run status. Corrupt/truncated
  replay or cleanup failure produces `PROCESSING_FAILED`, never successful
  receipt eligibility. Cleanup waits at most 1s per caller, then fails closed
  while unfinished temporary I/O can settle and clean up independently.

The spool preserves top-level Dates, full content/presentation HTML and
explicit undefined fields. A per-record SHA-256 protects replay integrity.
There are no per-run publication arrays or unbounded pending write queues.
The spool is 0600 inside a private 0700 temporary directory, capped at 8GiB
total and 512MiB per record. Paths and source bodies never enter spool errors.

## Memory changes and invariants

- No compressed ZIP copy at the parser boundary (correctly honors view offsets).
- One bounded decompressed XML buffer at a time, instead of chunks plus copy.
- Parsed multipart groups retain hashes/sizes, not original raw XML buffers or
  `highlightImage` payloads. Completed retained SAX fields/attributes are copied
  after concatenation and after dropping the image attribute, so small slices
  cannot retain the full decoded XML/base64 backing string. UTF-16 copying
  preserves supplementary characters and individual code units without changing
  raw hashes. Group strings are released before awaited emission.
- Complete run content resides in a spool, not retained publication arrays.
- Process telemetry explicitly emits `rss`, `heapUsed`, `heapTotal`, `external`
  and `arrayBuffers`, plus fixed counters at collection/archive/replay
  phases. There is no in-memory sample history or source-content logging.
- The new `spool_ready` phase reports fixed filesystem/storage/probe labels and
  available bytes when valid. `statfs` is preferred; Linux mountinfo is a bounded
  fallback (64KiB, most-specific resolved mount). The entire advisory probe is
  limited to 100ms. Missing permissions, unsupported APIs, diagnostic timeouts
  and the new telemetry sink cannot fail collection. No paths, mount options,
  raw filesystem names or operating-system errors enter these samples.
- `tmpfs`/`ramfs` explicitly mean `memory_backed`. Overlay and unrecognized or
  ambiguous mounts stay `unknown`; a local ext/xfs/btrfs filesystem is labeled
  `local_filesystem`, **not** a guarantee of zero memory/cgroup charge. Disk page
  cache and tmpfs usage can affect container memory without appearing in Node
  heap/RSS. Operators must inspect `spool_ready` and cgroup/container metrics
  before claiming that spool bytes were moved outside the memory budget.
- Busy/throttled backfill checks now precede expensive coverage loading. The
  original authoritative transaction lock and identical rechecks remain.

Two existing lifecycle gaps were also closed without a migration:

- Backfill coverage now excludes any run with a `FAILED` publication collection
  item. `PARTIAL_SUCCESS` caused only by parser omissions stays eligible, but
  metadata recorded before a persistence failure cannot authorize skipping that
  run's packages. Replay/cleanup failures already terminate as `PROCESSING_FAILED`.
  The consecutive-failure counter uses the same persisted-item distinction:
  partial persistence failures count toward date rotation and `STALLED`, while
  a parser-only partial consultation still resets the counter.
- Attempt finalization locks and verifies the currently owned RUNNING run and
  RUNNING attempt, in the same lock order as recovery. It returns an explicit
  ownership result. The engine rejects a lost owner before replay, item writes,
  checkpoints, retries or terminal status changes, and disposes its spool.
  The barrier also applies to legacy buffered connectors.

Unchanged protections include 64MiB compressed ZIP, 128MiB expanded archive,
8MiB XML entry, 5000 entries, CRC, encryption/path/duplicate checks, DTD/depth,
source-context/certified-link checks and conservative broken-multipart handling.
Sections remain DO1, DO1E, DO3 and DO3E. Partial/unchanged package semantics,
embedded CONFAZ acts and conservative scope filtering retain their fixtures.

## Verification

```sh
npm run test:collection-memory
npm run typecheck
npm run build
```

The dedicated suite includes original DOU parser/connector/scope/backfill
tests and new spool/filesystem/executor/engine lifecycle tests. Filesystem
coverage includes memory filesystems, overlay/unknown, unavailable diagnostics,
bounded/stalled mount discovery, path matching, telemetry privacy and a failed
telemetry sink. All added unit test files are registered in `npm test` too.
The final local dedicated run passed **192/192 tests**, including
the original DOE-SP legacy suite (31), real-PDF regression suite (6), and
the bounded per-package benchmark trend suite (9).
`npm run typecheck` and `npm run build` also passed.
Earlier standalone focused runs passed backfill 16/16 and parser 22/22;
the consolidated count above supersedes previous partial-suite totals. The image-retention regression uses
deterministic copy/Unicode/hash assertions, without forced GC or heap thresholds.
Use `--test-isolation=none`
here: this sandbox blocks Node child processes; ordinary test-isolation could
misleadingly report only test files, without executing their assertions.

Production database integration suites were **not run**: no authorized
disposable database was provided. Many other suites listed by the original
`package.json` are absent from this snapshot, so a full `npm test` claim would
be invalid. No live retry/replay or deployment validation is claimed.

## Reproducible synthetic benchmark

```sh
npm run benchmark:collection-memory
```

The default runner spawns isolated child processes; if child spawning is
restricted, invoke each child directly, through the approved command runner:

```sh
for package_count in 1 4 8 16; do
  for benchmark_mode in array spool; do
    node --expose-gc --import tsx scripts/dou-memory-benchmark.ts --child "$benchmark_mode" "$package_count"
  done
done
```

Fixture parameters: 64 complete publications/package, 32768 Unicode characters
of body/publication, 1ms awaited slow sink/publication. Fixture preparation is
outside the measured interval; GC is only forced before measurement. Both
modes use the same current parser; `array` isolates whole-run content retention,
so it is not a pristine pre-patch parser comparison. The benchmark normalizes
each publication and compares an ordered SHA-256 digest across the two modes.

One local measurement, bytes (not MiB), of the initial implementation before
the later cleanup, ownership and SAX-detachment review fixes:

| Packages | Publications | Array peak heap | Spool peak heap | Array peak RSS | Spool peak RSS | Array ms | Spool ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 | 34361432 | 24190064 | 126390272 | 86044672 | 372 | 533 |
| 4 | 256 | 65609344 | 30774672 | 171909120 | 113119232 | 1139 | 1263 |
| 8 | 512 | 120590648 | 45499472 | 286502912 | 150118400 | 1886 | 2190 |
| 16 | 1024 | 169268168 | 70969296 | 358285312 | 227696640 | 3618 | 4270 |

All four digest pairs matched. At 16 packages the synthetic run reduced peak
heap 58.1% and RSS 36.4%, with an 18.0% elapsed-time cost and 73701376 spool
bytes. The JSON output also includes external/array-buffer peaks, initial memory
and (for spool mode) the filesystem observation, because heap alone does not
represent process residency. These are
single-run synthetic observations, not production capacity guarantees. V8 GC,
fixture compression and baseline external-memory reclamation affect peaks.

## Per-package memory trace and growth trend (review completion)

The harness now captures one `afterPackages` record for every `archive_parsed`
event, after ZIP parsing/multipart validation and the awaited publication sink
have completed. Each record has `packageIndex`, elapsed milliseconds, cumulative
publication/XML counts and `rss`, `heapUsed`, `heapTotal`, `external`,
`arrayBuffers` in bytes. The currently downloaded ZIP may still be in scope:
these are **post-parser/sink process snapshots, not post-GC retained-memory
measurements**. No GC is forced during collection.

Only `scripts/dou-memory-trend.ts` retains samples: **at most 16 per workload**.
The production memory probe remains stateless. Timer/other-phase events do not
enter the history; invalid/duplicate/out-of-order, excess or missing package
samples make the benchmark fail rather than silently truncate the evidence.
Workloads are explicitly restricted to 1/4/8/16; expected fixture counts are
checked after every package as well as against the final digest.

For each of the five memory metrics, `packageMemoryTrend.metrics` reports:

- `firstBytes` / `lastBytes`: samples after packages 1 and N.
- `deltaBytes = lastBytes - firstBytes`.
- `meanDeltaBytesPerPackage = deltaBytes / (N - 1)`.
- `leastSquaresSlopeBytesPerPackage`: ordinary least-squares slope of all N
  samples against package index, i.e. covariance numerator divided by the
  sum of squared centered package indices; unit **bytes/package**.

For N=1, both mean delta/package and OLS slope are `null` because there is no
observed interval; a zero delta for one sample is not evidence of flat growth.
Nine helper tests cover increasing/constant/decreasing and non-linear trends,
single-sample semantics, the 16-sample bound, invalid/incomplete sequences,
finite counters, overflow resistance and scalar-only independent snapshots.

### Final local matrix

One fresh process per mode/workload, with the default 64 publications/package,
32768 characters/publication and 1ms slow sink. All four digest pairs and all
58 per-package count snapshots matched between modes. Full ordered snapshots,
trends, peaks, duration, filesystem and hashes of the measured script/helper/
parser/connector are stored in
[`dou-memory-after-packages-20261005.json`](./dou-memory-after-packages-20261005.json).

| Packages | Publications | Array peak heap (bytes) | Spool peak heap (bytes) | Array peak RSS (bytes) | Spool peak RSS (bytes) | Array ms | Spool ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 | 32881992 | 24097184 | 127053824 | 85200896 | 345 | 365 |
| 4 | 256 | 66420576 | 31012192 | 172130304 | 110776320 | 1039 | 1222 |
| 8 | 512 | 118033528 | 46135128 | 279257088 | 157671424 | 1833 | 2254 |
| 16 | 1024 | 159987520 | 72355760 | 361623552 | 223522816 | 3600 | 4266 |

OLS slopes below are displayed as **MiB/package** (raw JSON remains bytes/package).
`—` means null, not zero. This describes observed growth during each finite run;
it is neither a leak detector nor a production capacity/plateau assertion.

| Packages | Mode | RSS | heapUsed | heapTotal | external | arrayBuffers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | array | — | — | — | — | — |
| 1 | spool | — | — | — | — | — |
| 4 | array | 18.552 | 5.647 | 17.550 | 0.145 | 0.145 |
| 4 | spool | 4.368 | -0.827 | 5.100 | -0.968 | -0.968 |
| 8 | array | 16.128 | 5.805 | 20.330 | 0.667 | 0.061 |
| 8 | spool | 6.343 | 1.800 | 6.595 | -0.294 | -0.294 |
| 16 | array | 11.146 | 5.621 | 9.483 | 3.187 | 2.902 |
| 16 | spool | 3.321 | 0.174 | 4.488 | 0.122 | 0.107 |

At 16 packages, first-to-last RSS delta was 180.828 MiB (array)
versus 62.895 MiB (spool); heap delta was
84.198 versus 26.737 MiB. The spool substantially reduced
growth in this run, **but RSS still grew and no flat-memory guarantee is made**.
Natural V8 collections make the samples saw-toothed, so the endpoint mean and
OLS can differ materially; a negative slope in a short run is not proof of
negative long-term retention. The spool filesystem was `overlay / unknown` for
all runs: filesystem page cache/cgroup memory is not captured by Node RSS alone.

## Remaining scope and known risks

- Parsed multipart groups still live for one bounded archive, until all ZIP
  entries and continuations have been verified. No entry-by-entry on-disk ZIP
  parser/index was introduced.
- Downloads still buffer each compressed archive and the client can transiently
  retain its response chunks plus concatenation. The parser no longer adds an
  additional compressed copy; network-body streaming is not implemented.
- Legacy DOE `pdfjs` now loads on first extraction through a shared cached
  promise. The intentional defensive typed-array copy remains. Fresh-process
  bootstrap/first-use/second-use evidence and the delayed-initialization cost
  are documented in [the PDF benchmark decision](./doe-sp-pdf-lazy-benchmark.md).
  Reproduce with `npm run benchmark:doe-sp-pdf`; this is a bootstrap saving,
  not a promise of permanently lower memory after a worker starts reading PDFs.
- SIGKILL/process loss can leave private temporary directories. Normal success,
  error, cancellation and in-process timeouts clean up, but a crash scavenger
  and disk-quota/operational alerting are not implemented.
- Ownership is fenced at the collection-to-persistence barrier, not newly
  rechecked inside every subsequent item transaction. Existing heartbeats and
  run-finalization ownership checks remain; broader per-item fencing is not
  introduced here.

Real-database integration/concurrency validation and operational disk/crash
handling remain required before claiming production readiness.
