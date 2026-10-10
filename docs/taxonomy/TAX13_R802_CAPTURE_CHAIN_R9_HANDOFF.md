# TAX13-R8-02 — Isolated HTTPS CONFAZ custody and R9 preflight (BLOCK)

**Status:** engineering candidate only; **NOT APPROVED**, not deployed, no migrations in production, no positive evidence from real CONFAZ. Parent [#193](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/193), incremental [#194](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/194), [governance #101](https://github.com/fabiojuniort-cyber/tribusca-control/issues/101), R8 prior BLOCK (#6074170433).

## Frozen input / scope
- Based on #193 at `e41ada568972449ec0d156c225923119acb1ff8b`.
- Original R8-02 gap: migration 047 already hashes persisted `raw_http_bytes` but ADMIN can put synthetic bytes, timestamp, and official-looking URL in the artifact table. They are **not** a proof of TLS origin; signing a digest or MAC of them does not repair this provenance gap.
- 048 adds an independent, non-production collector trust boundary **in addition to** independent Ed25519 proof issuer and independent proof verifier. None of its records alone demonstrates legal validity or source officiality.

## HTTP custody chain
1. Dedicated `radar_http_collector_runtime` with distinct PostgreSQL role/password plus independently held collector MAC secret, not installed in app/worker/issuer/sealer/verifier environment.
2. Read only a registered, in-scope **current CONFAZ publication version URL** through constrained `tax13_r802_capture_target`; never use operator-provided HTML/response bytes.
3. Direct `node:https` TLS (certificate-authorized) to strict `www.confaz.fazenda.gov.br` HTTPS port 443, `/legislacao/` scope. Resolve all IPv4 addresses, reject nonpublic answers, pin one resolved public IP per hop and SNI to the official host. Forbid proxy and caller fetch injection. Recheck URL/host/scheme/port/authority at every redirect, max 4.
4. Reject unsupported HTTP status, content encoding, charset/content type, timeout, empty body or payload over **16,777,216 bytes**; stream only bounded bytes and compare declared length. Preserve unmodified **HTTP response entity-body bytes** (`raw_http_bytes`) plus SHA-256, final URL, ordered redirect URL chain, source host, remote IP, SHA-256 of TLS peer certificate, collector, start and collection instants. **HTTP response headers and TLS packet transcript are not persisted in wire-byte form**; those would require additional controls if R9 demands whole-message forensic replay.
5. Require the sanitization of captured UTF-8 HTML body (official page `parent-fieldname-text`) to match the stored publication version **exactly**, with separate hash.
6. Insert original bytes and independent HMAC-SHA256 capture receipt *atomically* in a disposable DB. MAC binds artifact UUID, body SHA, publication version, origin URL, final URL, ordered redirects, IP, TLS cert digest, collector, and timestamps. Receipt is append-only, FORCE RLS. Read is conditional on nonrevoked key. Repeated byte-identical captures have distinct event identities (048 replaces 047 capture uniqueness with lookup index). No trusted receipt => `UNVERIFIED`.
7. Issuer `tax13_v2_original_exists_for_issuer` now rejects artifact without trusted capture receipt; original proof insertion fails and cannot mint V2.
8. Independent proof verifier additionally requires authenticated receipt and, **under separate explicit authorization in a non-GitHub isolated environment**, independently re-fetches HTTPS and checks body SHA, final URL and redirect chain. If HTTPS cannot be observed or differs, it refuses proof MAC and `CURRENT`.
9. SQL 048 requires a nonrevoked receipt for proof verifier INSERT and *every* admitted current fragment projection; NCM fingerprints and API CURRENT depend on that positive proof. An old 047 MAC does not resurrect a now-invalid receipt.
10. Real CONFAZ historical XML body HTML files and GitHub fixture HTTP bytes **remain structurally useful test data but are always unverified transport provenance**. No backfill to official receipt.

## Trust boundary / remaining decision
- A PostgreSQL superuser/fixture with complete control of **both** independent collector MAC secret and independent proof-verifier key could fabricate accepted receipts directly at SQL level. A MAC is not an external timestamping authority. Strong adversarial resistance to database administration needs owner-approved external HSM/KMS signing and independently monitored issuance/audit outside the same administrative trust domain.
- The collector is currently **disabled in production** and cannot execute in GitHub Actions. Live confirmation requires an owner-authorized isolated machine capable of reaching official HTTPS, separate non-production PostgreSQL credentials, secrets generated outside the repo, a registered version matching the HTTP source, permitted collection, and independently authorized verifier replay.
- Given the old synthetic-positive fixtures, enabling 048 causes those old tests to fail with `TAX13_R8_ORIGINAL_HTTP_UNVERIFIED` by design. Do **not** weaken the source check or give CI fixtures official identity to manufacture a green pipeline. Preserve their former assertions as historical 047 evidence; add 048-specific negative gates. True positive E2E must use a live, independent captured response (or a separate cryptographically authorized non-CI test network emulation with clearly NON-OFFICIAL status).
- Independent reviewer R9 must explicitly review this threat model, admission grants, key custody, replay, SSRF and cert handling, source change during fetch, revocation, supersession, multilocale and performance, and the live-chain evidence. R9 remains *NOT VERIFIED* until all gates actually complete.

## Negative-matrix evidence intent
| Vector | Expected safe result |
|---|---|
| Admin bytes with matching SHA and `official_url` | `tax13_v2_capture_verified=false`; issuer cannot mint V2; CURRENT NULL |
| Foreign URL, redirect to other host, HTTP downgrade, userinfo, special IP | Collection rejected prior to persisting |
| Invalid collector HMAC, altered body/URL/redirect/time/cert fingerprint | Receipt insert rejected |
| No live HTTPS or replay mismatch | No verifier MAC, no accepted CURRENT |
| Payload >16MiB, gzip/deflate, invalid charset, non-200 | No receipt; diagnosis unsupported/source unavailable |
| Capture MAC key revocation | Previously admitted legal/NCM projections become nonpositive |
| Replayed stale receipt or changed event identity | Must fail ID/MAC, uniqueness, time and/or revoked-key checks; dedicated regression required |
| Conflicting publication source version | No capture admission and no positive projection |
| Cross-tenant reads | Existing API/RLS gates still apply; live E2E pending |

## Restrictions
**Never merge** #186/#192/#193/#194 without later explicit authorization. **Never apply** migrations 044–048 in production. No Railway deploy, TAX12, DOE-SP, ONB, rescan or reclassification globally, or legal green highlights. CI results are not an independent APPROVED.
