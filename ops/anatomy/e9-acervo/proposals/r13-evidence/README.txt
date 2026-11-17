A r13 evidence (review R12 c.6933422896; fixtures c.6933415580). Nothing integrated, nothing registered. Single writer: EXEC session_01DdUtZuqDfYz8XXwX5uLtJe.
Fixtures (run: npx tsx <file> <engine root>):
  g-original-153.mts          the reviewer's g.mts, rebuilt from c.6933415580 (harness + block): sha256 bafb3153… = original (byte-identical)
  rev-34-original-cases.mts   the 34 cases verbatim (c.6930068067) + harness + the g.mts output loop; file != reviewer rev.mts b2aec2b2… (loop not published)
  r12-73-reconstructed.mts    65 cases reconstructed from the R12 review description; original r12.mts (73, 4523a4f1…) not published -> NOT_PROVEN
  r13-synonyms-46.mts         NEW: 8 forms of multicitado / em epígrafe / em questão / em causa (accents, case) x 5 positions + 6 own-content controls
Before (A r12 4aea8f94) -> after (A r13 8debb578):
  r13-synonyms 40/46 -> 0/46 ; r12-73 6/65 -> 2/65 (R12-1 FN only) ; g 11/153 -> 11/153 (known FN only: R11-1 x5, R11-2 x6) ; rev 0/34 -> 0/34
  directed (r7-cases) 290/306 -> 306/306 ; adversarial 0/85 -> 0/85 ; R13 unit test on the A r12 engine fails (1 of 44), passes on A r13
A r13 isolated: r13-iso-test-anatomy.txt 303/303; tsc clean; verify-build 8debb578…; r13-iso-pg.txt PG16 :5432 VERSIONED own pin 8debb578 12/12;
  lot-neutral-r12-vs-r13.txt 7 acts, 0 semantic diffs
known-false-negatives.txt   conservative FNs (own content not promoted): R11-1, R11-2, R12-1 (tela única / exibidos em tela), NEW R13-1 ("matéria em questão", "bens em causa")
Composition #303 + #300 + A r13 + B r7 (engine 4b96f977):
  composition-r13-test-anatomy.txt 420 tests, 416 pass / 4 fail (#153 #167 #170 #174, identity only)
  comp-r13-pg.txt       PG16 :5432 VERSIONED #303 pin 0e009431: 7/12 (test 3 > subtest 5 pin; 6-8 cascade)
  comp-r13-pg-diag.txt  DIAGNOSTIC ONLY throwaway pin copy 4b96f977: 12/12
  ade-cofis-composition-r13.json  read, 9 rows, 16 cells, 26/26 pointers, operative_candidate, legalStatus unknown
  e9-acceptances-compare.txt      independent base #303 6b12ac64 + B r7 vs composition: cmp identical, sha256 4e0fccfc…, 13 = 13, proposed entrySha256 0 occurrences
