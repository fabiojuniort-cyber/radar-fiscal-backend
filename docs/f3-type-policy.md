# F3: types of acts

DOU and DOE-SP use `evaluateCollectionFilter` for capture, historical direct/global previews and the daily l17 inspection. The official type and anchored first title line are independent inputs. Case, accent, punctuation and labeled act numbers are normalized. Whole-word prefixes match source plus saved section, its principal extra-section parent, or general blank section. An absent publication section matches only general rules.

The pattern with the most words wins. Evaluate conditional modes at that specificity; a tied KEEP wins over DISCARD. Section-specific scope selects between otherwise equivalent outcomes. No pattern keeps and registers an unclassified type. Identical normalized rule/alias identities with conflicting targets/modes block activation; transactional administrative edits compile the persisted policy before commit. Variants remain saved for manual review.

EXCLUDE_ALWAYS precedes material, terms and relevance gates, but contradictory origin/version evidence keeps the publication. Origin and version are compared independently of official-vs-title disagreement, which is no longer a veto. Other sources keep their existing behavior. Connectors retain acquisition sections, dates and budgets; their legacy type/relevance classification is informational within that acquisition boundary. This can increase detail/material downloads for previously skipped unknown types.

Physical deletion remains administrator-only, with count, samples, preview token and explicit confirmation. Changed targets or policy invalidate confirmation. A company/match link or any additional origin protects the entire publication, even if another origin might itself be excluded. Row locks and policy locks are rechecked before bounded destructive batches; audit records survive deletion. A protected existing publication also survives capture exclusion. No publication hiding/projection fields are introduced.

Migration 068 replaces bounded evidence/administrative functions and revokes both unattended l17 deletion grants. It performs DDL only, never a retroactive purge. The scheduler's l17 rule and legacy hidden jobs now inspect only. L10 retention of transient collection items is separate and unchanged. Runtime material classification and historical stored file metadata use the same role/kind criteria; legacy archived files without classification conservatively gate conditional rules. That missing evidence cannot be reconstructed as a past capture verdict.

| Test case | Expected |
| --- | --- |
| Official Aviso; title EXTRATO DE CONTRATO Nº 33/2026; matching EXCLUDE | DISCARD, title wins |
| Official Portaria; PORTARIA Nº 10; KEEP Portaria | KEEP |
| Accent/case/punctuation; BF, CE, PE SRP suffix | Whole-word prefix |
| EXTRATO DE CONTRATOS against CONTRATO | No match, KEEP + review |
| Body mentions excluded type; title is BOLETIM | Body never supplies type |
| DO1E/DO2E/DO3E and principal rules | Parent inherited |
| Absent section; section-specific rule | No match; only general allowed |
| More specific KEEP against generic EXCLUDE | KEEP, irrespective of input field |
| Equal words, opposite effective decisions | KEEP |
| No types/patterns | KEEP + classification request |
| Policy created after capture | Same historical engine; preview only until confirmation |
| DOU DO1/DO3 and DOE-SP | Same engine and adapter contract |
| Company/match or additional origin | Protected; zero deletion |
| Changed preview/protected target/revision | Confirmation invalid, zero deletion |
| Normalized opposing identity edit | Transaction rolls back; policy still loads |
| Daily l17 / legacy hidden | Preview; zero deletion |

Release order: backend DRAFT plus read-only simulation; Fábio reviews impact and redundant variants; independent review and full CI on final head; only then explicit merge authorization. Web follows to present samples/protected records and confirmations using these existing endpoints. Migration must precede upgraded worker/API execution. No retroactive exclusion is authorized by this PR or its simulation.

Rollback before merge is closing the draft and neutralizing the temporary service. After an authorized rollout, stop destructive confirmations, restore the previous application and use a forward compensating migration that preserves the no-background-deletion safeguard. Do not restore unattended destructive grants. Completed physical deletions require restoration from an independently validated backup; reverting code cannot recover rows. Review the preview and backup gate before any future purge.
