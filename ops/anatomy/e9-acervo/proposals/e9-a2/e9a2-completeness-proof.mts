// E9-A2 (tribusca-control#116, COORD mandate "E9-A2 — Completude das células cobertas com complete=null").
// Offline, read-only, deterministic. It REGISTERS NOTHING and changes no engine, matrix or acceptance file.
//
// Usage (from a checkout of main d53fb3e2, engine 4b96f977):
//   npx tsx ops/anatomy/e9-acervo/proposals/e9-a2/e9a2-completeness-proof.mts <root> [out.json]
//
// For every sample covering the four cells it proves, with the matrix's own request (official-coverage-matrix.ts readWith):
//  (1) provenance: bytes = meta = samples baseline (sha256, byte count, profile, outputHash, chars);
//  (2) why the official matrix emits complete=null: the completeness assessment (readingComplete) and the acceptance
//      derivation exist only in the RFB branch of collectSamples; non-RFB samples never get readingComplete and carry a
//      hard-coded stages.accepted=false — so no record could ever turn these cells accepted today;
//  (3) reading completeness at the E9-A1 rigor: engine status, unidentified parts and characters, coverage
//      (textLength vs recognizedLength), non-blank unrecognized text inside the act span (page chrome outside it is
//      reported separately), limitations, material annexes recognized as annex parts;
//  (4) classification APTA / PARCIAL / BLOQUEADA with the evidence that decides it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [rootArg, out] = process.argv.slice(2);
const root = rootArg ? (await import('node:path')).resolve(rootArg) : '';
if (!rootArg) throw new Error('usage: <root> [out.json]');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const { analyzeAnatomy } = await import(join(root, 'src/modules/anatomy/engine.ts'));
const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(root, 'src/modules/anatomy/build-identity.ts'));
const { prepareSefazSpPortalPage } = await import(join(root, 'src/modules/anatomy/sefaz-sp-preparation.ts'));
const { decodeDeclared } = await import(join(root, 'ops/anatomy/official-manual-ingest.ts'));
const MX = await import(join(root, 'ops/anatomy/official-coverage-matrix.ts'));
const ID = join(root, 'ops/anatomy/official-identification');
const baseline = (JSON.parse(readFileSync(join(root, 'docs/anatomy/official-samples-baseline.json'), 'utf8')) as { samples: { id: string; sha256: string; profile: string; outputHash: string; chars: number }[] }).samples;
const matrix = JSON.parse(readFileSync(join(root, 'docs/anatomy/official-coverage-matrix.json'), 'utf8')) as { cells: { id: string; validatedSamples: string[]; complete: boolean | null; accepted: boolean }[] };
const matrixSrc = readFileSync(join(root, 'ops/anatomy/official-coverage-matrix.ts'), 'utf8');

const CELLS = ['confaz--convenio-icms--grande', 'confaz--ajuste-sinief--grande',
  'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--pequeno', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--medio'];

// Exactly the matrix request (readWith in ops/anatomy/official-coverage-matrix.ts).
const read = (source: string, id: string, html: string, extra: object = {}) => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-07',
  ruleSet: { id: 'official-coverage-matrix', version: '2' }, input: { source, representationId: id, html, ...extra }, catalog: { edition: 'none', codes: [] } });

function load(id: string): { snapshot: string; meta: Record<string, unknown> & { sha256: string; bytes: number }; bytes: Uint8Array; source: string; r: any } {
  if (id.startsWith('ricms-')) {
    const p = `ops/anatomy/official-identification/doesp-ricms/${id}`; const meta = JSON.parse(readFileSync(join(root, `${p}.meta.json`), 'utf8'));
    const bytes = MX.verifiedBytes(join(root, `${p}.html`), meta, id);
    const prep = prepareSefazSpPortalPage({ resourceId: meta.id, url: meta.url, bytes });
    return { snapshot: `${p}.html`, meta, bytes, source: 'SEFAZ-SP-PORTAL', r: read('SEFAZ-SP-PORTAL', id, prep.html, { sefazSpPortal: prep }) };
  }
  const http = id.startsWith('http:'); const item = http ? id.slice(5) : id; const dir = http ? 'e9-http' : 'manual';
  const meta = JSON.parse(readFileSync(join(ID, dir, `${item}.meta.json`), 'utf8'));
  const bytes = MX.verifiedBytes(join(ID, dir, meta.fileName), meta, id);
  return { snapshot: `ops/anatomy/official-identification/${dir}/${meta.fileName}`, meta, bytes, source: 'CONFAZ', r: read('CONFAZ', id, decodeDeclared(bytes, meta.declaredCharset)) };
}

const DISPOSITIVE = new Set(['article', 'caput', 'clause', 'paragraph', 'inciso', 'alinea', 'item', 'annex', 'table', 'row', 'cell', 'preamble', 'epigraph', 'summary', 'signature', 'quoted_text', 'group', 'body']);
const samples = CELLS.flatMap((cellId) => matrix.cells.find((c) => c.id === cellId)!.validatedSamples.map((sid) => ({ cellId, sid }))).map(({ cellId, sid }) => {
  const { snapshot, meta, bytes, source, r } = load(sid);
  const b = baseline.find((x) => x.id === sid)!;
  const types: Record<string, number> = {}; let unidentifiedChars = 0;
  for (const p of r.parts) { types[p.type] = (types[p.type] ?? 0) + 1; if (p.type === 'unidentified') unidentifiedChars += p.span.end - p.span.start; }
  const limitations: Record<string, number> = {}; for (const l of r.limitations) limitations[l.code] = (limitations[l.code] ?? 0) + 1;
  // act span = first..last recognized structural part (page chrome of the CMS lies outside it)
  const act = r.parts.filter((p: any) => DISPOSITIVE.has(p.type));
  const lo = act.length ? Math.min(...act.map((p: any) => p.span.start)) : 0; const hi = act.length ? Math.max(...act.map((p: any) => p.span.end)) : 0;
  const unrec = r.coverage.segments.filter((s: any) => s.classification !== 'recognized').map((s: any) => ({ s, text: r.canonicalText.slice(s.span.start, s.span.end) }))
    .filter((x: any) => x.text.trim());
  const inAct = unrec.filter((x: any) => x.s.span.start >= lo && x.s.span.end <= hi);
  const outAct = unrec.filter((x: any) => !(x.s.span.start >= lo && x.s.span.end <= hi));
  const nonWs = (xs: any[]) => xs.reduce((a: number, x: any) => a + x.text.replace(/\s+/gu, '').length, 0);
  const engineComplete = r.status === 'complete' && unidentifiedChars === 0 && Object.keys(limitations).length === 0;
  const fullyUnidentified = act.length === 0 || (types.unidentified === 1 && r.parts.length <= 2);
  const classification = fullyUnidentified ? 'BLOQUEADA' : engineComplete ? 'APTA' : 'PARCIAL';
  return {
    sampleId: sid, cellId, source, snapshot, url: (meta.url as string) ?? null, capturedAt: (meta.retrievedAt ?? meta.consultedAt ?? meta.capturedAt ?? null) as string | null,
    provenance: { bytes: bytes.byteLength, sha256: sha(bytes), metaSha256: meta.sha256, metaBytes: meta.bytes,
      bytesEqualMeta: sha(bytes) === meta.sha256 && bytes.byteLength === meta.bytes,
      baseline: b ?? null, bytesEqualBaseline: !!b && b.sha256 === sha(bytes), outputHashEqualBaseline: !!b && b.outputHash === r.outputHash, charsEqualBaseline: !!b && b.chars === r.canonicalText.length,
      baselineEntrySha256: b ? sha(canon(b)) : null },
    reading: { status: r.status, outputHash: r.outputHash, canonicalChars: r.canonicalText.length, recognizedChars: r.coverage.recognizedLength, accountedChars: r.coverage.accountedLength,
      parts: r.parts.length, partTypes: types, unidentifiedParts: types.unidentified ?? 0, unidentifiedChars, limitations,
      legalStatusUnknown: r.parts.every((p: any) => p.legalStatus === 'unknown'), annexParts: types.annex ?? 0,
      actSpan: [lo, hi],
      unrecognizedInsideAct: { segments: inAct.length, nonWhitespaceChars: nonWs(inAct), text: inAct.map((x: any) => x.text.replace(/\s+/gu, ' ').trim().slice(0, 200)) },
      unrecognizedOutsideAct: { segments: outAct.length, nonWhitespaceChars: nonWs(outAct) } },
    engineComplete, classification,
  };
});

const report = {
  schema: 'e9-a2-completeness-proof/1', mandate: 'COORD → EXEC F1 | E9-A2', base: 'main d53fb3e2b8d34b9fbeda4da6c5fbdf25a24c19e9', registersNothing: true,
  engine: ANATOMY_ENGINE_BUILD_HASH,
  whyCompleteIsNull: {
    readingCompleteOnlyForRfb: /sample\.readingComplete = inLot/u.test(matrixSrc) && (matrixSrc.match(/readingComplete = (?!=)/gu) ?? []).length === 1,
    acceptedDerivedFromAcceptancesOnlyForRfb: (matrixSrc.match(/stages\.accepted = /gu) ?? []).length === 1 && /sample\.stages\.accepted = inLot/u.test(matrixSrc),
    literalAcceptedFalseStages: (matrixSrc.match(/accepted: false \}/gu) ?? []).length,
    rule: 'buildMatrix: complete = null when every validated sample has readingComplete null/undefined; only the RFB branch of collectSamples assigns readingComplete and derives stages.accepted from e9-acceptances.json',
  },
  cells: CELLS.map((cellId) => { const c = matrix.cells.find((x) => x.id === cellId)!; const ss = samples.filter((s) => s.cellId === cellId);
    return { cellId, matrixComplete: c.complete, matrixAccepted: c.accepted, samples: ss.map((s) => `${s.sampleId}: ${s.classification}`),
      apt: ss.filter((s) => s.classification === 'APTA').map((s) => s.sampleId) }; }),
  samples,
  proposedRecords: [] as unknown[],
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
