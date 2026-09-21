import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import type { DouXmlEntry, DouArchiveContext } from '../src/modules/collection/dou.parser.js';
export const fixtureDir = new URL('./fixtures/dou/', import.meta.url);
export async function fixtureEntries(section: string): Promise<DouXmlEntry[]> {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureDir), 'utf8'));
  return Promise.all(manifest.filter((r: { section: string }) => r.section === section).map(async (r: { filename: string; rawSha256: string }) => {
    const bytes = await readFile(new URL(r.filename, fixtureDir));
    if (createHash('sha256').update(bytes).digest('hex') !== r.rawSha256) throw new Error('Real fixture bytes changed');
    return { name: r.filename, bytes };
  }));
}
export function archiveContext(section: string): DouArchiveContext {
  const filename = `2026-09-18-${section}.zip`;
  return { date: '2026-09-18', section, filename, officialUrl: 'https://inlabs.in.gov.br/index.php?p=2026-09-18&dl='+filename, rawSha256: 'a'.repeat(64) };
}
export function makeZip(entries: DouXmlEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) zip.addBuffer(Buffer.from(entry.bytes), entry.name, {mtime:new Date('2026-09-18T12:00:00Z')});
    zip.end();
  });
}
export async function fixtureFetch(changed = false): Promise<typeof fetch> {
  const archives = new Map<string, Buffer>();
  for (const section of ['DO1', 'DO1E']) {
    let entries = await fixtureEntries(section);
    if (changed && section === 'DO1E') entries = entries.map(e => e.name === '600_20260918_24382325.xml'
      ? { ...e, bytes: Buffer.from(Buffer.from(e.bytes).toString('utf8').replace('Tendo em vista', 'Texto modificado em teste. Tendo em vista')) } : e);
    archives.set(`2026-09-18-${section}.zip`, await makeZip(entries));
  }
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/logar.php') return new Response(null, { status: 302, headers: { location: 'index.php', 'set-cookie': 'inlabs_session_cookie=test' } });
    if (new Headers(init?.headers).get('cookie') !== 'inlabs_session_cookie=test') return new Response(null, { status: 401 });
    const dl = url.searchParams.get('dl');
    if (!dl) return new Response('<html>Index</html>');
    const bytes = archives.get(dl);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  }) as typeof fetch;
}
