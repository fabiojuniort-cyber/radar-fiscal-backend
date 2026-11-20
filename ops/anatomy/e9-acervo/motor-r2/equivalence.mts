import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [basePath, candidatePath, outputPath] = process.argv.slice(2);
if (!basePath || !candidatePath || !outputPath) throw new Error('usage: equivalence.mts BASE CANDIDATE OUTPUT_DIR');
const here = new URL('./inputs.json', import.meta.url);
const evidence = JSON.parse(readFileSync(here, 'utf8')) as {
  base: string; engine: string;
  samples: { id: string; source: string; path: string; meta: string; bytes: number; sha256: string; expected: string }[];
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
    const meta = JSON.parse(readFileSync(join(dir, entry.meta), 'utf8'));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256 || meta.sha256 !== entry.sha256 || meta.bytes !== entry.bytes) {
      throw new Error('Captured bytes or metadata differ for ' + entry.id);
    }
  }
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
    const normalized = new Map<string, Record<string, string>>();
    const { anatomyIdentityHash, anatomyOutputHash } = await import(pathToFileURL(join(dir, 'src/modules/anatomy/contract.ts')).href);
    const capture = (id: string, output: any) => {
      const neutral = structuredClone(output);
      if (anatomyOutputHash(output) !== output.outputHash) throw new Error('Invalid output hash: ' + id);
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
    const samples = collectSamples(baseline.samples, []);
    const projection = buildMatrix(samples);
    const out = new Map(samples.map((s: any) => {
      const entry = lot.acts.find((a: any) => 'rfb:' + a.idAto === s.id);
      const baselineEntry = baseline.samples.find((a: any) => a.id === s.id);
      const cell = projection.cells.find((c: any) => c.validatedSamples?.includes(s.id))?.id ?? null;
      return [s.id, {
        sha256: s.sha256, bytes: s.bytes, profile: s.profile, size: s.size, cell,
        chars: s.chars, readingComplete: s.readingComplete ?? null, notes: s.notes,
        fields: normalized.get(s.id) ?? null, outputHash: s.outputHash,
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
if (base.engine !== evidence.engine || base.engine === candidate.engine) throw new Error('Incorrect identities');
const samples = evidence.samples.map((e) => {
  const before = base.out.get(e.id)! as any;
  const after = candidate.out.get(e.id)! as any;
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw new Error('Different input: ' + e.id);
  const a = before.fields ?? {};
  const b = after.fields ?? {};
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => a[k] !== b[k]);
  const changedProjection = ['profile', 'size', 'cell', 'chars', 'readingComplete', 'preparation', 'lotEvidence'].filter(k => digest(before[k]) !== digest(after[k]));
  const semantic = changed.filter(k => k !== 'analysisId' && k !== 'outputHash');
  const changedOutsideScope = e.expected === 'IDENTITY_ONLY' && (semantic.length > 0 || changedProjection.length > 0);
  const loss = ['RFB_STRUCTURE', 'SEFAZ_STRUCTURE'].includes(e.expected) && semantic.some(k => ['canonicalText', 'sourceMap', 'identity'].includes(k));
  return { id: e.id, source: e.source, expected: e.expected, before, after, changedFields: semantic, changedProjection,
    verdict: changedOutsideScope || loss ? 'unexpected' : semantic.length || changedProjection.length ? 'intended' : 'equivalent' };
});
const currentIds = new Set([108391, 115131, 133898, 142967, 148693].map(id => 'rfb:' + id));
const ledgerPath = 'docs/anatomy/e9-acceptances.json';
const beforeLedger = readFileSync(join(basePath, ledgerPath));
const afterLedger = readFileSync(join(candidatePath, ledgerPath));
if (!beforeLedger.equals(afterLedger)) throw new Error('Acceptance ledger changed');
const revalidation = samples.filter(s => currentIds.has(s.id)).map(s => ({
  sampleId: s.id, scope: 'offline', cellId: s.after.cell, engineBuildHash: candidate.engine,
  entrySha256: s.after.entrySha256, priorEngineBuildHash: base.engine, priorEntrySha256: s.before.entrySha256,
  review: s.verdict === 'equivalent' && s.after.readingComplete && s.before.cell === s.after.cell ? 'proposed_append_only' : 'blocked',
}));
writeFileSync(join(outputPath, 'equivalence.json'), stable({ base: evidence.base, baseEngine: base.engine, candidateEngine: candidate.engine, samples }));
writeFileSync(join(outputPath, 'revalidation-proposal.json'), stable({ status: 'proposal_only', originalLedgerSha256: sha(beforeLedger), records: revalidation }));
writeFileSync(join(outputPath, 'performance.json'), stable({ node: process.version, platform: process.platform, baseMilliseconds: base.ms, candidateMilliseconds: candidate.ms, combinedPeakRssKiB: process.resourceUsage().maxRSS }));
console.log('equivalence SHA-256', sha(readFileSync(join(outputPath, 'equivalence.json'))));
console.log('Samples:', samples.reduce<Record<string, number>>((totals, sample) => {
  totals[sample.verdict] = (totals[sample.verdict] ?? 0) + 1;
  return totals;
}, {}));
if (samples.some(s => s.verdict === 'unexpected')) process.exitCode = 1;
