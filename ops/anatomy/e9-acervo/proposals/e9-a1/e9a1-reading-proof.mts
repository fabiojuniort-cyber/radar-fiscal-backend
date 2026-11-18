// E9-A1 (tribusca-control#116, COORD mandate "E9-A1 — Provar leitura de três células RFB").
// Generalizes the Portaria 635 routine (ops/anatomy/e9-acervo/portaria635-equivalence.mts) to N preserved RFB samples.
// Offline, read-only, deterministic. It REGISTERS NOTHING: it prints per-sample evidence and PROPOSED (unregistered)
// append-only acceptance records, only for samples whose reading the official matrix rule already deems complete.
//
// Usage: npx tsx ops/anatomy/e9-acervo/proposals/e9-a1/e9a1-reading-proof.mts <baseRoot> <candidateRoot> [out.json]
//   baseRoot      = checkout of the published merge (main 196c6ca9, engine 4b96f977)
//   candidateRoot = independent checkout of current main (same engine expected)
// For each sample it proves: (1) identity/provenance — bytes SHA-256 = meta = lot entry; (2) the reading is reproduced
// byte-for-byte by BOTH roots (parts/contexts/legalStatus/spans/pointers, every result field, outputHash) and the
// freshly recomputed lot entry equals the stored one (so the entrySha256 is the stored lot digest, not a new value);
// (3) completeness by the matrix's own rfbReadingAssessment; (4) the grid cell the sample really falls in.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseRoot, candRoot, out] = process.argv.slice(2);
if (!baseRoot || !candRoot) throw new Error('usage: <baseRoot> <candidateRoot> [out.json]');
const EXPECTED_ENGINE = '4b96f97783631b77404493139c2c786554222deda2489e66d3b9c29be981d06a';
const TARGETS: { id: number; cellId: string }[] = [
  { id: 108391, cellId: 'rfb--instrucao-normativa--pequeno' }, { id: 133898, cellId: 'rfb--instrucao-normativa--pequeno' },
  { id: 115131, cellId: 'rfb--instrucao-normativa--grande' }, { id: 127905, cellId: 'rfb--instrucao-normativa--grande' },
  { id: 104314, cellId: 'rfb--instrucao-normativa--grande' }, { id: 142967, cellId: 'rfb--portaria--pequeno' },
];
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const fields = ['canonicalText', 'parts', 'sourceMap', 'limitations', 'status', 'entities', 'evidence', 'eligibility', 'contractVersion', 'referenceDate'] as const;
const partsKey = (r: { parts: Record<string, unknown>[] }) => sha(canon(r.parts.map((p) => ({ id: p.id, type: p.type, context: p.context, contextReasons: p.contextReasons,
  legalStatus: p.legalStatus, span: p.span, sourcePointers: p.sourcePointers, parentId: p.parentId }))));

async function load(root: string) {
  const m = {
    prep: await import(join(root, 'src/modules/anatomy/json-preparation.ts')),
    engine: await import(join(root, 'src/modules/anatomy/engine.ts')),
    quote: await import(join(root, 'src/modules/anatomy/rfb-quote-resume.ts')),
    contract: await import(join(root, 'src/modules/anatomy/contract.ts')),
    id: await import(join(root, 'src/modules/anatomy/build-identity.ts')),
    lotMod: await import(join(root, 'ops/anatomy/official-lot-rfb.ts')),
    matrix: await import(join(root, 'ops/anatomy/official-coverage-matrix.ts')),
  };
  const storedLot = JSON.parse(readFileSync(join(root, 'docs/anatomy/official-lot-rfb.json'), 'utf8')) as { engineBuildHash: string; acts: { idAto: number }[] };
  const freshLot = m.lotMod.analyzeLot() as { engineBuildHash: string; acts: { idAto: number }[] };
  const samples = m.matrix.collectSamples() as { id: string; size: string | null; type: string; readingComplete: boolean | null; stages: Record<string, boolean> }[];
  const grid = m.matrix.GRID as { id: string }[];
  const acceptances = JSON.parse(readFileSync(join(root, 'docs/anatomy/e9-acceptances.json'), 'utf8'));
  return { root, m, storedLot, freshLot, samples, grid, acceptances, engine: m.id.ANATOMY_ENGINE_BUILD_HASH as string };
}

function read(L: Awaited<ReturnType<typeof load>>, id: number) {
  const dir = L.m.lotMod.snapshotDirOf(id) as string;
  const body = readFileSync(join(dir, `${id}.json`));
  const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), 'utf8')) as Record<string, unknown> & { sha256: string; bytes: number; url?: string; consultedAt?: string; origin?: string; identification?: { epigrafe?: string } };
  const p = L.m.prep.prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id);
  // the same request as analyzeLot (ops/anatomy/official-lot-rfb.ts)
  const r = L.m.engine.analyzeAnatomy({ publicationVersionId: `rfb:${id}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
    input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html, rfbQuoteResume: L.m.quote.planRfbQuoteResume({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id) },
    catalog: { edition: 'none', codes: [] } });
  const stored = L.storedLot.acts.find((a) => a.idAto === id)!; const fresh = L.freshLot.acts.find((a) => a.idAto === id)!;
  const assess = L.m.matrix.rfbReadingAssessment(stored, body) as { complete: boolean; bodyAbsent: boolean; readAttachments: number; gaps: string[] };
  const sample = L.samples.find((s) => s.id === `rfb:${id}`)!;
  const cell = L.grid.find((c) => L.m.matrix.matches(c, sample))?.id ?? null;
  return { dir: dir.slice(dir.indexOf('ops/')), body, meta, prepHtmlSha: sha(p.html), r, stored, fresh, assess, cell, sample,
    storedEntrySha: L.m.matrix.lotEntrySha256(stored) as string, freshEntrySha: L.m.matrix.lotEntrySha256(fresh) as string };
}

const A = await load(baseRoot); const B = await load(candRoot);
const samples = TARGETS.map(({ id, cellId }) => {
  const a = read(A, id); const b = read(B, id);
  const bytesSha = sha(a.body);
  const pa = Object.fromEntries(fields.map((f) => [f, sha(canon(a.r[f]))])); const pb = Object.fromEntries(fields.map((f) => [f, sha(canon(b.r[f]))]));
  const differingFields = fields.filter((f) => pa[f] !== pb[f]);
  const identityDiff = Object.keys({ ...a.r.identity, ...b.r.identity }).filter((k) => canon(a.r.identity[k]) !== canon(b.r.identity[k]));
  const checks = {
    bytesEqualMeta: bytesSha === a.meta.sha256 && a.body.length === a.meta.bytes,
    bytesEqualLot: bytesSha === (a.stored as unknown as { sha256: string }).sha256,
    bytesEqualAcrossRoots: bytesSha === sha(b.body),
    preparedHtmlEqual: a.prepHtmlSha === b.prepHtmlSha && a.prepHtmlSha === (a.stored as unknown as { preparedHtmlSha256: string }).preparedHtmlSha256,
    resultFieldsEqual: differingFields.length === 0,
    identityEqual: identityDiff.length === 0,
    outputHashEqualAndLot: a.r.outputHash === b.r.outputHash && a.r.outputHash === (a.stored as unknown as { outputHash: string }).outputHash,
    freshLotEntryEqualsStored_base: canon(a.fresh) === canon(a.stored), freshLotEntryEqualsStored_candidate: canon(b.fresh) === canon(b.stored),
    storedLotEntryEqualAcrossRoots: canon(a.stored) === canon(b.stored),
    legalStatusUnknown: a.r.parts.every((x: { legalStatus: string }) => x.legalStatus === 'unknown'),
    cellMatchesMandate: a.cell === cellId && b.cell === cellId,
  };
  const equivalent = Object.values(checks).every(Boolean);
  const apt = equivalent && a.assess.complete && b.assess.complete && !a.assess.bodyAbsent;
  const alreadyAccepted = A.acceptances.acceptances.some((x: { sampleId: string }) => x.sampleId === `rfb:${id}`);
  return {
    sampleId: `rfb:${id}`, cellId, cellDerived: a.cell, epigrafe: a.meta.identification?.epigrafe ?? null,
    provenance: { snapshot: `${a.dir}${id}.json`, url: a.meta.url ?? null, consultedAt: a.meta.consultedAt ?? null, origin: a.meta.origin ?? null, bytes: a.body.length, sha256: bytesSha },
    reading: { status: a.r.status, parts: a.r.parts.length, canonicalChars: a.r.canonicalText.length, outputHash: a.r.outputHash, preparedHtmlSha256: a.prepHtmlSha,
      partsCanonicalSha256: [partsKey(a.r), partsKey(b.r)], missingSegments: (a.stored as unknown as { missingSegments: number }).missingSegments },
    completeness: { complete: a.assess.complete, bodyAbsent: a.assess.bodyAbsent, readAttachments: a.assess.readAttachments, gaps: a.assess.gaps },
    checks, equivalent, entrySha256: { stored: a.storedEntrySha, recomputedBase: a.freshEntrySha, recomputedCandidate: b.freshEntrySha },
    alreadyAccepted, aptForReview: apt && !alreadyAccepted,
    proposedRecordNotRegistered: apt && !alreadyAccepted ? { sampleId: `rfb:${id}`, cellId, scope: 'offline', entrySha256: a.storedEntrySha, engineBuildHash: A.engine,
      note: 'NOT REGISTERED: proposal only; registration requires independent review and a later COORD decision' } : null,
  };
});
const cells = [...new Set(TARGETS.map((t) => t.cellId))].map((cellId) => {
  const ss = samples.filter((s) => s.cellId === cellId);
  return { cellId, samples: ss.map((s) => s.sampleId), aptSamples: ss.filter((s) => s.aptForReview).map((s) => s.sampleId),
    notApt: ss.filter((s) => !s.aptForReview).map((s) => ({ sampleId: s.sampleId, why: [...s.completeness.gaps, ...Object.entries(s.checks).filter(([, v]) => !v).map(([k]) => `check ${k} failed`)] })),
    aptForReview: ss.some((s) => s.aptForReview) };
});
const report = {
  schema: 'e9-a1-reading-proof/1', mandate: 'COORD → EXEC F1 | E9-A1', registersNothing: true,
  engines: { base: A.engine, candidate: B.engine, expected: EXPECTED_ENGINE, equal: A.engine === B.engine && A.engine === EXPECTED_ENGINE,
    storedLotEngine: [A.storedLot.engineBuildHash, B.storedLot.engineBuildHash] },
  acceptancesSha256: [sha(readFileSync(join(baseRoot, 'docs/anatomy/e9-acceptances.json'))), sha(readFileSync(join(candRoot, 'docs/anatomy/e9-acceptances.json')))],
  cells, samples,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
