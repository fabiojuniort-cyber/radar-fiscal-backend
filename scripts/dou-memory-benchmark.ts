/** Offline comparative benchmark; no network, database, credentials or forced GC
 * during collection. Each workload/mode runs in an isolated child process. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DouConnector, DOU_XML_SECTIONS } from '../src/modules/collection/dou.connector.js';
import { executeConnector } from '../src/modules/collection/connector.executor.js';
import { createCollectionMemoryProbe } from '../src/modules/collection/collection.memory.js';
import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import type { PublicationSpoolFilesystem } from '../src/modules/collection/publication-spool.filesystem.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { makeZip } from '../test/dou.fixtures.js';
import { createPackageMemoryRecorder } from './dou-memory-trend.js';

const child = process.argv.includes('--child');
if (!child) {
  const results: unknown[] = [];
  for (const packages of [1, 4, 8, 16]) {
    for (const mode of ['array', 'spool']) {
      const run = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--child', mode, String(packages)], { encoding: 'utf8' });
      if (run.error || run.status !== 0 || !run.stdout.trim()) throw new Error(`benchmark child failed (${run.error?.message ?? run.stderr}); in restricted environments run --child array|spool 1|4|8|16 directly`);
      const result = JSON.parse(run.stdout.trim());
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  for (let i = 0; i < results.length; i += 2) {
    const array = results[i] as {
      digest: string; publications: number;
      afterPackages: Array<{ packageIndex: number; publications: number; xmlEntries: number }>;
    };
    const spool = results[i + 1] as typeof array;
    if (array.digest !== spool.digest || array.publications !== spool.publications) throw new Error('benchmark semantic mismatch');
    if (array.afterPackages.length !== spool.afterPackages.length || array.afterPackages.some((sample, index) => {
      const other = spool.afterPackages[index]!;
      return sample.packageIndex !== other.packageIndex || sample.publications !== other.publications || sample.xmlEntries !== other.xmlEntries;
    })) throw new Error('benchmark per-package semantic mismatch');
  }
} else {
  const mode = process.argv[process.argv.indexOf('--child') + 1]!;
  const packageCount = Number(process.argv[process.argv.indexOf('--child') + 2]);
  if (mode !== 'array' && mode !== 'spool') throw new Error('benchmark mode must be array or spool');
  if (![1, 4, 8, 16].includes(packageCount)) throw new Error('benchmark packages must be 1, 4, 8 or 16');
  // The harness alone retains this bounded history. The production probe stays
  // stateless; timer and non-package samples are never added to this recorder.
  const packageMemory = createPackageMemoryRecorder(packageCount);
  const publicationsPerPackage = Number(process.env.BENCH_PUBLICATIONS ?? 64);
  const textCharacters = Number(process.env.BENCH_TEXT_CHARACTERS ?? 32768);
  const slowSinkMs = Number(process.env.BENCH_SINK_DELAY_MS ?? 1);
  const dates = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'].slice(0, Math.ceil(packageCount / 4));
  const archives = new Map<string, Buffer>();
  let ordinal = 0;
  for (const date of dates) for (const section of DOU_XML_SECTIONS) {
    if (ordinal++ >= packageCount) break;
    const body = 'Texto normativo de referência para aferição de memória. '.repeat(Math.ceil(textCharacters / 56)).slice(0, textCharacters);
    const brazilDate = date.split('-').reverse().join('/');
    const entries = Array.from({ length: publicationsPerPackage }, (_, i) => ({
      name: `515_${date.replaceAll('-', '')}_${10000 + i}.xml`,
      bytes: Buffer.from(`<xml><article id="${10000 + i}" idMateria="${10000 + i}" pubDate="${brazilDate}" pubName="${section}" editionNumber="180" artCategory="Ministério da Fazenda" artType="PORTARIA" numberPage="1" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=${brazilDate}&amp;jornal=515&amp;pagina=1"><body><Identifica>PORTARIA Nº ${10000 + i}, DE 18 DE SETEMBRO DE 2026</Identifica><Ementa/><Texto><![CDATA[<p>${body}</p>]]></Texto></body></article></xml>`),
    }));
    archives.set(`${date}-${section}.zip`, await makeZip(entries));
  }
  const fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/logar.php') return new Response(null, { status: 302, headers: { location: 'index.php', 'set-cookie': 'inlabs_session_cookie=fixture' } });
    const name = url.searchParams.get('dl');
    if (!name) return new Response('<html>Index</html>');
    const bytes = archives.get(name);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  global.gc?.();
  const start = process.memoryUsage();
  const peak = { ...start };
  let sampleCount = 0;
  let spoolFilesystem: PublicationSpoolFilesystem | undefined;
  const memory = createCollectionMemoryProbe(sample => {
    sampleCount++;
    packageMemory.record(sample, performance.now() - startedAt);
    if (sample.phase === 'spool_ready' && sample.spoolFilesystem && sample.spoolStorage && sample.spoolFilesystemProbe) {
      spoolFilesystem = {
        spoolFilesystem: sample.spoolFilesystem, spoolStorage: sample.spoolStorage,
        spoolFilesystemProbe: sample.spoolFilesystemProbe,
        ...(sample.spoolFreeBytes !== undefined ? { spoolFreeBytes: sample.spoolFreeBytes } : {}),
      };
    }
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'] as const) peak[key] = Math.max(peak[key], sample[key]);
  });
  const timer = setInterval(() => memory('persist_progress'), 10);
  const digest = createHash('sha256');
  let publications = 0;
  let spoolBytes = 0;
  const startedAt = performance.now();
  const connector = new DouConnector({ credentials: () => ({ email: 'fixture@example.invalid', password: 'fixture' }), fetch, dates, now: () => new Date('2026-09-22T12:00:00Z') });
  const consume = async (publication: ConnectorPublication) => {
    const normalized = normalizePublication({ sourceId: 'benchmark', publication });
    digest.update(JSON.stringify(normalized));
    publications++;
    if (slowSinkMs > 0) await delay(slowSinkMs);
  };
  try {
    if (mode === 'array') {
      memory('collect_start');
      const result = await connector.collect({ sourceId: 'benchmark', runId: 'run', attemptId: 'attempt', signal: new AbortController().signal, memory });
      memory('collect_complete');
      for (const publication of result.publications) await consume(publication);
    } else {
      const outcome = await executeConnector({ connector, sourceId: 'benchmark', runId: 'run', attemptId: 'attempt', timeoutMs: 120_000, memory });
      if (!outcome.ok) throw new Error(outcome.code);
      const stream = outcome.result.publicationStream!;
      spoolBytes = stream.bytes;
      try { for await (const publication of stream) await consume(publication); }
      finally { await stream.dispose(); }
    }
    memory('cleanup');
    const packageTrace = packageMemory.summarize();
    if (publications !== packageCount * publicationsPerPackage || packageTrace.afterPackages.some(sample =>
      sample.publications !== sample.packageIndex * publicationsPerPackage
      || sample.xmlEntries !== sample.packageIndex * publicationsPerPackage)) {
      throw new Error('benchmark did not observe every expected synthetic publication after each package');
    }
    process.stdout.write(JSON.stringify({ mode, packages: packageCount, publicationsPerPackage, textCharacters, slowSinkMs, publications, spoolBytes,
      durationMs: Math.round(performance.now() - startedAt), start, peak, sampleCount, spoolFilesystem,
      ...packageTrace,
      digest: digest.digest('hex') }) + '\n');
  } finally { clearInterval(timer); }
}
