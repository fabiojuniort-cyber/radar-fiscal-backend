/**
 * ANAT-OFFICIAL-01 R1: act identity keys (species number/yy) of every corpus entry, derived ONLY from the inventory
 * labels of test/fixtures/anatomy/corpus-manifest.json (no inputs, gold or reserve). Regenerate with
 * `npx tsx ops/anatomy/reserved-act-keys.ts --write`; test/anatomy.official-overlap.unit.test.ts fails on drift.
 * Entries whose label carries no readable act identity are listed by id: an official sample from the same source is
 * refused unless its act key differs from every keyed entry AND it was reviewed against these ids (fail closed).
 */
export const RESERVED_ACT_KEYS: readonly string[] = Object.freeze(["ade 119/26","ade 120/26","ade 79/26","conv 100/97","conv 52/91","decreto 70843/26","in 2342/26","portaria 12157/26","portaria 43/26","portaria 4940/26","portaria 66/26","portaria 725/26","resolucao 86/26","sc 187/26","sc 188/26","sc 189/26","sc 191/26","sc 192/26","sc 193/26"]);
export const UNKEYED_CORPUS_ENTRY_IDS: readonly string[] = Object.freeze(["03","04","07","08","09","14","15","16","19","21","22"]);
/** Portal identifiers of every corpus entry (inventory sourceId): an official URL naming one of them is refused. */
export const RESERVED_SOURCE_IDS: readonly string[] = Object.freeze(["100/97","1445d0d3-e469-4d7f-ed0b-08df081b20d4","153743","153819","153820","153821","153822","153828","153829","153836","24359694","24377394","24378456","24380292","24382325","24382380","24382389","24382400","24382401","24382412","52/91","70413500-3dd4-4b9b-a88a-08df0495b6f6","91174000-076a-4029-bc7f-08df049590c6","9716c5c2-7f22-46eb-a80d-08df0495b6f6","a1f3e33f-e962-4ae9-ed58-08df04981eb4","a2e9bf6e-6d2f-430e-23cc-08df09ae1af9","b768399b-6638-460d-bce0-08df049590c6","b8fb1bba-1e31-407d-ab7f-08df0495b84e","d7eb71ec-9daf-4804-7eae-08df0817934e","ffe36bfd-ee7d-487b-d449-08df09ac2b13"]);
