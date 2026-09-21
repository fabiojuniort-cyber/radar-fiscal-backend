import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDouEntries, readDouZip, classifyDouAct } from '../src/modules/collection/dou.parser.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { fixtureEntries, makeZip, archiveContext } from './dou.fixtures.js';

test('real XML preserves date, category, numbering, content and certified page without inventing HTML links', async () => {
  const entries = await fixtureEntries('DO1'); const result = parseDouEntries(entries, archiveContext('DO1'));
  assert.deepEqual(result.partialFailures, []); assert.equal(result.publications.length, 4);
  const p = result.publications.find(p => p.actNumber === '119/2026')!;
  assert.ok(p); assert.equal(p.actType, 'ATO DECLARATÓRIO EXECUTIVO COANA');
  assert.equal(p.publishedAt?.toISOString(), '2026-09-18T00:00:00.000Z');
  assert.match(p.agency!, /Receita Federal/); assert.match(p.officialUrl, /pesquisa.in.gov.br/);
  assert.ok(p.content!.length > 400); assert.equal((p.metadata!.dou as any).officialHtmlUrl, null);
  assert.equal(p.metadata!.officialUrlGranularity, 'PAGE');
  const correction = result.publications.find(p => p.actType === 'RETIFICAÇÃO')!;
  assert.equal(correction.actNumber, undefined);
  assert.equal(normalizePublication({ sourceId: 'dou', publication: correction }).identityStrength, 'SOURCE_SCOPED');
});

test('real extra multipart article assembles in numeric order and distinct dispatches retain separate identities on same page', async () => {
  const entries = await fixtureEntries('DO1E'); const r = parseDouEntries(entries.reverse(), archiveContext('DO1E'));
  assert.deepEqual(r.partialFailures, []); assert.equal(r.publications.length, 6);
  const p = r.publications.find(p => p.actNumber === '4940/2026')!;
  assert.ok(p); const data = p.metadata!.dou as any;
  assert.equal(data.edition, '177-C'); assert.equal(data.parts.length, 3); assert.equal(data.certifiedPageUrls.length, 3);
  assert.equal(data.parts[0].attributes.idMateria, '24378456');
  assert.deepEqual(data.parts.map((p: any) => p.attributes.id), ['51348697','51348700','51348703']);
  const dispatches = r.publications.filter(p => p.title === 'DESPACHO DE 17 DE SETEMBRO DE 2026');
  assert.equal(dispatches.length, 3); assert.equal(new Set(dispatches.map(p => p.officialUrl)).size, 1);
  assert.equal(new Set(dispatches.map(p => normalizePublication({sourceId:'dou',publication:p}).identityHash)).size, 3);
});

test('missing/corrupted continuation rejects the entire matter while preserving other real articles', async () => {
  const entries = (await fixtureEntries('DO1E')).filter(e => !e.name.endsWith('24378456-2.xml'));
  const result = parseDouEntries(entries, archiveContext('DO1E'));
  assert.equal(result.publications.length, 5); assert.equal(result.partialFailures[0]?.code, 'DOU_MISSING_OR_DUPLICATE_PART');
  const all = await fixtureEntries('DO1E');
  const broken = all.map(e => e.name.endsWith('24378456-2.xml') ? {...e, bytes: Buffer.from('<xml>broken')} : e);
  const r = parseDouEntries(broken, archiveContext('DO1E'));
  assert.equal(r.publications.length, 5); assert.equal(r.partialFailures[0]?.code, 'DOU_INVALID_XML');
});

test('ZIP boundaries, CRC, empty/corrupted archive and cancellation are enforced', async () => {
  const entries = await fixtureEntries('DO1'); const zip = await makeZip([...entries, {name:'image.jpg',bytes:Buffer.from('image fixture')}]);
  const r = await readDouZip(zip, new AbortController().signal);
  assert.equal(r.entries.length, 4); assert.equal(r.mediaCount, 1);
  await assert.rejects(readDouZip(Buffer.from('not zip'), new AbortController().signal));
  const controller = new AbortController(); controller.abort(); await assert.rejects(readDouZip(zip, controller.signal));
  const nested = await makeZip([{name:'nested/file.xml',bytes:Buffer.from('<xml/>')}]);
  await assert.rejects(readDouZip(nested, new AbortController().signal), /DOU_UNSAFE_ZIP_PATH/);
  const corrupt = Buffer.from(zip); const offset = corrupt.indexOf(Buffer.from([0x50,0x4b,1,2])); corrupt.writeUInt32LE(0, offset+16);
  await assert.rejects(readDouZip(corrupt, new AbortController().signal), /DOU_ZIP_CRC_MISMATCH/);
});

test('DTD, mismatched archive date and foreign certified URL fail conservatively', async () => {
  const [entry] = await fixtureEntries('DO1'); assert.ok(entry);
  const withText = (text: string) => [{...entry,bytes:Buffer.from(text)}];
  const xml = Buffer.from(entry.bytes).toString('utf8');
  assert.equal(parseDouEntries(withText('<!DOCTYPE xml SYSTEM "https://example.invalid">'+xml.replace(/^\uFEFF/,'')),archiveContext('DO1')).partialFailures[0]?.code, 'DOU_XML_DTD_FORBIDDEN');
  assert.equal(parseDouEntries([entry],{...archiveContext('DO1'),date:'2026-09-17'}).partialFailures[0]?.code,'DOU_ARCHIVE_CONTEXT_MISMATCH');
  assert.equal(parseDouEntries(withText(xml.replaceAll('pesquisa.in.gov.br','example.invalid')),archiveContext('DO1')).partialFailures[0]?.code,'DOU_INVALID_CERTIFIED_REFERENCE');
});

test('CONFAZ structural taxonomy: synthetic headings only, not a real-world capture gate', () => {
  for (const family of ['CONVÊNIO ICMS','AJUSTE SINIEF','PROTOCOLO ICMS','ATO COTEPE/ICMS']) {
    const r = classifyDouAct(`${family} Nº 12, DE 17 DE SETEMBRO DE 2026`, 'Ministério da Fazenda/Conselho Nacional de Política Fazendária', 'Ato');
    assert.equal(r.agency,'CONFAZ'); assert.equal(r.actType,family); assert.equal(r.actNumber,'12/2026');
  }
  const r = classifyDouAct('RETIFICAÇÃO','CONFAZ','Retificação'); assert.equal(r.actNumber,undefined);
  const unrelated = classifyDouAct('CONVÊNIO ICMS Nº 12, DE 17 DE SETEMBRO DE 2026','Outro órgão','Convênio');
  assert.equal(unrelated.family,undefined);
});
