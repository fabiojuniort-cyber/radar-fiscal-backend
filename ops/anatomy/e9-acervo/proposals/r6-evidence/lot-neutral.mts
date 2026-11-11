// R6: per-act neutralized outputHash (engine identity removed via the contract) of the official RFB lot, two roots
import { readFileSync } from 'node:fs'; import { join } from 'node:path';
async function run(root: string) {
  const lot = await import(join(root, 'ops/anatomy/official-lot-rfb.ts'));
  const { prepareRfbRepresentation } = await import(join(root, 'src/modules/anatomy/json-preparation.ts'));
  const { analyzeAnatomy } = await import(join(root, 'src/modules/anatomy/engine.ts'));
  const { anatomyOutputHash, anatomyIdentityHash } = await import(join(root, 'src/modules/anatomy/contract.ts'));
  const base = JSON.parse(readFileSync(join(root, 'docs/anatomy/official-lot-rfb.json'), 'utf8'));
  const out: Record<string, { neutral: string; inline: string }> = {};
  for (const a of base.acts) {
    const dir = lot.snapshotDirOf(a.idAto); const bytes = new Uint8Array(readFileSync(join(dir, `${a.idAto}.json`)));
    const p = prepareRfbRepresentation({ resourceId: `rfb:${a.idAto}`, bytes }, a.idAto);
    const r = analyzeAnatomy({ publicationVersionId: `rfb:${a.idAto}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
      input: { source: 'RFB', representationId: `rfb:${a.idAto}`, html: p.html }, catalog: { edition: 'none', codes: [] } });
    const n = structuredClone(r); n.identity.engineHash = 'NEUTRAL'; n.analysisId = anatomyIdentityHash(n.identity); n.outputHash = '';
    out[a.idAto] = { neutral: anatomyOutputHash(n), inline: JSON.stringify(a.inlineAttachments) };
  }
  return out;
}
const [x, y] = [await run(process.argv[2]!), await run(process.argv[3]!)];
let diff = 0; for (const k of Object.keys(x)) { const s = x[k]!.neutral === y[k]!.neutral && x[k]!.inline === y[k]!.inline; if (!s) diff++; console.log(`${s ? 'SAME' : 'DIFF'} ${k} ${x[k]!.neutral.slice(0, 12)} ${y[k]!.neutral.slice(0, 12)}`); }
console.log(`acts ${Object.keys(x).length}, semantic diffs ${diff}`);
