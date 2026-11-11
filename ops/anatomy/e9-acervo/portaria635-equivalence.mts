// E9 P2-c R5 (tribusca-control#116, COORD): FORMAL equivalence proof of the Portaria RFB 635/2025 reading (rfb:148693)
// between two engines — the one its acceptance record pins and a composed candidate. Offline, read-only, deterministic.
// It REGISTERS NOTHING: it only prints the evidence the COORD needs before any append-only re-registration.
//
// Usage: npx tsx ops/anatomy/e9-acervo/portaria635-equivalence.mts <baseRoot> <candidateRoot> [out.json]
//   baseRoot      = checkout whose engine the record pins (e.g. #303 + patch B, engine 0e009431)
//   candidateRoot = disposable composition (#303 + #300 + patch A + patch B)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseRoot, candRoot, out] = process.argv.slice(2);
if (!baseRoot || !candRoot) throw new Error('usage: <baseRoot> <candidateRoot> [out.json]');
const ID = 148693; const BYTES_SHA = 'a98ade77b2ba777c82ce6388840cbae07d2e313f4c31e8e659388f56e4ab1cc8';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

async function readWith(root: string) {
  const { prepareRfbRepresentation } = await import(join(root, 'src/modules/anatomy/json-preparation.ts'));
  const { analyzeAnatomy } = await import(join(root, 'src/modules/anatomy/engine.ts'));
  const { anatomyOutputHash, anatomyIdentityHash } = await import(join(root, 'src/modules/anatomy/contract.ts'));
  const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(root, 'src/modules/anatomy/build-identity.ts'));
  const { lotEntrySha256 } = await import(join(root, 'ops/anatomy/official-coverage-matrix.ts'));
  const bytes = new Uint8Array(readFileSync(join(root, `ops/anatomy/official-identification/rfb-p2c/${ID}.json`)));
  const prep = prepareRfbRepresentation({ resourceId: `rfb:${ID}`, bytes }, ID);
  // the same request as the official lot (ops/anatomy/official-lot-rfb.ts)
  const r = analyzeAnatomy({ publicationVersionId: `rfb:${ID}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
    input: { source: 'RFB', representationId: `rfb:${ID}`, html: prep.html }, catalog: { edition: 'none', codes: [] } });
  // outputHash with the engine identity NEUTRALIZED (identity.engineHash → constant, analysisId recomputed from it)
  const neutral = structuredClone(r); neutral.identity.engineHash = 'NEUTRALIZED-ENGINE-IDENTITY';
  neutral.analysisId = anatomyIdentityHash(neutral.identity); neutral.outputHash = '';
  const lot = JSON.parse(readFileSync(join(root, 'docs/anatomy/official-lot-rfb.json'), 'utf8')) as { acts: { idAto: number }[] };
  const entry = lot.acts.find((a) => a.idAto === ID)!;
  return { engine: ANATOMY_ENGINE_BUILD_HASH, bytesSha256: sha(bytes), preparedHtmlSha256: sha(prep.html), result: r,
    neutralOutputHash: anatomyOutputHash(neutral), lotEntry: entry, entrySha256: lotEntrySha256(entry) };
}

const a = await readWith(baseRoot); const b = await readWith(candRoot);
const fields = ['canonicalText', 'parts', 'sourceMap', 'limitations', 'status', 'entities', 'evidence', 'eligibility', 'contractVersion', 'referenceDate'] as const;
const piece = (r: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, sha(canon(r[f]))]));
const pa = piece(a.result); const pb = piece(b.result);
const partsKey = (r: { parts: Record<string, unknown>[] }) => sha(canon(r.parts.map((p) => ({ id: p.id, type: p.type, context: p.context, contextReasons: p.contextReasons,
  legalStatus: p.legalStatus, span: p.span, sourcePointers: p.sourcePointers, parentId: p.parentId }))));
const identityDiff = Object.keys({ ...a.result.identity, ...b.result.identity }).filter((k) => canon(a.result.identity[k]) !== canon(b.result.identity[k]));
const lotDiff = Object.keys({ ...a.lotEntry, ...b.lotEntry }).filter((k) => canon((a.lotEntry as Record<string, unknown>)[k]) !== canon((b.lotEntry as Record<string, unknown>)[k]));
const resultDiff = fields.filter((f) => pa[f] !== pb[f]);
const report = {
  schema: 'e9-portaria635-equivalence/1', sample: `rfb:${ID}`, cellId: 'rfb--portaria--medio',
  engines: { base: a.engine, candidate: b.engine },
  bytes: { sha256: a.bytesSha256, pinned: BYTES_SHA, equal: a.bytesSha256 === b.bytesSha256 && a.bytesSha256 === BYTES_SHA },
  preparedHtml: { base: a.preparedHtmlSha256, candidate: b.preparedHtmlSha256, equal: a.preparedHtmlSha256 === b.preparedHtmlSha256 },
  parts: { count: [a.result.parts.length, b.result.parts.length], canonicalSha256WithContextLegalStatusSpanPointers: [partsKey(a.result), partsKey(b.result)], equal: partsKey(a.result) === partsKey(b.result) },
  result: { fieldSha256: { base: pa, candidate: pb }, differingFields: resultDiff },
  identity: { differingKeys: identityDiff, onlyEngineIdentity: identityDiff.every((k) => k === 'engineHash') },
  outputHash: { base: a.result.outputHash, candidate: b.result.outputHash, neutralized: [a.neutralOutputHash, b.neutralOutputHash],
    explainedByEngineIdentityOnly: a.neutralOutputHash === b.neutralOutputHash },
  lotEntry: { differingKeys: lotDiff, entrySha256: { base: a.entrySha256, candidate: b.entrySha256 } },
  verdict: resultDiff.length === 0 && identityDiff.every((k) => k === 'engineHash') && a.neutralOutputHash === b.neutralOutputHash
    && a.preparedHtmlSha256 === b.preparedHtmlSha256 && a.bytesSha256 === BYTES_SHA ? 'EQUIVALENT (reading identical; outputHash differs only by engine identity)' : 'NOT EQUIVALENT',
  proposedRecordNotRegistered: { sampleId: `rfb:${ID}`, cellId: 'rfb--portaria--medio', scope: 'offline', entrySha256: b.entrySha256, engineBuildHash: b.engine,
    revalidates: `rfb:${ID} @ ${a.engine.slice(0, 8)}`, note: 'NOT REGISTERED: only after A and B are final and the COORD authorizes; any further engine delta repeats this proof' },
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
