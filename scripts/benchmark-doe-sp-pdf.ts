import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { legacyPdfFixture } from '../test/doe-sp-legacy.pdf-fixtures.ts';

type Mode = 'current' | 'eager-control';
type Stage = 'baseline' | 'bootstrap' | 'first-use' | 'second-use';
type Sample = { stage: Stage; elapsedMs: number; rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; processMaxRss: number };
type Run = { mode: Mode; node: string; samples: Sample[] };
const extractorUrl = process.argv.find(argument => argument.startsWith('--module='))?.slice('--module='.length)
  ?? new URL('../dist/modules/collection/doe-sp-legacy.text.js', import.meta.url).href;

// Each run is a fresh process. Forced GC is outside elapsed times. maxRSS is the
// process high-water mark; the other memory counters are retained, not peaks.
function snapshot(stage: Stage, elapsedMs: number): Sample {
  if (!globalThis.gc) throw new Error('Run child with --expose-gc');
  globalThis.gc();
  globalThis.gc();
  return { stage, elapsedMs, ...process.memoryUsage(), processMaxRss: process.resourceUsage().maxRSS * 1024 };
}

async function child(mode: Mode): Promise<Run> {
  const pdf = legacyPdfFixture();
  const samples = [snapshot('baseline', 0)];
  let start = performance.now();
  // Models the previous eager dependency at bootstrap without maintaining a
  // second parser implementation. Both modes use exactly the current parser.
  if (mode === 'eager-control') await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { extractDoeSpLegacyPdfText } = await import(extractorUrl);
  samples.push(snapshot('bootstrap', performance.now() - start));
  for (const stage of ['first-use', 'second-use'] as const) {
    start = performance.now();
    const result = await extractDoeSpLegacyPdfText(pdf);
    const elapsedMs = performance.now() - start;
    assert.equal(result.extraction, 'PDF_NATIVE_TEXT');
    assert.equal(result.text, 'DOE SP synthetic text');
    assert.ok(pdf.byteLength > 0, 'The caller buffer must not be detached');
    samples.push(snapshot(stage, elapsedMs));
  }
  return { mode, node: process.version, samples };
}

if (process.argv.includes('--child')) {
  const mode = process.argv[process.argv.indexOf('--child') + 1];
  if (mode !== 'current' && mode !== 'eager-control') throw new Error('Invalid child mode');
  process.stdout.write(`${JSON.stringify(await child(mode))}\n`);
} else {
  const runs = Number(process.argv.find(argument => argument.startsWith('--runs='))?.split('=')[1] ?? 7);
  assert.ok(Number.isInteger(runs) && runs >= 3 && runs <= 100, '--runs must be between 3 and 100');
  const results: Run[] = [];
  // Alternate order to reduce warm filesystem / CPU order bias.
  for (let repetition = 0; repetition < runs; repetition += 1) {
    const modes: Mode[] = repetition % 2 === 0 ? ['eager-control', 'current'] : ['current', 'eager-control'];
    for (const mode of modes) {
      // Node 24 strips this harness's types natively. No tsx loader is installed
      // in the child: production pdf.js memory must not include transpilation.
      const moduleArgument = process.argv.find(argument => argument.startsWith('--module='));
      const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', mode, ...(moduleArgument ? [moduleArgument] : [])], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error(`Benchmark child failed: ${String(result.error ?? result.stderr)}`);
      results.push(JSON.parse(result.stdout.trim()) as Run);
    }
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  };
  const summary = (['eager-control', 'current'] as const).flatMap(mode => (['baseline', 'bootstrap', 'first-use', 'second-use'] as const).map(stage => {
    const matching = results.filter(result => result.mode === mode).map(result => result.samples.find(sample => sample.stage === stage)!);
    return {
      mode, stage,
      ...Object.fromEntries((['elapsedMs', 'rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'processMaxRss'] as const).map(key => [key, median(matching.map(sample => sample[key]))])),
    };
  }));
  const extractorSha256 = createHash('sha256').update(readFileSync(new URL(extractorUrl))).digest('hex');
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, extractorUrl, extractorSha256, runsPerMode: runs, summary, results }, null, 2)}\n`);
}
