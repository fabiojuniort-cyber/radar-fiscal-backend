A r10 evidence (R9-RES origin of the approved object; R9-ANA sentence-opening resumption). Nothing integrated, nothing registered.
Runner for the directed cases: ../r7-evidence/r7-cases.mts <root> (parses the R6-R10 sections of the test file).
r10-cases-before-A-r9.txt      210 cases on A r9 (R10 test file): 163 OK / 47 FAIL; the 131 previous cases all OK
r10-cases-after-A-r10.txt      210 cases on A r10: 210/210; first 131 rows byte-identical to the A r9 run
r10-unit-tests-on-A-r9.txt     unit file with the R10 tests on the A r9 engine: 35 pass / 2 fail (only the 2 R10 tests)
r10-adversarial.mts            85 adversarial cases (13 reviewer resumptions x 2 positions, novel variants, own controls, cross-sentence)
r10-adversarial-on-A-r9.txt    45 divergences / 85
r10-adversarial-on-A-r10.txt   0 divergences / 85, legalStatus unknown throughout
r10-iso-test-anatomy.txt       isolated A r10: test:anatomy 296/296
r10-iso-pg.txt                 isolated A r10, PG16, own versioned pin ff8e444f: 12/12
lot-neutral-r9-vs-r10.txt      official lot, 7 acts, 0 semantic diffs
composition-r10-test-anatomy.txt  #303 + #300 + A r10 + B r7: 413 tests, 409 pass / 4 fail (#153 #167 #170 #174, identity only)
comp-r10-pg.txt                composition PG16, #303 versioned pin 0e009431: 7/12 (test 3 > subtests 5-8, pin)
comp-r10-pg-diag.txt           composition PG16 with a temporary pin copy 8061ac82 (diagnostic, not committed): 12/12
ade-cofis-composition-r10.json ADE Cofis rfb:148629 real bytes on the composition: read, 26/26 pointers, operative_candidate, legalStatus unknown
