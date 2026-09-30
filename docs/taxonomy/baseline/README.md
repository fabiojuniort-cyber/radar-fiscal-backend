# TriBusca Taxonomy Baseline R6

This directory contains the deterministic TAX-06 baseline artifacts.

## Source of truth

The semantic source of truth remains:

- repository: `fabiojuniort-cyber/tribusca-control`
- R6 path: `docs/taxonomy/TAX-02_DICIONARIO_FUNCIONAL_TAXONOMIA_TRIBUSCA_V1_R6.md`
- R6 approved Git SHA: `fee931cb212de808fa3fee1a06c833d746637c8c`
- R6 blob: `4f3b906d5ca2044ed05b3397890a5fc45c44e8c1`
- R6 SHA-256: `7f68d7be2dfc5486f4fb5c88259de629976b1daa54b62cf9248f4e6efbbadfd2`

The technical contract remains:

- TAX-04 path: `docs/taxonomy/TAX-04_MODELO_TECNICO_TAXONOMIA_TRIBUSCA_V1.md`
- approved Git SHA: `12fe8d2cd7729d9a69695ed39af74969ba219a56`
- blob: `0fbd4d0759954978fc81e208e3f3f2f02c8239b4`
- SHA-256: `55eaf16dde93d2904e77e3c706afff73db106c1472c4e23205cddf8b903cac0b`

Files under `source/` are immutable technical mirrors only. They are not a second semantic source of truth.

## Offline contract

Manifest, validate, dry-run, import and inspect commands read only the allowlisted local mirrors. They do not fetch GitHub, HTTP endpoints or external APIs.

Before parsing, both mirrors are validated for:

1. strict UTF-8;
2. Git blob SHA;
3. SHA-256;
4. source-lock provenance.

Any mismatch aborts with `BASELINE_SOURCE_INTEGRITY_FAILURE`.

## Commands

After `npm run build`:

```text
npm run taxonomy:baseline:manifest -- --write
npm run taxonomy:baseline:manifest -- --check
npm run taxonomy:baseline:validate
npm run taxonomy:baseline:dry-run
npm run taxonomy:baseline:import -- --target=v1.0.0 --manifest-sha256=<sha256>
npm run taxonomy:baseline:inspect
```

`manifest` and `validate` do not require PostgreSQL.

`dry-run` uses a read-only transaction and must perform zero writes.

`import` requires `DATABASE_ADMIN_URL`, enters one `SERIALIZABLE` transaction, uses `SET LOCAL ROLE radar_taxonomy_curator`, acquires the version-scoped advisory transaction lock and commits only after read-back succeeds.

The import finishes with release status `DRAFT`. It does not promote the release.

## Expected R6 baseline

```text
dimensions                 20
concepts                  628
unique concept codes      628
NEEDS_EVIDENCE             55
forbidden MIT concepts      0
lexical aliases            21
alias bindings             23
multi-bind lexical aliases  1
```

`Crédito` is one lexical alias with three `AMBIGUOUS` bindings.

The physical relation seed contains exactly seven relation types. `about`, `hosted_by` and `fulfills` are normalized to qualified `related_to`.

No CNAE/NCM/NBS catalog or official mapping is invented by TAX-06.

## Manifest governance

`TAXONOMY_BASELINE_V1_MANIFEST.json` is generated, never manually maintained.

CI regenerates it and requires the committed file to be byte-identical.

The derivation fingerprint includes:

- R6 source fingerprint;
- TAX-04 technical contract fingerprint;
- parser version;
- manifest version;
- relation-seed-contract version.

## Production gates

TAX-06 implementation and merge do not authorize production data changes.

Production remains gated separately:

1. TAX-06-P1 — apply migrations 015–018;
2. P2 — structural verification;
3. P3 — production dry-run;
4. P4 — dry-run review;
5. P5 — explicit load authorization;
6. P6 — transactional import;
7. P7 — read-back.

This directory does not authorize any of those production gates.
