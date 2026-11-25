import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnatomyResult } from '../../../../src/modules/anatomy/contract.js';

const [basePath, candidatePath, outputPath] = process.argv.slice(2);
if (!basePath || !candidatePath || !outputPath) throw new Error('usage: equivalence.mts BASE CANDIDATE OUTPUT_DIR');
const here = new URL('./inputs.json', import.meta.url);
const evidence = JSON.parse(readFileSync(here, 'utf8')) as {
  base: string; engine: string;
  samples: { id: string; source: string; path: string; meta: string; bytes: number; sha256: string; metaSha256: string; candidateMetaSha256?: string; expected: string }[];
};
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const stable = (value: unknown) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item, 2) + '\n';
const digest = (value: unknown) => sha(stable(value));
const root = 'ops/anatomy/official-identification';
const approvedDirs = new Set(['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c', 'doesp-ricms', 'leg-normas', 'manual', 'e9-http']);
const replace = (source: string, from: string, to: string) => {
  if (source.split(from).length !== 2) throw new Error('Cannot attach a unique observer to the canonical entry point');
  return source.replace(from, to);
};

function verifyInputs(dir: string, candidate: boolean) {
  const allowed = new Set(evidence.samples.flatMap((entry) => [entry.path, entry.meta]));
  for (const file of allowed) {
    const parts = file.split('/');
    if (parts.slice(0, 3).join('/') !== root || !approvedDirs.has(parts[3] ?? '') || parts.length !== 5 || !/^[a-zA-Z0-9_.-]+$/u.test(parts[4] ?? '')) throw new Error('Path outside E9 evidence');
    const resolved = realpathSync(join(dir, file));
    const expected = join(realpathSync(join(dir, root, parts[3]!)), parts[4]!);
    if (resolved !== expected || !resolved.startsWith(realpathSync(dir) + sep)) throw new Error('Evidence symlink refused');
  }
  for (const name of approvedDirs) {
    for (const file of readdirSync(join(dir, root, name))) {
      const isRfbInput = name.startsWith('rfb-') && /^\d+(?:\.meta)?\.json$/u.test(file);
      const isPortalMeta = !name.startsWith('rfb-') && /\.meta\.json$/u.test(file);
      if ((isRfbInput || isPortalMeta) && !allowed.has([root, name, file].join('/'))) throw new Error('Input not in manifest');
    }
  }
  for (const entry of evidence.samples) {
    const bytes = readFileSync(join(dir, entry.path));
    const metadata = readFileSync(join(dir, entry.meta));
    if (sha(metadata) !== (candidate ? entry.candidateMetaSha256 ?? entry.metaSha256 : entry.metaSha256)) throw Error('Metadata digest mismatch: ' + entry.id);
    const meta = JSON.parse(metadata.toString('utf8'));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256 || meta.sha256 !== entry.sha256 || meta.bytes !== entry.bytes) {
      throw new Error('Captured bytes or metadata differ for ' + entry.id);
    }
  }
}

function checkOperativeAncestry(id: string, parts: AnatomyResult['parts']) {
  const byId = new Map(parts.map(part => [part.id, part]));
  let operativeCandidates = 0;
  const prohibitedAncestorParts: string[] = [];
  for (const part of parts) {
    if (part.context !== 'operative_candidate') continue;
    operativeCandidates++;
    const seen = new Set([part.id]);
    for (let parentId = part.parentId; parentId !== null;) {
      const parent = byId.get(parentId);
      if (!parent || seen.has(parentId)) throw new Error('Invalid ancestry: ' + id + ' / ' + part.id);
      if (parent.context === 'prohibited') {
        prohibitedAncestorParts.push(part.id);
        break;
      }
      seen.add(parentId);
      parentId = parent.parentId;
    }
  }
  return { operativeCandidates, prohibitedAncestorParts };
}

async function probe(dir: string, isCandidate = false) {
  verifyInputs(dir, isCandidate);
  const start = performance.now();
  const reader = join(dir, 'ops/anatomy/official-lot-rfb.ts');
  const matrix = join(dir, 'ops/anatomy/official-coverage-matrix.ts');
  // Instrument a temporary sibling on each side. The probes only observe engine results and inject the freshly
  // generated lot into the matrix; the on-disk originals, snapshots, and historical acceptance ledger stay intact.
  const lotProbe = reader.replace(/\.ts$/u, '.e9-probe.ts');
  const matrixProbe = matrix.replace(/\.ts$/u, '.e9-probe.ts');
  let l = readFileSync(reader, 'utf8');
  let m = readFileSync(matrix, 'utf8');
  l = replace(l, "dirOrDirs: string | readonly string[] = LOT_DIRS):", 'dirOrDirs: string | readonly string[] = LOT_DIRS, observe?: (id: string, output: unknown) => void):');
  l = replace(l, '    const partTypes:', '    observe?.("rfb:" + id, r);\n    const partTypes:');
  m = replace(m, 'function readWith(', 'export let probeLot: any;\nexport let probeRead: (id: string, result: unknown) => void;\nexport function observe(lot: unknown, read: (id: string, result: unknown) => void) { probeLot = lot; probeRead = read; }\nfunction readWith(');
  m = replace(m, '  const broken: string[] = [];', '  probeRead?.(id, r);\n  const broken: string[] = [];');
  m = replace(m, "JSON.parse(readFileSync(LOT_BASELINE, 'utf8')) as { acts: LotAct[] }", 'probeLot as { acts: LotAct[] }');
  const touched: string[] = [];
  try {
    for (const [f, content] of [[lotProbe, l], [matrixProbe, m]] as const) {
      writeFileSync(f, content, { flag: 'wx' });
      touched.push(f);
    }
    const normalized = new Map<string, Record<string, string>>();
    const readings = new Map<string, { status: string; unidentified: number; limitations: string[]; quoteHash: string; operativeAncestry: ReturnType<typeof checkOperativeAncestry> }>();
    const { anatomyIdentityHash, anatomyOutputHash } = await import(pathToFileURL(join(dir, 'src/modules/anatomy/contract.ts')).href);
    const capture = (id: string, output: AnatomyResult) => {
      const neutral = structuredClone(output);
      if (anatomyOutputHash(output) !== output.outputHash) throw new Error('Invalid output hash: ' + id);
      if (output.parts.some((p: any) => p.legalStatus !== 'unknown' || (p.type === 'quoted_text' && p.context === 'operative_candidate')))
        throw Error('Legal status or quotation protection violated: ' + id);
      const quotes = output.parts.filter((p: any) => p.type === 'quoted_text').map((p: any) => [p.span, p.context, p.sourcePointers]);
      const unidentified = output.coverage.segments.filter((s: any) => s.classification === 'unidentified')
        .reduce((n: number, s: any) => n + s.span.end - s.span.start, 0);
      readings.set(id, { status: output.status, unidentified, quoteHash: digest(quotes),
        operativeAncestry: checkOperativeAncestry(id, output.parts),
        limitations: [...new Set<string>(output.limitations.map((l: any) => l.code))].sort() });
      neutral.identity.engineHash = 'NEUTRALIZED-ENGINE-IDENTITY';
      neutral.analysisId = anatomyIdentityHash(neutral.identity);
      neutral.outputHash = anatomyOutputHash(neutral);
      normalized.set(id, Object.fromEntries(Object.entries(neutral).map(([field, value]) => [field, digest(value)])));
    };
    const { analyzeLot } = await import(pathToFileURL(lotProbe).href);
    const lot = analyzeLot(undefined, capture);
    const { observe, collectSamples, samplesBaseline, buildMatrix, lotEntrySha256, baselineEntrySha256 } = await import(pathToFileURL(matrixProbe).href);
    observe(lot, capture);
    const first = collectSamples([], []);
    const baseline = samplesBaseline(first);
    const samples = collectSamples(baseline.samples);
    const projection = buildMatrix(samples);
    for (const [path, value] of [['official-lot-rfb.json', lot], ['official-samples-baseline.json', baseline],
      ['official-coverage-matrix.json', projection]] as const) {
      const stored = JSON.parse(readFileSync(join(dir, 'docs/anatomy', path), 'utf8'));
      if (digest(stored) !== digest(value)) throw Error('Committed projection is stale: ' + path);
    }
    const out = new Map(samples.map((s: any) => {
      const entry = lot.acts.find((a: any) => 'rfb:' + a.idAto === s.id);
      const baselineEntry = baseline.samples.find((a: any) => a.id === s.id);
      const cell = projection.cells.find((c: any) => c.validatedSamples?.includes(s.id))?.id ?? null;
      return [s.id, {
        sha256: s.sha256, bytes: s.bytes, profile: s.profile, size: s.size, cell,
        chars: s.chars, readingComplete: s.readingComplete ?? null, notes: s.notes,
        fields: normalized.get(s.id) ?? null, reading: readings.get(s.id) ?? null, outputHash: s.outputHash,
        entrySha256: entry ? lotEntrySha256(entry) : baselineEntry ? baselineEntrySha256(baselineEntry) : null,
        preparation: entry?.preparedHtmlSha256 ?? null,
        lotEvidence: entry ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'outputHash')) : null,
      }];
    }));
    if (out.size !== evidence.samples.length || evidence.samples.some((e) => !out.has(e.id))) throw new Error('Unexpected projection inventory');
    return { engine: lot.engineBuildHash, out, projection, ms: Math.round(performance.now() - start) };
  } finally {
    for (const file of touched) unlinkSync(file);
  }
}

const base = await probe(resolve(basePath));
const candidate = await probe(resolve(candidatePath), true);
if (base.engine !== evidence.engine || base.engine !== candidate.engine) throw new Error('Incorrect identities');
const samples = evidence.samples.map(e => {
  const before = base.out.get(e.id)!;
  const after = candidate.out.get(e.id)!;
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes || e.sha256 !== after.sha256) throw Error('Different input: ' + e.id);
  const a = before.fields ?? {};
  const b = after.fields ?? {};
  const changedFields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(k => !['analysisId', 'outputHash'].includes(k) && a[k] !== b[k]);
  const moved = ['profile', 'size', 'cell', 'chars', 'preparation', 'lotEvidence'].some(k => digest(before[k]) !== digest(after[k]));
  const expected = e.expected === 'manual_corroboration' && before.profile === 'SEFAZ-SP-PORTAL';
  const completenessChanged = before.readingComplete !== after.readingComplete;
  const unexpected = moved || changedFields.length > 0 || before.outputHash !== after.outputHash
    || before.entrySha256 !== after.entrySha256 || before.reading?.quoteHash !== after.reading?.quoteHash
    || (expected ? before.readingComplete !== false || after.readingComplete !== true : completenessChanged);
  const compact = ({ fields, lotEvidence, ...rest }: typeof before) => ({ ...rest, semanticSha256: digest(fields) });
  return { id: e.id, source: e.source, expected: e.expected, before: compact(before), after: compact(after), changedFields,
    verdict: unexpected ? 'unexpected' : completenessChanged ? 'intended' : 'equivalent' };
});

const ledgerPath = 'docs/anatomy/e9-acceptances.json';
const beforeLedger = readFileSync(join(basePath, ledgerPath));
const afterLedger = readFileSync(join(candidatePath, ledgerPath), 'utf8');
const prefix = beforeLedger.toString('utf8').replace(/\n  \]\n\}\n$/u, '');
if (afterLedger !== beforeLedger.toString('utf8') && !afterLedger.startsWith(prefix + ',\n')) throw Error('Acceptance history changed');
type Acceptance = { sampleId: string; cellId: string; entrySha256: string; engineBuildHash: string; scope: 'offline'; limits: string[] };
const historical = (JSON.parse(beforeLedger.toString('utf8')).acceptances as Acceptance[]);
const candidateRecords = (JSON.parse(afterLedger).acceptances as Acceptance[]);
const previous = historical.filter(r => r.engineBuildHash === base.engine);
if (historical.length !== 122 || previous.length !== 27 || new Set(previous.map(r => r.cellId)).size !== 24
  || digest(historical) !== digest(candidateRecords.slice(0, historical.length))) throw Error('Invalid acceptance history');
for (const row of previous) {
  const x = samples.find(s => s.id === row.sampleId);
  if (!x || x.verdict !== 'equivalent' || x.before.entrySha256 !== row.entrySha256 || !x.after.readingComplete)
    throw Error('Existing acceptance changed: ' + row.sampleId);
}
const cells = base.projection.cells.filter((c: any) => c.source === 'SEFAZ-SP-PORTAL' && c.validatedSamples.length).map((before: any) => {
  const after = candidate.projection.cells.find((c: any) => c.id === before.id);
  if (!after || digest(after.validatedSamples) !== digest(before.validatedSamples)) throw Error('Unexpected target inventory change: ' + before.id);
  return { id: before.id, before: before.complete, after: after.complete,
    supportingSamples: after.validatedSamples.filter((id: string) => !after.partialSamples.includes(id)),
    partialSamples: after.partialSamples };
});
if (cells.length !== 2 || base.projection.coveredRequired !== 29 || candidate.projection.coveredRequired !== 29
  || base.projection.cells.filter((c: any) => c.accepted).length !== 24
  || digest(base.projection.requiredPending) !== digest(candidate.projection.requiredPending)) throw Error('Unexpected coverage or acceptance totals');
const targets = samples.filter(s => ["ricms-art008","ricms-art009","ricms-an2art039","ricms-an2art003"].includes(s.id));
const bySource = Object.fromEntries([...new Set(samples.map(s => s.source))].sort().map(source => {
  const scoped = samples.filter(s => s.source === source);
  return [source, {
    equivalent: scoped.filter(s => s.verdict === 'equivalent').length,
    intended: scoped.filter(s => s.verdict === 'intended').length,
    unexpected: scoped.filter(s => s.verdict === 'unexpected').length,
  }];
}));
const appended = candidateRecords.slice(historical.length);
if (appended.length !== 4 || targets.length !== 4 || !targets.every(t => t.verdict === 'intended'
  && appended.some(a => a.sampleId === t.id && a.cellId === t.after.cell && a.entrySha256 === t.after.entrySha256
    && a.scope === 'offline' && a.engineBuildHash === candidate.engine))
  || candidate.projection.cells.filter((c: any) => c.accepted).length !== 26)
  throw Error('Candidate acceptances differ from proof');
const ancestry = (probe: Awaited<ReturnType<typeof probe>>) => {
  const readings = evidence.samples.map(({ id }) => ({ id, reading: probe.out.get(id)!.reading }));
  return {
    checkedReadings: readings.filter(({ reading }) => reading !== null).length,
    noEngineReading: readings.filter(({ reading }) => reading === null).map(({ id }) => id),
    operativeCandidates: readings.reduce((n, { reading }) => n + (reading?.operativeAncestry.operativeCandidates ?? 0), 0),
    violations: readings.flatMap(({ id, reading }) => (reading?.operativeAncestry.prohibitedAncestorParts ?? []).map(partId => ({ id, partId }))),
  };
};
const operativeAncestry = { base: ancestry(base), candidate: ancestry(candidate) };
for (const [side, result] of Object.entries(operativeAncestry)) {
  console.log('Operative ancestry:', side, result.checkedReadings + ' readings,',
    result.operativeCandidates + ' operative candidates,', result.violations.length + ' violations');
}
const reports = {
  'equivalence.json': { base: evidence.base, baseEngine: base.engine, candidateEngine: candidate.engine, samples, cells, bySource, operativeAncestry },
  'acceptance-proof.json': { originalLedgerSha256: sha(beforeLedger), preserved: historical.length, records: appended },
  'performance.json': { node: process.version, platform: process.platform, baseMilliseconds: base.ms,
    candidateMilliseconds: candidate.ms, combinedPeakRssKiB: process.resourceUsage().maxRSS },
};
for (const [name, value] of Object.entries(reports)) {
  const content = stable(value);
  writeFileSync(join(outputPath, name), content);
  if (name !== 'performance.json') console.log(name, sha(content));
}
console.log('Samples:', samples.reduce<Record<string, number>>((totals, sample) => {
  totals[sample.verdict] = (totals[sample.verdict] ?? 0) + 1;
  return totals;
}, {}));
if (samples.some(s => s.verdict === 'unexpected') || operativeAncestry.base.violations.length || operativeAncestry.candidate.violations.length) process.exitCode = 1;
