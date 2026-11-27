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
  samples: { id: string; source: string; path: string; meta: string; bytes: number; sha256: string; metaSha256: string;
    expected: string; prohibitedParts?: string[]; candidateSemanticSha256?: string }[];
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

function verifyInputs(dir: string) {
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
    if (sha(metadata) !== entry.metaSha256) throw Error('Metadata digest mismatch: ' + entry.id);
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

async function probe(dir: string) {
  verifyInputs(dir);
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
    const parts = new Map<string, AnatomyResult['parts']>();
    const normalized = new Map<string, Record<string, string>>();
    const readings = new Map<string, { status: string; unidentified: number; limitations: string[]; quoteHash: string; operativeAncestry: ReturnType<typeof checkOperativeAncestry> }>();
    const { anatomyIdentityHash, anatomyOutputHash } = await import(pathToFileURL(join(dir, 'src/modules/anatomy/contract.ts')).href);
    const capture = (id: string, output: AnatomyResult) => {
      parts.set(id, output.parts);
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
        fields: normalized.get(s.id) ?? null, parts: parts.get(s.id) ?? [], reading: readings.get(s.id) ?? null, outputHash: s.outputHash,
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
const candidate = await probe(resolve(candidatePath));
if (base.engine !== evidence.engine || base.engine === candidate.engine) throw new Error('Incorrect engine identities');
const allowedFields = new Set(['parts', 'eligibility']);
const samples = evidence.samples.map(e => {
  const before = base.out.get(e.id)!;
  const after = candidate.out.get(e.id)!;
  const changedFields = [...new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields ?? {})])].sort()
    .filter(field => field !== 'outputHash' && before.fields?.[field] !== after.fields?.[field]);
  const originalParts = new Map(before.parts.map(part => [part.id, part]));
  const planalto = e.source === 'Planalto' && before.profile === 'PLANALTO';
  const partChanges = planalto ? after.parts.flatMap(part => {
    const prior = originalParts.get(part.id);
    if (digest(prior ?? null) === digest(part)) return [];
    const reason = part.contextReasons.at(-1) ?? null;
    const shapeUnchanged = !!prior
      && digest({ ...part, context: prior.context, contextReasons: prior.contextReasons, ruleId: prior.ruleId }) === digest(prior);
    const markerChanged = reason === 'planalto_repealed_placeholder' && part.contextReasons.length === 1
      && part.ruleId === 'reader/v1/planalto_repealed_placeholder'
      && (digest(prior?.contextReasons) === digest(['inciso_marker']) || digest(prior?.contextReasons) === digest(['paragraph_marker']));
    const inheritedGuard = reason === 'planalto_prohibited_ancestor'
      && part.ruleId === prior?.ruleId
      && digest(part.contextReasons.slice(0, -1)) === digest(prior?.contextReasons);
    const safe = shapeUnchanged && prior?.context === 'operative_candidate' && part.context === 'prohibited'
      && (markerChanged || inheritedGuard);
    return [{ id: part.id, label: part.label, span: part.span, reason, safe }];
  }) : [];
  const unchanged = ['sha256', 'bytes', 'profile', 'size', 'cell', 'chars', 'notes', 'preparation', 'lotEvidence', 'readingComplete']
    .every(key => digest(before[key]) === digest(after[key]))
    && before.reading?.status === after.reading?.status && before.reading?.unidentified === after.reading?.unidentified
    && before.reading?.quoteHash === after.reading?.quoteHash
    && digest(before.reading?.limitations ?? null) === digest(after.reading?.limitations ?? null);
  const identical = unchanged && changedFields.length === 0;
  const expectedPlanalto = e.expected === 'planalto_repeal_placeholder' && planalto;
  const expectedConfaz = e.expected === 'confaz_proven_region_or_caption' && e.source === 'CONFAZ';
  const planaltoDelta = expectedPlanalto && unchanged && changedFields.includes('parts')
    && changedFields.every(field => allowedFields.has(field)) && before.parts.length === after.parts.length
    && partChanges.every(change => change.safe)
    && digest(partChanges.map(change => change.id)) === digest(e.prohibitedParts ?? []);
  const compact = ({ fields, parts: _parts, lotEvidence: _lotEvidence, ...rest }: typeof before) =>
    ({ ...rest, semanticSha256: digest(fields) });
  const confazDelta = expectedConfaz && before.profile === after.profile && before.size === after.size
    && before.cell === after.cell && before.readingComplete === false
    && after.reading?.unidentified === 0 && changedFields.length > 0
    && after.readingComplete === (e.id !== 'http:M3')
    && compact(after).semanticSha256 === e.candidateSemanticSha256;
  const unchangedInput = before.sha256 === after.sha256 && before.sha256 === e.sha256
    && before.bytes === after.bytes && before.bytes === e.bytes;
  return { id: e.id, source: e.source, expected: e.expected, before: compact(before), after: compact(after),
    changedFields, partChanges, verdict: unchangedInput && (planaltoDelta || confazDelta) ? 'intended'
      : unchangedInput && e.expected === 'equivalent' && identical ? 'equivalent' : 'unexpected' };
});

const ledgerPath = 'docs/anatomy/e9-acceptances.json';
const beforeLedger = readFileSync(join(basePath, ledgerPath), 'utf8');
const afterLedger = readFileSync(join(candidatePath, ledgerPath), 'utf8');
const prefix = beforeLedger.replace(/\n  \]\n\}\n$/u, '');
type Acceptance = { sampleId: string; cellId: string; entrySha256: string; engineBuildHash: string; scope: 'offline'; limits: string[] };
const original = JSON.parse(beforeLedger).acceptances as Acceptance[];
const all = JSON.parse(afterLedger).acceptances as Acceptance[];
const previous = original.filter(record => record.engineBuildHash === base.engine);
const appended = all.slice(original.length);
if (!afterLedger.startsWith(prefix + ',\n') || original.length !== 126 || previous.length !== 31
  || appended.length !== previous.length || digest(all.slice(0, original.length)) !== digest(original))
  throw new Error('Acceptance ledger is not append-only');
const revalidated = previous.map(prior => {
  const sample = samples.find(row => row.id === prior.sampleId);
  const next = appended.find(row => row.sampleId === prior.sampleId);
  const validLimits = next?.limits[0]?.startsWith('Escopo offline:') && next.limits[1]?.startsWith('Layout:')
    && next.limits.some(limit => limit.includes('legalStatus permanece unknown'))
    && next.limits.some(limit => limit.includes(candidate.engine))
    && next.limits.some(limit => limit.includes('revisão independente e autorização'));
  if (!sample || !next || sample.before.entrySha256 !== prior.entrySha256 || !sample.before.readingComplete
    || !sample.after.readingComplete || sample.after.cell !== prior.cellId || next.cellId !== prior.cellId
    || next.entrySha256 !== sample.after.entrySha256 || next.engineBuildHash !== candidate.engine || next.scope !== 'offline'
    || !validLimits) throw new Error('Acceptance cannot be revalidated: ' + prior.sampleId);
  return { sampleId: prior.sampleId, cellId: prior.cellId, beforeEntrySha256: prior.entrySha256,
    afterEntrySha256: next.entrySha256, beforeStatus: sample.before.reading?.status, afterStatus: sample.after.reading?.status };
});
const accepted = (projection: typeof base.projection) => projection.cells.filter(cell => cell.accepted).map(cell => cell.id);
if (accepted(base.projection).length !== 26 || digest(accepted(base.projection)) !== digest(accepted(candidate.projection))
  || candidate.projection.coveredRequired !== 29 || candidate.projection.requiredPending.length !== 32
  || digest(base.projection.requiredPending) !== digest(candidate.projection.requiredPending))
  throw new Error('Unexpected change to the coverage cells');

const cells = base.projection.cells.filter(cell => cell.partialSamples.length).map(before => {
  const cell = candidate.projection.cells.find(row => row.id === before.id)!;
  return { id: cell.id, accepted: cell.accepted, support: cell.validatedSamples.filter(id => !cell.partialSamples.includes(id)),
  priorPartials: before.partialSamples.map(id => {
    const sample = samples.find(row => row.id === id)!;
    return { id, complete: sample.after.readingComplete, reading: sample.after.reading?.status,
      unidentified: sample.after.reading?.unidentified, gaps: sample.after.notes };
  }) };
});
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
const totals = ['equivalent', 'intended', 'unexpected'].map(verdict => [verdict, samples.filter(sample => sample.verdict === verdict).length]);
const reports = {
  'equivalence.json': { base: evidence.base, baseEngine: base.engine, candidateEngine: candidate.engine,
    totals: Object.fromEntries(totals), samples, cells, operativeAncestry },
  'revalidation-proof.json': { originalLedgerSha256: sha(beforeLedger), preserved: original.length, records: revalidated },
  'performance.json': { node: process.version, platform: process.platform, baseMilliseconds: base.ms,
    candidateMilliseconds: candidate.ms, combinedPeakRssKiB: process.resourceUsage().maxRSS },
};
for (const [name, value] of Object.entries(reports)) {
  const content = stable(value);
  writeFileSync(join(outputPath, name), content);
  if (name !== 'performance.json') console.log(name, sha(content));
}
console.log(Object.fromEntries(totals));
if (operativeAncestry.base.checkedReadings !== 48 || operativeAncestry.candidate.checkedReadings !== 48
  || operativeAncestry.base.violations.length || operativeAncestry.candidate.violations.length
  || samples.some(s => s.verdict === 'unexpected')) process.exitCode = 1;
