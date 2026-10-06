import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import sax from 'sax';
import { parseDouEntries, parseDouZip, readDouZip, classifyDouAct, extractEmbeddedConfazPublications, douHtmlText } from '../src/modules/collection/dou.parser.js';
import type { DouXmlEntry, DouArchiveContext } from '../src/modules/collection/dou.parser.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { classifyDouContractExcerpt } from '../src/modules/collection/dou-scope.rules.js';
import { evaluatePublicationExclusionPolicy } from '../src/modules/collection/publication-exclusion-policy.js';
import { fixtureEntries, makeZip, archiveContext } from './dou.fixtures.js';

async function assertZipParity(entries: DouXmlEntry[], context: DouArchiveContext) {
  const expected = parseDouEntries(entries, context);
  const publications: typeof expected.publications = [];
  const result = await parseDouZip(await makeZip([
    ...entries,
    { name: 'illustration.jpg', bytes: Buffer.from('media fixture') },
  ]), context, new AbortController().signal, async publication => {
    publications.push(publication);
  });
  assert.deepEqual(result, {
    partialFailures: expected.partialFailures,
    xmlCount: entries.length,
    mediaCount: 1,
  }, 'the streaming result contains counters and failures, never a publication buffer');
  assert.deepEqual(publications, expected.publications);
  assert.deepEqual(
    publications.map(publication => normalizePublication({ sourceId: 'dou', publication })),
    expected.publications.map(publication => normalizePublication({ sourceId: 'dou', publication })),
  );
  for (const publication of publications) {
    for (const part of (publication.metadata!.dou as any).parts ?? []) {
      const entry = entries.find(entry => entry.name === part.filename)!;
      assert.equal(part.rawSha256, createHash('sha256').update(entry.bytes).digest('hex'));
      assert.equal(part.sizeBytes, entry.bytes.byteLength);
    }
  }
  return publications;
}

function syntheticZipEntry(options: {
  matter: string; section?: string; part?: number; title?: string; abstract?: string; text?: string;
}): DouXmlEntry {
  const { matter, section = 'DO1', part, title = 'DESPACHO Nº 28, DE 17 DE SETEMBRO DE 2026',
    abstract = '', text = '<p>Conteúdo oficial de teste.</p>' } = options;
  const journal = section === 'DO3' ? '530' : '515';
  return {
    name: `${journal}_20260918_${matter}${part ? `-${part}` : ''}.xml`,
    bytes: Buffer.from(`<xml><article id="${matter}${part ?? 1}" idMateria="${matter}" pubDate="18/09/2026" pubName="${section}" editionNumber="180" artCategory="Ministério da Fazenda/Conselho Nacional de Política Fazendária" artType="${section === 'DO3' ? 'EXTRATO DE CONTRATO' : 'DESPACHO'}" highlightImage="data:image/png;base64,aW1hZ2U=" numberPage="${part ?? 1}" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=${journal}&amp;pagina=${part ?? 1}"><body><Identifica><![CDATA[${title}]]></Identifica><Ementa><![CDATA[${abstract}]]></Ementa><Texto><![CDATA[${text}]]></Texto></body></article></xml>`),
  };
}

function embeddedZipEntry(): DouXmlEntry {
  return syntheticZipEntry({
    matter: '12345678',
    text: [
      '<p>Publica os Convênios ICMS.</p>',
      '<p>CONVÊNIO ICMS Nº 63, DE 17 DE SETEMBRO DE 2026</p>',
      '<p>Altera o Convênio ICMS nº 87, de 9 de julho de 2010.</p>',
      '<p>CONVÊNIO ICMS Nº 64, DE 17 DE SETEMBRO DE 2026</p>',
      '<p>Autoriza as unidades federadas nas condições que especifica.</p>',
    ].join(''),
  });
}

function exclusionNoticeEntry(part?: number, content = '<p>Objeto: aquisição de papel A4. Modalidade: dispensa de licitação. Processo: 123. Valor: R$ 100.</p>'): DouXmlEntry {
  const entry = syntheticZipEntry({ matter: '12345678', section: 'DO3',
    title: 'AVISO DE DISPENSA DE LICITAÇÃO', text: content, ...(part ? { part } : {}) });
  return { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
    .replace(/artCategory="[^"]*"/, 'artCategory="Órgão administrativo federal"')
    .replace(/artType="[^"]*"/, 'artType="AVISO DE DISPENSA DE LICITAÇÃO"')
    .replace(/ highlightImage="[^"]*"/, '')) };
}

function assertSameCanonicalNotice(
  publication: ReturnType<typeof parseDouEntries>['publications'][number],
  baseline: ReturnType<typeof parseDouEntries>['publications'][number],
): void {
  assert.equal(publication.title, baseline.title);
  assert.equal(publication.content, baseline.content);
  const before = normalizePublication({ sourceId: 'dou', publication: baseline });
  const after = normalizePublication({ sourceId: 'dou', publication });
  assert.equal(after.identityHash, before.identityHash);
  assert.equal(after.contentHash, before.contentHash);
}

test('nonempty discarded body XML fields veto exclusion without changing canonical text, HTML or hashes', async () => {
  const entry = exclusionNoticeEntry();
  const context = archiveContext('DO3');
  const baseline = parseDouEntries([entry], context).publications[0]!;
  assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication: baseline }).decision, 'EXCLUDE');
  const extras = [
    ...['Anexo', 'Titulo', 'SubTitulo', 'Data', 'Midias'].map(field =>
      `<${field}><![CDATA[Concede isenção do ICMS.]]></${field}>`),
    '<Anexo><p>Concede isenção do ICMS.</p></Anexo>',
    '<Anexo><img src="evidence.png"/></Anexo>',
    '<Anexo href="evidence.pdf"/>',
    'Concede isenção do ICMS.',
  ];
  for (const extra of extras) {
    const changed = { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
      .replace('</body>', `${extra}</body>`)) };
    const publications = await assertZipParity([changed], context);
    assert.equal(publications.length, 1);
    const publication = publications[0]!;
    assert.equal((publication.metadata!.dou as any).scopeStructureIncomplete, true, extra);
    assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication }).reasonCode, 'INCOMPLETE_DOU_STRUCTURE', extra);
    assertSameCanonicalNotice(publication, baseline);
    assert.equal(publication.presentationHtml, baseline.presentationHtml);
  }
});

test('empty extra XML fields and ordinary presentational styles do not invent missing evidence', () => {
  const entry = exclusionNoticeEntry();
  const changed = { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
    .replace('</body>', '<Data/><Titulo> \n </Titulo><SubTitulo><![CDATA[\t]]></SubTitulo><Midias/><Anexo/></body>')
    .replace('<p>Objeto:', '<p class="notice" style="text-align:left"><span style="font-weight:bold">Objeto:</span>')
    .replace('</p>', '</p><input type="text"><input type="text" value=" " placeholder=" "><div title=" " aria-label=" " alt=" " background=" " style="background-color:white; text-align:center"></div>')) };
  const result = parseDouEntries([changed], archiveContext('DO3'));
  assert.deepEqual(result.partialFailures, []);
  const publication = result.publications[0]!;
  assert.equal((publication.metadata!.dou as any).scopeStructureIncomplete, undefined);
  assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication }).decision, 'EXCLUDE');
  assertSameCanonicalNotice(publication, parseDouEntries([entry], archiveContext('DO3')).publications[0]!);
});

test('discarded visual HTML, attribute text and CSS veto exclusion in every scope field without changing hashes', () => {
  const entry = exclusionNoticeEntry();
  const context = archiveContext('DO3');
  const baseline = parseDouEntries([entry], context).publications[0]!;
  assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication: baseline }).decision, 'EXCLUDE');
  const media = [
    '<input type="image" src="evidence.png">',
    '<INPUT TYPE=" IMAGE " SRC="evidence.png">',
    '<input type="text" value="Concede isenção do ICMS">',
    '<input type="text" placeholder="Concede isenção do ICMS">',
    '<option label="Concede isenção do ICMS"></option>',
    '<optgroup label="Concede isenção do ICMS"></optgroup>',
    '<progress value="50" max="100"></progress>',
    '<meter value="50" max="100"></meter>',
    '<select></select>',
    '<custom-evidence></custom-evidence>',
    '<table background="evidence.png"><tr><td>&nbsp;</td></tr></table>',
    '<div alt="Concede isenção do ICMS"></div>',
    '<span title="Concede isenção do ICMS"></span>',
    '<div aria-label="Concede isenção do ICMS"></div>',
    ...['label', 'src', 'href', 'data', 'srcdoc', 'aria-labelledby'].map(attribute =>
      `<span ${attribute}="evidence"></span>`),
    '<div style="background-image:url(evidence.png)"></div>',
    '<div style="BACKGROUND: URL(&quot;evidence.png&quot;)"></div>',
    '<div style="background-image:u/**/rl(evidence.png)"></div>',
    '<div style="background-image:u\\72l(evidence.png)"></div>',
    '<div style="background-image:linear-gradient(red,green)"></div>',
    '<div style="content:\'Concede isenção do ICMS\'"></div>',
    '<style>.anexo::before{content:"Concede isenção do ICMS"}</style>',
    '<script>document.write("Concede isenção do ICMS")</script>',
    '<link rel="alternate stylesheet" href="evidence.css">',
  ];
  for (const visual of media) {
    for (const field of ['Identifica', 'Ementa', 'Texto']) {
      const changed = { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
        .replace(`]]></${field}>`, `${visual}]]></${field}>`)) };
      const result = parseDouEntries([changed], context);
      assert.deepEqual(result.partialFailures, []);
      const publication = result.publications[0]!;
      assert.equal((publication.metadata!.dou as any).scopeStructureIncomplete, true, `${field}: ${visual}`);
      assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication }).reasonCode, 'INCOMPLETE_DOU_STRUCTURE');
      assertSameCanonicalNotice(publication, baseline);
    }
  }
});

test('discarded XML and CSS in a later part veto exclusion for either multipart order', async () => {
  const first = exclusionNoticeEntry(1, '<p>Objeto: aquisição de papel A4. Processo: 123.</p>');
  const second = exclusionNoticeEntry(2, '<p>Valor: R$ 100.</p>');
  const context = archiveContext('DO3');
  const baseline = parseDouEntries([first, second], context).publications[0]!;
  assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication: baseline }).decision, 'EXCLUDE');
  for (const xml of [
    Buffer.from(second.bytes).toString('utf8').replace('</body>', '<Anexo><p>Concede isenção do ICMS.</p></Anexo></body>'),
    Buffer.from(second.bytes).toString('utf8').replace(']]></Texto>', '<div style="background-image:url(evidence.png)"></div>]]></Texto>'),
  ]) {
    const changed = { ...second, bytes: Buffer.from(xml) };
    for (const entries of [[first, changed], [changed, first]]) {
      const publications = await assertZipParity(entries, context);
      const publication = publications[0]!;
      assert.equal((publication.metadata!.dou as any).scopeStructureIncomplete, true);
      assert.equal(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication }).reasonCode, 'INCOMPLETE_DOU_STRUCTURE');
      assertSameCanonicalNotice(publication, baseline);
    }
  }
});

test('non-text DOU media cannot disappear from exclusion evidence', () => {
  for (const media of ['<img src="evidence.png">', '<object data="evidence.pdf"></object>', '<svg><text>ICMS</text></svg>']) {
    const entry = syntheticZipEntry({ matter: '12345678', section: 'DO3',
      title: 'AVISO DE DISPENSA DE LICITAÇÃO',
      text: `<p>Objeto: aquisição de papel A4. Processo: 123.</p>${media}` });
    const result = parseDouEntries([entry], archiveContext('DO3'));
    assert.equal(result.partialFailures.length, 0);
    const publication = result.publications[0]!;
    assert.equal((publication.metadata!.dou as Record<string, unknown>).scopeStructureIncomplete, true);
    assert.notEqual(evaluatePublicationExclusionPolicy({ sourceCode: 'dou', publication }).decision, 'EXCLUDE');
  }
});

test('streaming ZIP parser exactly preserves real fixture publications and arbitrary multipart order', async () => {
  await assertZipParity(await fixtureEntries('DO1'), archiveContext('DO1'));
  const entries = await fixtureEntries('DO1E');
  for (const order of [entries, [...entries].reverse(), [entries[5]!, entries[0]!, entries[3]!, entries[6]!, entries[4]!, entries[1]!, entries[7]!, entries[2]!]]) {
    await assertZipParity(order, archiveContext('DO1E'));
  }
  await assertZipParity([
    syntheticZipEntry({ matter: '12345678', part: 2 }),
    syntheticZipEntry({ matter: '12345679', part: 1 }),
    syntheticZipEntry({ matter: '12345678', part: 1 }),
    syntheticZipEntry({ matter: '12345679', part: 2 }),
  ], archiveContext('DO1'));
});

test('streaming ZIP parser preserves continuation scope signals, HTML presentation and embedded CONFAZ acts', async () => {
  const publications = await assertZipParity([
    syntheticZipEntry({ matter: '12345679', section: 'DO3', part: 2, title: 'ANEXO - CONTINUAÇÃO', abstract: 'Concede isenção do ICMS.', text: '<blockquote>Informações complementares.</blockquote>' }),
    syntheticZipEntry({ matter: '12345679', section: 'DO3', part: 1, title: 'EXTRATO DE CONTRATO Nº 7/2026', text: '<p>Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.</p>' }),
  ], archiveContext('DO3'));
  const publication = publications[0]!;
  const metadata = publication.metadata!.dou as any;
  assert.deepEqual(metadata.continuationTitles, ['ANEXO - CONTINUAÇÃO']);
  assert.deepEqual(metadata.continuationAbstracts, ['Concede isenção do ICMS.']);
  assert.equal(metadata.scopeStructureIncomplete, true);
  assert.equal(classifyDouContractExcerpt(publication)?.decision, 'KEEP');
  assert.equal(classifyDouContractExcerpt(publication)?.category, 'TRIBUTARIO_FISCAL');
  assert.match(publication.presentationHtml!, /<\/section><hr><section>/);
  assert.equal(metadata.parts[0].hasHighlightImage, true);
  assert.equal(metadata.parts[0].attributes.highlightImage, undefined);

  const embedded = await assertZipParity([embeddedZipEntry()], archiveContext('DO1'));
  assert.deepEqual(embedded.map(item => item.actNumber), ['28/2026', '63/2026', '64/2026']);
  assert.equal((embedded[1]!.metadata!.dou as any).parentMatterExternalId, embedded[0]!.externalId);
});

test('image-heavy XML detaches each completed retained value once without copying its image or changing publication semantics', async t => {
  const title = 'PORTARIA Nº 7, DE 17 DE SETEMBRO DE 2026 🧾';
  const agency = 'Órgão público/Coordenação – São Paulo 🧮';
  const abstract = 'Isenção para ação fiscal 🚀 & controle.';
  const firstHtml = '<p>Ação fiscal 🚀 — café e coração.</p>';
  const secondHtml = '<p>Entidade &amp; obrigação.</p>';
  const html = firstHtml + secondHtml;
  const smallImage = 'data:image/png;base64,aW1hZ2U=';
  const largeImage = 'data:image/png;base64,' + 'QUJD'.repeat(12 * 1024);
  const entry = syntheticZipEntry({ matter: '12345678', title, abstract, text: html });
  const xml = Buffer.from(entry.bytes).toString('utf8')
    .replace('Ministério da Fazenda/Conselho Nacional de Política Fazendária', agency)
    .replace(`<Texto><![CDATA[${html}]]></Texto>`, `<Texto><![CDATA[${firstHtml}]]><![CDATA[${secondHtml}]]></Texto>`);
  const small = { ...entry, bytes: Buffer.from(xml) };
  const large = { ...entry, bytes: Buffer.from(xml.replace(smallImage, largeImage)) };
  const context = archiveContext('DO1');
  const baseline = parseDouEntries([small], context);
  assert.deepEqual(baseline.partialFailures, []);
  assert.equal(baseline.publications.length, 1);
  const original = baseline.publications[0]!;
  const dou = original.metadata!.dou as any;
  const expected = {
    ...original,
    metadata: { ...original.metadata, dou: {
      ...dou,
      parts: [{ ...dou.parts[0],
        rawSha256: createHash('sha256').update(large.bytes).digest('hex'),
        sizeBytes: large.bytes.byteLength,
      }],
    } },
  };
  const expectedCopies = [...Object.values(dou.parts[0].attributes), title, abstract, html].sort();
  const originalFrom = Buffer.from;
  const copied: string[] = [];
  t.mock.method(Buffer, 'from', (...args: Parameters<typeof Buffer.from>) => {
    if (typeof args[0] === 'string' && args[1] === 'utf16le') copied.push(args[0]);
    return Reflect.apply(originalFrom, Buffer, args);
  });
  const zipped = await makeZip([large]);

  for (const mode of ['legacy', 'streaming']) {
    copied.length = 0;
    let publications: typeof baseline.publications;
    if (mode === 'legacy') {
      const result = parseDouEntries([large], context);
      assert.deepEqual(result.partialFailures, []);
      publications = result.publications;
    } else {
      publications = [];
      const result = await parseDouZip(zipped, context, new AbortController().signal, async value => { publications.push(value); });
      assert.deepEqual(result, { partialFailures: [], xmlCount: 1, mediaCount: 0 });
    }
    assert.deepEqual([...copied].sort(), expectedCopies, `${mode}: detach complete attrs/fields exactly once, not SAX fragments`);
    assert.equal(copied.includes(largeImage), false, `${mode}: the discarded base64 image is never copied`);
    assert.deepEqual(publications, [expected], `${mode}: only original-byte provenance changes with the image`);
    const publication = publications[0]!;
    assert.equal(publication.title, title);
    assert.equal(publication.presentationHtml, `<section>${html}</section>`);
    assert.equal(publication.content, 'Ação fiscal 🚀 — café e coração.\nEntidade & obrigação.');
    assert.equal((publication.metadata!.dou as any).parts[0].attributes.artCategory, agency);
    const before = normalizePublication({ sourceId: 'dou', publication: original });
    const after = normalizePublication({ sourceId: 'dou', publication });
    assert.equal(after.identityHash, before.identityHash);
    assert.equal(after.contentHash, before.contentHash);
  }
});

test('completed-field detachment preserves an emoji split across real SAX CDATA callbacks', t => {
  const html = '<p>Ação fiscal 🚀 — obrigação íntegra.</p>';
  const entry = syntheticZipEntry({ matter: '12345678', text: html });
  const expected = parseDouEntries([entry], archiveContext('DO1'));
  const originalParser = sax.parser;
  const fragments: string[] = [];
  t.mock.method(sax, 'parser', (...args: Parameters<typeof sax.parser>) => {
    const parser = originalParser(...args);
    const write = parser.write;
    parser.write = function (xml) {
      if (typeof xml !== 'string') return write.call(this, xml);
      const split = xml.indexOf('🚀', xml.indexOf('<Texto>')) + 1;
      assert.ok(split > 0);
      const onCdata = this.oncdata;
      this.oncdata = fragment => { fragments.push(fragment); onCdata?.(fragment); };
      // Valid UTF-8 input has already been decoded. SAX may flush a JS string
      // between its UTF-16 surrogate units; the complete field must join them.
      write.call(this, xml.slice(0, split));
      this.flush();
      return write.call(this, xml.slice(split));
    };
    return parser;
  });

  const actual = parseDouEntries([entry], archiveContext('DO1'));
  assert.ok(fragments.some(fragment => fragment.endsWith('\ud83d')));
  assert.ok(fragments.some(fragment => fragment.startsWith('\ude80')));
  assert.deepEqual(actual, expected);
  assert.equal(actual.publications[0]!.presentationHtml, `<section>${html}</section>`);
  assert.equal(actual.publications[0]!.content, 'Ação fiscal 🚀 — obrigação íntegra.');
});

test('streaming ZIP parser awaits every publication sink, including embedded children', { timeout: 5000 }, async () => {
  const zip = await makeZip([embeddedZipEntry(), syntheticZipEntry({ matter: '12345679' })]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0; let active = 0; let maximumActive = 0; let settled = false;
  const pending = parseDouZip(zip, archiveContext('DO1'), new AbortController().signal, async () => {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    if (calls === 1) { entered(); await blocked; }
    await setImmediate();
    active--;
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await firstEntered;
    await setImmediate();
    assert.equal(calls, 1, 'no parent or child is emitted while the preceding sink is pending');
    assert.equal(settled, false);
  } finally { release(); }
  await pending;
  assert.equal(calls, 4);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test('streaming ZIP parser propagates synchronous and asynchronous sink failures without emitting more items', async () => {
  const zip = await makeZip([embeddedZipEntry(), syntheticZipEntry({ matter: '12345679' })]);
  for (const failAt of [1, 2]) {
    for (const asynchronous of [false, true]) {
      const failure = new Error('publication persistence failed');
      let calls = 0;
      await assert.rejects(parseDouZip(zip, archiveContext('DO1'), new AbortController().signal, () => {
        if (++calls !== failAt) return Promise.resolve();
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      }), reason => reason === failure);
      assert.equal(calls, failAt, 'a sink failure is fatal, not a partial XML failure');
    }
  }
});

test('streaming ZIP parser honors cancellation before parsing and between parent or child sink calls', async () => {
  const zip = await makeZip([embeddedZipEntry(), syntheticZipEntry({ matter: '12345679' })]);
  for (const abortAt of [0, 1, 2]) {
    const controller = new AbortController();
    const reason = new Error('collection cancelled');
    let calls = 0;
    if (abortAt === 0) controller.abort(reason);
    await assert.rejects(parseDouZip(zip, archiveContext('DO1'), controller.signal, async () => {
      if (++calls === abortAt) controller.abort(reason);
      await setImmediate();
    }), error => error === reason);
    assert.equal(calls, abortAt, 'no later parent or embedded act reaches the sink after cancellation');
  }
});

test('streaming ZIP parser cancels an active large-entry read without emitting a partial publication', async () => {
  const zip = await makeZip([syntheticZipEntry({ matter: '12345678', text: 'x'.repeat(4 * 1024 * 1024) })]);
  const controller = new AbortController();
  const reason = new Error('cancel active ZIP read');
  let calls = 0;
  const pending = parseDouZip(zip, archiveContext('DO1'), controller.signal, async () => { calls++; });
  // Yield into ZIP I/O, then abort while the multi-chunk XML entry is being read.
  await setImmediate();
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 0);
});

test('streaming ZIP parser enforces CRC, unsafe path and duplicate-entry checks before any sink call', async () => {
  const entry = syntheticZipEntry({ matter: '12345678' });
  const validZip = await makeZip([entry, syntheticZipEntry({ matter: '12345679' })]);
  const corrupt = Buffer.from(validZip);
  const centralHeader = Buffer.from([0x50, 0x4b, 1, 2]);
  const first = corrupt.indexOf(centralHeader);
  const second = corrupt.indexOf(centralHeader, first + 4);
  assert.ok(second > first);
  corrupt.writeUInt32LE(0, second + 16);
  const cases: Array<[Uint8Array, RegExp]> = [
    [corrupt, /DOU_ZIP_CRC_MISMATCH/],
    [await makeZip([{ name: 'nested/file.xml', bytes: entry.bytes }]), /DOU_UNSAFE_ZIP_PATH/],
    [await makeZip([entry, entry]), /DOU_UNSAFE_ZIP/],
    [Buffer.from('not zip'), /DOU_INVALID_ZIP/],
  ];
  for (const [bytes, pattern] of cases) {
    let calls = 0;
    await assert.rejects(parseDouZip(bytes, archiveContext('DO1'), new AbortController().signal, async () => { calls++; }), pattern);
    assert.equal(calls, 0);
  }
  const empty = await parseDouZip(await makeZip([]), archiveContext('DO1'), new AbortController().signal, async () => { assert.fail('empty ZIP emitted a publication'); });
  assert.deepEqual(empty, { partialFailures: [], xmlCount: 0, mediaCount: 0 });
});

test('streaming ZIP parser preserves conservative DTD, context, certified-reference and broken-continuation failures', async () => {
  const original = syntheticZipEntry({ matter: '12345678' });
  const xml = Buffer.from(original.bytes).toString('utf8');
  for (const [text, code] of [
    ['<!DOCTYPE xml SYSTEM "https://example.invalid">' + xml, 'DOU_XML_DTD_FORBIDDEN'],
    [xml.replaceAll('pesquisa.in.gov.br', 'example.invalid'), 'DOU_INVALID_CERTIFIED_REFERENCE'],
  ]) {
    const entries = [{ ...original, bytes: Buffer.from(text!) }];
    assert.equal(parseDouEntries(entries, archiveContext('DO1')).partialFailures[0]?.code, code);
    await assertZipParity(entries, archiveContext('DO1'));
  }
  await assertZipParity([original], { ...archiveContext('DO1'), date: '2026-09-17' });
  const entries = await fixtureEntries('DO1E');
  await assertZipParity(entries.filter(entry => !entry.name.endsWith('24378456-2.xml')), archiveContext('DO1E'));
  await assertZipParity(entries.map(entry => entry.name.endsWith('24378456-2.xml') ? { ...entry, bytes: Buffer.from('<xml>broken') } : entry).reverse(), archiveContext('DO1E'));
});

test('streaming ZIP parser honors a Uint8Array view offset and length without consuming surrounding bytes', async () => {
  const entries = await fixtureEntries('DO1');
  const zip = await makeZip(entries);
  const backing = new Uint8Array(zip.length + 257);
  backing.fill(0xff);
  backing.set(zip, 127);
  const view = backing.subarray(127, 127 + zip.length);
  const publications: ReturnType<typeof parseDouEntries>['publications'] = [];
  const result = await parseDouZip(view, archiveContext('DO1'), new AbortController().signal, async publication => { publications.push(publication); });
  const expected = parseDouEntries(entries, archiveContext('DO1'));
  assert.deepEqual(publications, expected.publications);
  assert.deepEqual(result, { partialFailures: expected.partialFailures, xmlCount: entries.length, mediaCount: 0 });
});

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

test('multipart continuation may carry a distinct official heading without losing the matter', async () => {
  const entries = await fixtureEntries('DO1E');
  const changed = entries.map(entry => {
    if (!entry.name.endsWith('24378456-2.xml')) return entry;
    const xml = Buffer.from(entry.bytes).toString('utf8');
    return {
      ...entry,
      bytes: Buffer.from(
        xml.replace(
          '<Identifica />',
          '<Identifica><![CDATA[ANEXO II - CONTINUAÇÃO]]></Identifica>',
        ),
      ),
    };
  });

  const result = parseDouEntries(changed, archiveContext('DO1E'));
  assert.deepEqual(result.partialFailures, []);
  const publication = result.publications.find(p => p.actNumber === '4940/2026');
  assert.ok(publication);
  assert.deepEqual(
    (publication.metadata!.dou as any).continuationTitles,
    ['ANEXO II - CONTINUAÇÃO'],
  );
});

test('every continuation Ementa reaches scope classification without changing content or identity hashes', () => {
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
  const entry = (part: number, abstract: string) => ({
    name: `530_20260918_12345678-${part}.xml`,
    bytes: Buffer.from(`<xml><article id="${part}" idMateria="12345678" pubDate="18/09/2026" pubName="DO3" editionNumber="180" artCategory="Órgão público federal" artType="EXTRATO DE CONTRATO" numberPage="1" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=530&amp;pagina=1"><body><Identifica><![CDATA[${title}]]></Identifica><Ementa><![CDATA[${abstract}]]></Ementa><Texto><![CDATA[${part === 1 ? routine : 'Informações complementares.'}]]></Texto></body></article></xml>`),
  });
  const original = parseDouEntries([entry(1, ''), entry(2, '')], archiveContext('DO3')).publications[0]!;
  const result = parseDouEntries([entry(2, 'Concede isenção do ICMS.'), entry(1, '')], archiveContext('DO3'));
  assert.deepEqual(result.partialFailures, []);
  const publication = result.publications[0]!;
  const dou = publication.metadata!.dou as any;
  assert.equal(dou.abstract, '');
  assert.deepEqual(dou.continuationTitles, [], 'the second part has the same heading');
  assert.deepEqual(dou.continuationAbstracts, ['Concede isenção do ICMS.']);
  assert.equal(classifyDouContractExcerpt(original)?.decision, 'IGNORE');
  assert.equal(classifyDouContractExcerpt(publication)?.decision, 'KEEP');
  assert.equal(classifyDouContractExcerpt(publication)?.category, 'TRIBUTARIO_FISCAL');
  assert.equal(publication.content, original.content);
  assert.equal(publication.presentationHtml, original.presentationHtml);
  const before = normalizePublication({ sourceId: 'dou', publication: original });
  const after = normalizePublication({ sourceId: 'dou', publication });
  assert.equal(after.identityHash, before.identityHash);
  assert.equal(after.contentHash, before.contentHash);
});

test('unpreserved HTML block boundaries veto IGNORE through metadata without changing canonical text or hashes', () => {
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
  for (const tag of ['section', 'article', 'blockquote', 'hr', 'dl', 'dt', 'dd']) {
    const structuralText = tag === 'hr'
      ? 'Contratante: UNIÃO<hr>Determina a retenção de IRRF.'
      : `<${tag}>Contratante: UNIÃO</${tag}><${tag}>Determina a retenção de IRRF.</${tag}>`;
    for (const field of ['Texto', 'Ementa', 'Identifica']) {
      const html = field === 'Texto' ? routine.replace('Contratante: União.', structuralText) : routine;
      const abstract = field === 'Ementa' ? structuralText : '';
      const heading = field === 'Identifica' ? (tag === 'hr' ? `${title}<hr>` : `<${tag}>${title}</${tag}>`) : title;
      const bytes = Buffer.from(`<xml><article id="1" idMateria="12345678" pubDate="18/09/2026" pubName="DO3" editionNumber="180" artCategory="Órgão público federal" artType="EXTRATO DE CONTRATO" numberPage="1" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=530&amp;pagina=1"><body><Identifica><![CDATA[${heading}]]></Identifica><Ementa><![CDATA[${abstract}]]></Ementa><Texto><![CDATA[${html}]]></Texto></body></article></xml>`);
      const result = parseDouEntries([{ name: '530_20260918_12345678.xml', bytes }], archiveContext('DO3'));
      assert.deepEqual(result.partialFailures, []);
      const publication = result.publications[0]!;
      const dou = publication.metadata!.dou as Record<string, unknown>;
      assert.equal(dou.scopeStructureIncomplete, true, `${tag}/${field}`);
      assert.equal(publication.content, douHtmlText(html), 'canonical text extraction is unchanged');
      assert.deepEqual(classifyDouContractExcerpt(publication)?.reasonCodes, ['incomplete_text_structure']);
      assert.equal(classifyDouContractExcerpt(publication)?.decision, 'REVIEW');
      const { scopeStructureIncomplete: _flag, ...legacyDou } = dou;
      const legacy = { ...publication, metadata: { ...publication.metadata, dou: legacyDou } };
      const before = normalizePublication({ sourceId: 'dou', publication: legacy });
      const after = normalizePublication({ sourceId: 'dou', publication });
      assert.equal(after.identityHash, before.identityHash);
      assert.equal(after.contentHash, before.contentHash);
    }
  }
});

test('nested XML in scope fields vetoes IGNORE without changing canonical text, HTML or hashes', async () => {
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const routine = '<p>Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.</p>';
  const entry = syntheticZipEntry({ matter: '12345678', section: 'DO3', title, text: routine });
  const context = archiveContext('DO3');
  const baseline = parseDouEntries([entry], context).publications[0]!;
  assert.equal(classifyDouContractExcerpt(baseline)?.decision, 'IGNORE');
  for (const nested of [
    '<p>Concede isenção do ICMS.</p>',
    '<p>Autoriza a concessão de serviços públicos.</p>',
    '<span>Condições adicionais não identificadas.</span>',
    '<div><p><![CDATA[Concede isenção do ICMS.]]></p></div>',
    '<br/>',
  ]) {
    for (const field of ['Texto', 'Ementa', 'Identifica']) {
      const changed = { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
        .replace(`</${field}>`, `${nested}</${field}>`)) };
      const publications = await assertZipParity([changed], context);
      assert.equal(publications.length, 1);
      const publication = publications[0]!;
      const dou = publication.metadata!.dou as any;
      assert.equal(dou.scopeStructureIncomplete, true, `${field}: ${nested}`);
      assert.equal(classifyDouContractExcerpt(publication)?.decision, 'REVIEW');
      assert.deepEqual(classifyDouContractExcerpt(publication)?.reasonCodes, ['incomplete_text_structure']);
      // Deliberately preserve legacy extraction: discarded XML is represented
      // by a conservative veto, never silently interpreted as routine-only.
      assert.equal(publication.title, baseline.title);
      assert.equal(publication.content, baseline.content);
      assert.equal(publication.presentationHtml, baseline.presentationHtml);
      assert.equal(dou.abstract, (baseline.metadata!.dou as any).abstract);
      const before = normalizePublication({ sourceId: 'dou', publication: baseline });
      const after = normalizePublication({ sourceId: 'dou', publication });
      assert.equal(after.identityHash, before.identityHash);
      assert.equal(after.contentHash, before.contentHash);
    }
  }
});

test('nested XML in any continuation scope field vetoes IGNORE in arbitrary multipart order', async () => {
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const first = syntheticZipEntry({ matter: '12345678', section: 'DO3', part: 1, title,
    text: 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.' });
  const second = syntheticZipEntry({ matter: '12345678', section: 'DO3', part: 2, title, text: 'Informações complementares.' });
  const context = archiveContext('DO3');
  assert.equal(classifyDouContractExcerpt(parseDouEntries([first, second], context).publications[0]!)?.decision, 'IGNORE');
  for (const field of ['Texto', 'Ementa', 'Identifica']) {
    const changed = { ...second, bytes: Buffer.from(Buffer.from(second.bytes).toString('utf8')
      .replace(`</${field}>`, `<p>Concede isenção do ICMS.</p></${field}>`)) };
    for (const entries of [[first, changed], [changed, first]]) {
      const publications = await assertZipParity(entries, context);
      assert.equal(publications.length, 1);
      assert.equal((publications[0]!.metadata!.dou as any).scopeStructureIncomplete, true);
      assert.equal(classifyDouContractExcerpt(publications[0]!)?.decision, 'REVIEW');
      assert.deepEqual(classifyDouContractExcerpt(publications[0]!)?.reasonCodes, ['incomplete_text_structure']);
    }
  }
});

test('ordinary XML text, CDATA HTML and escaped HTML remain eligible for routine IGNORE', async () => {
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
  const entry = syntheticZipEntry({ matter: '12345678', section: 'DO3', title, text: routine });
  for (const [xmlText, html] of [
    [routine, routine],
    [`<![CDATA[<p>${routine}</p>]]>`, `<p>${routine}</p>`],
    [`&lt;p&gt;${routine}&lt;/p&gt;`, `<p>${routine}</p>`],
  ]) {
    const changed = { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString('utf8')
      .replace(`<Texto><![CDATA[${routine}]]></Texto>`, `<Texto>${xmlText}</Texto>`)) };
    const publications = await assertZipParity([changed], archiveContext('DO3'));
    assert.equal(publications.length, 1);
    const publication = publications[0]!;
    assert.equal((publication.metadata!.dou as any).scopeStructureIncomplete, undefined);
    assert.equal(classifyDouContractExcerpt(publication)?.decision, 'IGNORE');
    assert.equal(publication.content, routine);
    assert.equal(publication.presentationHtml, `<section>${html}</section>`);
  }
});

test('a matter with an empty official title is kept with a flagged descriptive title, never an inferred act', async () => {
  const entries = await fixtureEntries('DO1');
  const original = parseDouEntries(entries, archiveContext('DO1')).publications.find(p => p.actNumber === '119/2026')!;
  const officialId = (original.metadata!.dou as any).officialMatterId as string;
  const changed = entries.map(entry => {
    const xml = Buffer.from(entry.bytes).toString('utf8');
    if (!xml.includes(`idMateria="${officialId}"`)) return entry;
    return { ...entry, bytes: Buffer.from(xml.replace(/<Identifica>[\s\S]*?<\/Identifica>/, '<Identifica />')) };
  });

  const result = parseDouEntries(changed, archiveContext('DO1'));
  assert.deepEqual(result.partialFailures, [], 'no DOU_MISSING_TITLE');
  const kept = result.publications.find(p => p.externalId === original.externalId)!;
  assert.ok(kept, 'the official matter is still collected');
  const data = kept.metadata!.dou as any;
  assert.equal(data.titleFallback, 'ART_TYPE_AND_UNIT');
  assert.equal(kept.title, [data.sourceActType, data.unit].filter(Boolean).join(' - '));
  assert.equal(kept.actNumber, undefined, 'no act number is inferred without an official heading');
  assert.equal(kept.content, original.content);
  assert.equal(normalizePublication({ sourceId: 'dou', publication: kept }).identityStrength, 'SOURCE_SCOPED');
  // Matters with an official title are untouched.
  assert.equal((original.metadata!.dou as any).titleFallback, undefined);
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
