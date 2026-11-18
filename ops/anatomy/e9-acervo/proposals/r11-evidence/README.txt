A r11 evidence (review R10 c.6924070158): resumption without own antecedent is unresolved; opening Estes/Estas/demais/ditos/sobredito;
"diploma" as self-reference. Nothing integrated, nothing registered. Single writer: EXEC session_01DdUtZuqDfYz8XXwX5uLtJe.
Runners: ../r7-evidence/r7-cases.mts <root> (R6-R11 sections of the test file); ../r10-evidence/r10-adversarial.mts <root>;
         r11-reviewer-reconstructed.mts <root> (21 cases RECONSTRUCTED from the published review fragments; the reviewer's 34-case fixture was not published).
r11-cases-before-A-r10.txt     243 directed cases, A r10 engine + A r11 test file: 222 OK / 21 FAIL (only R11 cases fail)
r11-cases-after-A-r11.txt      243/243
r11-adversarial-on-A-r1{0,1}   0 / 85 divergences on both
r11-reviewer-on-A-r10.txt      11 / 21 divergences (DIV-1..DIV-9, two after an ordinary sentence end)
r11-reviewer-on-A-r11.txt      0 / 21
r11-unit-tests-on-A-r10.txt    unit file with R11 tests on the A r10 engine: 37 pass / 3 fail (only the 3 R11 tests)
r11-iso-test-anatomy.txt       A r11 isolated: test:anatomy 299/299; tsc clean; verify-build 66bf0391…
r11-iso-pg.txt                 A r11 isolated, PG16 :5432, VERSIONED pin of the patch 66bf0391: 12/12
lot-neutral-r10-vs-r11.txt     official lot, 7 acts, 0 semantic diffs
composition-r11-test-anatomy.txt  #303 + #300 + A r11 + B r7 (engine 2ce68110): 416 tests, 412 pass / 4 fail (#153 #167 #170 #174, identity only)
comp-r11-pg.txt                composition PG16 :5432, VERSIONED #303 pin 0e009431: 7/12 (test 3 > subtest 5 pin, 6-8 cascade)
comp-r11-pg-diag.txt           DIAGNOSTIC ONLY, throwaway pin copy 2ce68110: 12/12
ade-cofis-composition-r11.json ADE Cofis rfb:148629: read, 9 rows, 16 cells, 26/26 pointers, operative_candidate, legalStatus unknown
e9-acceptances-compare.txt     independent base #303 6b12ac64 + B r7 vs composition: cmp identical, sha256 4e0fccfc…, 13 = 13 records, proposed entrySha256 0 occurrences
