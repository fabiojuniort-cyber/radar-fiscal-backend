# TAX13 ARCH02 — R7 adversarial differential suite (local C)

These tests are published R7 reviewer fixtures from issue #101, copied with:
1. *only* CI disposable locale guard changed to `tax13_arch02_locale_c` at localhost:5432, NODE_ENV=test, GITHUB_ACTIONS=true;
2. former failed positive control now requires explicitly issued Node V2 proof + independent NCM seal (test-only synthetic helper);
3. the previous HEAD label replaced with `TAX13_ARCH02_R8_CANDIDATE`.

Review source and checksums are available at issue #101 comments 6072092714 and 6072095483.

**They NEVER operate on production or Railway.** The workflow creates its own template0 C database on the ephemeral GitHub runner. R7's 706 Unicode, whitespace, annex, HTML, malformed signature-offset and adversarial INSERT cases are tested on PG16+PG18, with authenticated HTTP. A passing run is insufficient for R8: add en_US/pt_BR, real CONFAZ, performance and independent review.

Prior old R7 report: 96/706 false CURRENT in C and 5/7 HTTP failures. New expected: **zero false CURRENT**. A valid CURRENT needs a signed V2 proof and independent seal, not a forged 044 row alone.
