import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDouEntries, readDouZip, classifyDouAct, extractEmbeddedConfazPublications } from '../src/modules/collection/dou.parser.js';
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


test('official CONFAZ dispatch headings become child acts while incidental body citations do not', () => {
  const parent = {
    title: 'DESPACHO Nº 28, DE 7 DE JULHO DE 2026',
    agency: 'CONFAZ',
    sphere: 'FEDERAL' as const,
    actType: 'DESPACHO',
    actNumber: '28/2026',
    publishedAt: new Date('2026-07-08T00:00:00Z'),
    content: [
      'Publica os Convênios ICMS celebrados na 202ª reunião ordinária.',
      'CONVÊNIO ICMS Nº 63, DE 3 DE JULHO DE 2026',
      'Altera o Convênio ICMS nº 87, de 9 de julho de 2010.',
      'O Convênio ICMS nº 87, de 9 de julho de 2010, permanece vigente.',
      'CONVÊNIO ICMS Nº 64, DE 3 DE JULHO DE 2026',
      'Autoriza as unidades federadas nas condições que especifica.',
    ].join('\n'),
    officialUrl: 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=08/07/2026&jornal=515&pagina=109',
    externalId: '2026-07-08:DO1:126:24113463',
    metadata: {
      sourceRole: 'PRIMARY',
      ingestionChannel: 'INLABS',
      officialUrlGranularity: 'PAGE',
      dou: {
        publicationDate: '2026-07-08',
        section: 'DO1',
        edition: '126',
        officialMatterId: '24113463',
        agencyPath: 'Ministério da Fazenda/Conselho Nacional de Política Fazendária',
        unit: 'Conselho Nacional de Política Fazendária',
        certifiedPageUrls: [
          'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=08/07/2026&jornal=515&pagina=109',
        ],
      },
    },
  };

  const children = extractEmbeddedConfazPublications(parent);
  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map(child => [child.actType, child.actNumber]),
    [
      ['CONVÊNIO ICMS', '63/2026'],
      ['CONVÊNIO ICMS', '64/2026'],
    ],
  );
  assert.match(children[0]!.content!, /Convênio ICMS nº 87/);
  assert.doesNotMatch(children[0]!.content!, /CONVÊNIO ICMS Nº 64/);
  assert.equal((children[0]!.metadata!.dou as any).embeddedAct, true);
  assert.equal(
    (children[0]!.metadata!.dou as any).parentMatterExternalId,
    parent.externalId,
  );

  const childIdentity = normalizePublication({
    sourceId: 'dou-source',
    publication: children[0]!,
  });
  const portalIdentity = normalizePublication({
    sourceId: 'confaz-source',
    publication: {
      title: 'Convênio ICMS 63/2026',
      agency: 'CONFAZ',
      sphere: 'FEDERAL',
      actType: 'CONVÊNIO ICMS',
      actNumber: '63/2026',
      publishedAt: new Date('2026-07-08T00:00:00Z'),
      content: 'Conteúdo do portal CONFAZ.',
      officialUrl: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/2026/CV063_26',
      externalId: '/legislacao/convenios/2026/CV063_26',
      metadata: {
        sourceRole: 'ENRICHMENT',
        ingestionChannel: 'CONFAZ_PORTAL',
      },
    },
  });

  assert.equal(childIdentity.identityHash, portalIdentity.identityHash);

  assert.deepEqual(
    extractEmbeddedConfazPublications({
      ...parent,
      actType: 'ATO COTEPE/ICMS',
      title: 'ATO COTEPE/ICMS Nº 72, DE 8 DE JULHO DE 2026',
    }),
    [],
  );
});
