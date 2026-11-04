import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { SYNTHETIC_DOCS } from '../../test/support/anatomy-synthetic-docs.js';

/**
 * P1.B equivalence evidence: the engine output on SYNTHETIC documents, with identity fields removed
 * (identity, analysisId, outputHash), because those hashes change by design when profiles are wired in.
 * Generated ONCE on the pre-integration engine (P1.A HEAD 585f5a49); the test then requires the integrated
 * engine with the default profile to reproduce it exactly. Usage: tsx ops/anatomy/synthetic-snapshot.ts [--write]
 */
export const SNAPSHOT_PATH = new URL('../../test/fixtures/anatomy/synthetic-equivalence.json', import.meta.url);
export function structuralOutput() {
  return SYNTHETIC_DOCS.map(({ id, request }) => {
    const { identity: _i, analysisId: _a, outputHash: _o, ...structure } = analyzeAnatomy(request);
    return { id, structure };
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const body = JSON.stringify({ note: 'Engine output on synthetic documents without identity fields; generated on the pre-integration engine (P1.A HEAD 585f5a49); regenerated for ANAT-STRUCT-01, whose only delta is CONSIDERANDO typed as consideration instead of preamble (same context).',
    documents: structuralOutput() }, null, 1) + '\n';
  if (process.argv.includes('--write')) { writeFileSync(SNAPSHOT_PATH, body); console.log('synthetic equivalence snapshot written'); }
  else if (readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n') !== body) throw new Error('synthetic structural output differs from the frozen snapshot');
  else console.log('synthetic structural output verified');
}
