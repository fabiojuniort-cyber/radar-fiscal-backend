// E9-A3 (tribusca-control#116, COORD mandate "E9-A3 — Leituras parciais RFB já cobertas").
// Offline, read-only, deterministic. It REGISTERS NOTHING and changes no engine, matrix or acceptance file.
//
// Usage (from a checkout of main d53fb3e2, engine 4b96f977):
//   npx tsx ops/anatomy/e9-acervo/proposals/e9-a3/e9a3-partial-rfb-proof.mts <root> [out.json]
//
// For each of the five cells it (1) lists the covering samples and the exact reasons rfbReadingAssessment gives;
// (2) scans the WHOLE versioned RFB acervo (every snapshot folder the lot and the matrix read) for another sample of
// the same type and size whose reading is complete on the current engine; (3) re-proves each sample at the E9-A1
// rigor: bytes = meta = lot, fresh lot entry = stored lot entry (so entrySha256 is the stored digest), the exact
// unidentified text, limitations and the own-annex audit; (4) classifies APTA / PARCIAL / BLOQUEADA and names the
// remedy route (other sample = collection; engine = E9-M2/M3; tool = E9-M1).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [rootArg, out] = process.argv.slice(2);
if (!rootArg) throw new Error('usage: <root> [out.json]');
const root = resolve(rootArg);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const { prepareRfbRepresentation } = await import(join(root, 'src/modules/anatomy/json-preparation.ts'));
const { analyzeAnatomy } = await import(join(root, 'src/modules/anatomy/engine.ts'));
const { planRfbQuoteResume } = await import(join(root, 'src/modules/anatomy/rfb-quote-resume.ts'));
const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(root, 'src/modules/anatomy/build-identity.ts'));
const LOT = await import(join(root, 'ops/anatomy/official-lot-rfb.ts'));
const MX = await import(join(root, 'ops/anatomy/official-coverage-matrix.ts'));

const CELLS = ['rfb--instrucao-normativa--medio', 'rfb--ato-declaratorio-interpretativo--pequeno', 'rfb--ato-declaratorio-executivo--pequeno',
  'rfb--ato-declaratorio-executivo--medio', 'rfb--resolucao--pequeno'];
const stored = JSON.parse(readFileSync(join(root, 'docs/anatomy/official-lot-rfb.json'), 'utf8')) as { engineBuildHash: string; acts: Record<string, unknown>[] };
const fresh = LOT.analyzeLot() as { engineBuildHash: string; acts: Record<string, unknown>[] };
const samples = MX.collectSamples() as { id: string; source: string; type: string; size: string | null; readingComplete?: boolean | null; stages: Record<string, boolean>; notes: string[] }[];
const grid = MX.GRID as { id: string }[];
const cellOf = (s: (typeof samples)[number]) => grid.find((c) => MX.matches(c, s))?.id ?? null;

// (2) the whole versioned RFB acervo the lot reads (LOT_DIRS) — every sample, its cell and completeness
const acervo = samples.filter((s) => s.source === 'RFB').map((s) => ({ id: s.id, type: s.type, size: s.size, cell: cellOf(s), readingComplete: s.readingComplete ?? null }));

function prove(idStr: string, cellId: string) {
  const id = Number(idStr.slice(4));
  const dir = LOT.snapshotDirOf(id) as string;
  const body = readFileSync(join(dir, `${id}.json`));
  const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), 'utf8'));
  const st = stored.acts.find((a) => a.idAto === id)!; const fr = fresh.acts.find((a) => a.idAto === id)!;
  const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id);
  const r = analyzeAnatomy({ publicationVersionId: `rfb:${id}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
    input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html, rfbQuoteResume: planRfbQuoteResume({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id) },
    catalog: { edition: 'none', codes: [] } });
  const assess = MX.rfbReadingAssessment(st, body) as { complete: boolean; bodyAbsent: boolean; readAttachments: number; gaps: string[] };
  const audit = MX.annexAudit(body, new Map(((st.inlineAttachments as { read?: { id: number; sha256: string }[] })?.read ?? []).map((x) => [x.id, x.sha256]))) as { gaps: string[]; segments: { state: string }[] };
  const unidentified = r.parts.filter((x: any) => x.type === 'unidentified').map((x: any) => ({ chars: x.span.end - x.span.start, text: r.canonicalText.slice(x.span.start, x.span.end).replace(/\s+/gu, ' ').trim().slice(0, 240) }));
  const limitations: Record<string, number> = {}; for (const l of r.limitations) limitations[l.code] = (limitations[l.code] ?? 0) + 1;
  const prep = meta.preparation ?? {};
  const s = samples.find((x) => x.id === idStr)!;
  const checks = {
    bytesEqualMeta: sha(body) === meta.sha256 && body.length === meta.bytes,
    bytesEqualLot: sha(body) === st.sha256,
    freshLotEntryEqualsStored: canon(fr) === canon(st),
    outputHashEqualLot: r.outputHash === st.outputHash,
    preparedHtmlEqualLot: p.htmlSha256 === st.preparedHtmlSha256,
    legalStatusUnknown: r.parts.every((x: any) => x.legalStatus === 'unknown'),
    cellMatches: cellOf(s) === cellId,
    engineIsCurrent: stored.engineBuildHash === ANATOMY_ENGINE_BUILD_HASH,
  };
  const reproduced = Object.values(checks).every(Boolean);
  const classification = !reproduced ? 'BLOQUEADA' : assess.bodyAbsent ? 'BLOQUEADA' : assess.complete ? 'APTA' : 'PARCIAL';
  return {
    sampleId: idStr, cellId, epigrafe: meta.identification?.epigrafe ?? st.epigrafe, url: meta.url ?? null, consultedAt: meta.consultedAt ?? null, snapshot: `${dir.slice(dir.indexOf('ops/'))}${id}.json`,
    provenance: { bytes: body.length, sha256: sha(body) },
    entrySha256: { stored: MX.lotEntrySha256(st), recomputed: MX.lotEntrySha256(fr) },
    reading: { status: r.status, outputHash: r.outputHash, canonicalChars: r.canonicalText.length, parts: r.parts.length, unidentifiedChars: unidentified.reduce((a: number, x: { chars: number }) => a + x.chars, 0),
      unidentified, limitations, missingSegments: prep.missingSegments ?? [], attachments: (prep.attachments ?? []).length, annexAuditGaps: audit.gaps },
    rfbReadingAssessment: assess, checks, reproduced, classification,
  };
}

const cells = CELLS.map((cellId) => {
  const c = (MX.buildMatrix() as { cells: { id: string; validatedSamples: string[]; complete: boolean | null; partialSamples: string[] }[] }).cells.find((x) => x.id === cellId)!;
  const proofs = c.validatedSamples.map((sid) => prove(sid, cellId));
  const alternatives = acervo.filter((a) => a.cell === cellId && !c.validatedSamples.includes(a.id));
  return { cellId, matrix: { complete: c.complete, partialSamples: c.partialSamples }, samples: proofs,
    otherAcervoSamplesSameCell: alternatives, otherCompleteInAcervo: alternatives.filter((a) => a.readingComplete === true).map((a) => a.id),
    apt: proofs.filter((p) => p.classification === 'APTA').map((p) => p.sampleId) };
});

const report = {
  schema: 'e9-a3-partial-rfb-proof/1', mandate: 'COORD → EXEC F1 | E9-A3', base: 'main d53fb3e2b8d34b9fbeda4da6c5fbdf25a24c19e9', registersNothing: true,
  engine: ANATOMY_ENGINE_BUILD_HASH, acervoScanned: { folders: (LOT.LOT_DIRS as string[]).map((d) => d.slice(d.indexOf('ops/'))), rfbSamples: acervo },
  cells,
  proposedRecords: cells.flatMap((c) => c.samples.filter((s) => s.classification === 'APTA').map((s) => ({ sampleId: s.sampleId, cellId: c.cellId, scope: 'offline',
    entrySha256: s.entrySha256.stored, engineBuildHash: ANATOMY_ENGINE_BUILD_HASH }))),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, text); else process.stdout.write(text);
