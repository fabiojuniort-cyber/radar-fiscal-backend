A r12 evidence (review R11 c.6930078953; fixture c.6930068067). Nothing integrated, nothing registered. Single writer: EXEC session_01DdUtZuqDfYz8XXwX5uLtJe.
Fixtures:
  r12-reviewer-34-original.mts         the reviewer's 34 cases VERBATIM from c.6930068067; harness = lines 1-9 + output loop of ../r10-evidence/r10-adversarial.mts
                                        (file sha differs from the reviewer's rev.mts b2aec2b2…: its loop was not published; the 34 cases are identical)
  r12-general-rule-160-reconstructed.mts  5 boundaries x 13 markers x start/middle + same-sentence + own-content controls, RECONSTRUCTED from the
                                        published description; the reviewer's g.mts (153 cases, bafb3153…) was not published -> equivalence NOT_PROVEN
Other runners: ../r7-evidence/r7-cases.mts (R6-R12 sections of the test file), ../r10-evidence/r10-adversarial.mts, ../r11-evidence/r11-reviewer-reconstructed.mts
Before (A r11) -> after (A r12):
  rev34       1/34 -> 0/34            g160        45/160 -> 0/160
  directed    253/285 -> 285/285      adversarial 0/85 -> 0/85      r11-reviewer 0/21 -> 0/21
  r12-unit-tests-on-A-r11.txt         R12 tests on the A r11 engine: 40 pass / 3 fail (only the 3 R12 tests)
A r12 isolated: r12-iso-test-anatomy.txt 302/302; tsc clean; verify-build 4aea8f94…; r12-iso-pg.txt PG16 :5432 VERSIONED own pin 4aea8f94 12/12;
  lot-neutral-r11-vs-r12.txt 7 acts, 0 semantic diffs
known-false-negatives.txt   conservative FNs (own content not promoted): R11-1, R11-2 (also without previous sentence), R12-1 "em tela única" (new in r12)
Composition #303 + #300 + A r12 + B r7 (engine 22c6d1f0):
  composition-r12-test-anatomy.txt 419 tests, 415 pass / 4 fail (#153 #167 #170 #174, identity only)
  comp-r12-pg.txt       PG16 :5432 VERSIONED #303 pin 0e009431: 7/12 (test 3 > subtest 5 pin; 6-8 cascade)
  comp-r12-pg-diag.txt  DIAGNOSTIC ONLY throwaway pin copy 22c6d1f0: 12/12
  ade-cofis-composition-r12.json  read, 9 rows, 16 cells, 26/26 pointers, operative_candidate, legalStatus unknown
  e9-acceptances-compare.txt      independent base #303 6b12ac64 + B r7 vs composition: cmp identical, sha256 4e0fccfc…, 13 = 13, proposed entrySha256 0 occurrences
