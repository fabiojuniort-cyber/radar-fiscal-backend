# TAX13-ARCH-02 — offline fixture upload target

This folder exists solely to stage the **hash-pinned, 20-document structural corpus** on the isolated PR #193 branch. Never use it for production ingestion.

Required file (not committed yet):
`test/fixtures/tax13-confaz-offline-20.zip`

Expected exact SHA256:
`892970d8891868d37350bb1403ceff218f551eb91f2c59441a000bc5331d4de0`

Expected size: 509,503 bytes.

Source: user-provided `Confaz.zip` (17,403 XML documents), offline extraction of the same 20 CONFAZ *page bodies* selected by the existing online compatibility probe. Each fixture includes its unchanged XML, its official-body HTML extracted from `corpo_html_oficial`, metadata, original declared URLs and SHA256.

**Crucial:** the embedded HTML is **not** the original full HTTP response. Declared SHA256 for that response is not independently verifiable from this corpus. This fixture is non-normative and cannot authorize `CURRENT_ATTESTED`, NCM positives or green marks.

The CI intentionally fails with `ENOENT` when the ZIP is absent and refuses the file if its SHA256 differs; this is NOT an automatic CI waiver. The user must upload the exact ZIP unchanged into this folder on PR #193's head branch. Full legal R8 and production restrictions still apply.

Governance: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101
