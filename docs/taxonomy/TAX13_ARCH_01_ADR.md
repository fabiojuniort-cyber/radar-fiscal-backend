# TAX13-ARCH-01 — Single authoritative legal proof (PROPOSED / implementation staging)

Decision approved for **isolated engineering only** by the project owner in chat 2026-10-08. This is NOT production, merge, migration, rescanning or highlight approval.

## References
- R7 BLOCK: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6072103605
- Governance: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101
- Base SHA: e74f92ad280bf87658e73442736d8e65404167ee
- Depends on #192 -> #186; no merge of either.

## Root cause and decision
Node htmlparser2/Unicode/UTF-16 DOM semantic validation rejects non-normative identifiers, revoked placeholders and historical annexes. PostgreSQL 045 reconstructs HTML and applies locale-dependent regex to claim CURRENT. R7 confirmed 96 false CURRENT/706 differential cases under LC_CTYPE=C (PG16/PG18), including real HTTP CURRENT_ATTESTED + SAME_ITEM/3; 20/20 real CONFAZ HTML cases were structurally unsupported by SQL.

**Decision:** the source-registered, versioned Node legal issuer is the sole normative parser. PostgreSQL handles scope, provenance, issuer/grant separation, identity, supersession, cryptographic commitment, temporal validity, catalog snapshot, RLS and append-only. The ordinary NCM worker may neither issue proofs nor bless its own positive codes. Signatures prove authorship/integrity, not legal correctness. The legal emitter still requires human/official provenance.

## Design invariants
- Original bytes and official URLs retained, sanitized HTML has separate SHA and version.
- No silent HTML normalization or offset migration (UTF16_CODE_UNITS contract).
- Fragment/node/row/cell boundaries remain separate; never join lexical words across scopes.
- New supersession/revocation/recheck/cat changes invalidate read projection without deleting history.
- PARTIAL/UNVERIFIED/UNSUPPORTED ≠ COMPLETE(0).
- New V2 proof cannot be backfilled by just attaching a digest to legacy 044/045.
- Isolate legal issuer, scan sealer, worker, app, curator and migrator DB credentials. No app/worker direct issuer signing or inserting accepted proofs.
- Refuse old SQL CURRENT bridge in the *final integration*; keep all positive output disabled until migration/rollout gates reviewed.
- Only targeted per-document canaries after R8 + governance. TAX12, DOE-SP, ONB-01, global rescan and green marks remain untouched.

## Rollout gates
1. Immutable LegalProof V2 contract, locked signer identity, key rotation/revocation and admission process.
2. App/worker cannot manufacture or consume proof via old SQL semantics.
3. Independently sealed NCM scans exactly bound to admitted legal certificate + catalog edition/entry.
4. DB16/18, locale C/en_US/pt_BR, full R2-R7 corpus (706+365 differential plus 5 HTTP minima) and new adversarial tests.
5. Stratified real CONFAZ sample (proposed >=300), structural coverage and explicit reasons for unsupported HTML/Unicode.
6. Fixed P2 catalog metadata API and unique fixture schedule without production constraint changes.
7. Controlled performance measurements for valid scans, HTTP and near-size-limit HTML.
8. Independent R8 on frozen SHA. No claim of APPROVED for CI alone.
9. Separate explicit gates for merge, production migrations, deploy and canaries.

## Current staged implementation
LegalProof V2 typed/deterministic and signed emission primitive plus fail-closed unit tests. This does not yet enable public projections; R7 BLOCK remains until all gates above pass.
