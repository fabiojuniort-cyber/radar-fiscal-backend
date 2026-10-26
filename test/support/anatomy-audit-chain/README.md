# Vendored audit chain (ANAT-ADMIN-01 / P3-B1, disposable CI only)

Byte-identical copies of `main` migrations, used ONLY by `test/anatomy.admin-schema.integration.test.ts` in the
disposable CI database. Not read by `src/infrastructure/database/migrate.ts` (it reads `migrations/` only).

| File | Git blob SHA (verified by the test) |
|---|---|
| `006_audit.sql` | `f53c9fbb69e8839733b466f0244eb30dfbedc357` |
| `074_audit_allowlist_and_backfill.sql` | `baf49f70ac67c5f9898ddfeb463165c104ed5437` |
| `075_audit_historical_event_rules.sql` | `ad832c2d73954c39d763d0d0b7402fbbb5b684f7` |

The test applies 006 in full, 074 lines 1–160 (policy, references, projector, guard and trigger; the cut is checked
against the marker on line 161, `CREATE TABLE IF NOT EXISTS public.audit_backfill_checkpoint(`), and 075 in full.
074 from line 161 on (backfill batch and the rewritten writers of platform/taxonomy tables) needs application tables
that the disposable database does not have. Limit: this is not the real migration chain; it is re-verified when the
stack is rebased onto `main` and the real numbered migrations are written.
