import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DOU_PREPARATION_VERSION, DouPreparationError, locateDouHtmlSpan, prepareDouRepresentation } from '../src/modules/anatomy/dou-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';

// Synthetic INLABS-shaped XML only: these tests never read the corpus or the reserved entries.
const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
function xml(body: string, attrs = 'idMateria="900" name="SYN"', meta = '<Identifica><![CDATA[ PORTARIA 1]]></Identifica><Ementa><![CDATA[]]></Ementa>'): string {
  return `<xml><article id="1" ${attrs} pubName="DO1" artType="Portaria" pubDate="01/01/2026"><body>${meta}<Texto><![CDATA[${body}]]></Texto></body></article></xml>`;
}
const res = (resourceId: string, text: string, bom = false) => ({ resourceId, bytes: new Uint8Array(Buffer.from((bom ? '﻿' : '') + text, 'utf8')) });
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof DouPreparationError); return e.code; } return 'no-error'; };

test('single resource: CDATA copied verbatim, BOM removed, spans map back to the XML', () => {
  const body = '<p class="identifica">PORTARIA Nº 1</p><p>Art. 1º Texto &amp; ação.</p>';
  const raw = xml(body);
  const p = prepareDouRepresentation([res('a.xml', raw, true)]);
  assert.equal(p.preparationVersion, DOU_PREPARATION_VERSION);
  assert.equal(p.resources[0]!.bomPresent, true);
  assert.equal(p.resources[0]!.sha256, sha(Buffer.from('﻿' + raw, 'utf8')));
  const r = p.resources[0]!;
  assert.equal(p.html.slice(r.htmlSpan.start, r.htmlSpan.end), body);
  assert.equal(raw.slice(r.cdataSpan.start, r.cdataSpan.end), body);
  const at = body.indexOf('Art.');
  assert.deepEqual(locateDouHtmlSpan(p, { start: r.htmlSpan.start + at, end: r.htmlSpan.start + at + 4 }), { resourceId: 'a.xml', xmlSpan: { start: r.cdataSpan.start + at, end: r.cdataSpan.start + at + 4 } });
  assert.equal(locateDouHtmlSpan(p, { start: 0, end: 1 }), null);
  assert.equal(p.htmlSha256, sha(p.html));
});

test('artNotes and metadata duplicates are excluded by hash only, never copied into the text', () => {
  const note = 'DIA 17 09 - NÃO PUBLICAR';
  const p = prepareDouRepresentation([res('a.xml', xml('<p>Art. 1º X.</p>', `idMateria="900" name="SYN" artNotes="${note}"`))]);
  const fields = p.excluded.map((x) => x.field).sort();
  assert.deepEqual(fields, ['Identifica', 'artNotes']);
  const n = p.excluded.find((x) => x.field === 'artNotes')!;
  assert.equal(n.sha256, sha(note)); assert.equal(n.reason, 'internal_layout_note');
  assert.ok(!p.html.includes(note)); assert.ok(!JSON.stringify(p.excluded).includes(note));
});

test('multi-file matter is consolidated in _NNN order into one representation', () => {
  const parts = [3, 1, 2].map((n) => res(`p${n}.xml`, xml(`<p>parte ${n}</p>`, `idMateria="900" name="PT X_00${n}" numberPage="${n * 2}"`)));
  const p = prepareDouRepresentation(parts);
  assert.deepEqual(p.resources.map((r) => r.resourceId), ['p1.xml', 'p2.xml', 'p3.xml']);
  const read = readAnatomyInput({ source: 'DOU', representationId: p.preparationId, html: p.html });
  assert.equal(read.canonicalText.indexOf('parte 1') < read.canonicalText.indexOf('parte 2'), true);
  assert.equal(read.parts.filter((x) => x.type === 'document').length, 1);
  assert.equal(prepareDouRepresentation([...parts].reverse()).preparationId, p.preparationId);
});

test('ambiguous inputs fail closed', () => {
  const a = (n: string, id = '900') => res(`${n}.xml`, xml('<p>x</p>', `idMateria="${id}" name="PT X_${n}"`));
  assert.equal(code(() => prepareDouRepresentation([])), 'no_resources');
  assert.equal(code(() => prepareDouRepresentation([a('001'), a('003')])), 'part_sequence_gap');
  assert.equal(code(() => prepareDouRepresentation([a('001'), a('002', '901')])), 'id_materia_mismatch');
  assert.equal(code(() => prepareDouRepresentation([a('001'), res('n.xml', xml('<p>x</p>', 'idMateria="900" name="PT X"'))])), 'part_number_missing');
  assert.equal(code(() => prepareDouRepresentation([res('d.xml', xml('<p>x</p>') + '<Texto><![CDATA[y]]></Texto>')])), 'texto_cdata_not_unique');
  assert.equal(code(() => prepareDouRepresentation([res('u.xml', '<xml><article idMateria="1"><body><Texto><![CDATA[x')])), 'texto_cdata_unterminated');
  assert.equal(code(() => prepareDouRepresentation([{ resourceId: 'bad.xml', bytes: new Uint8Array([0x3c, 0xff, 0xfe]) }])), 'invalid_utf8');
  assert.equal(code(() => prepareDouRepresentation([res('m.xml', xml('<p>x</p>', 'name="SYN"'))])), 'id_materia_mismatch');
});

test('DOU official classes and rectification wording are recognized only as prohibited positions', () => {
  const html = '<p class="identifica">RETIFICAÇÃO</p><p class="ementa">Altera X.</p><p>Na Portaria nº 340, para fazer constar que:</p>'
    + '<p>Onde se lê "...processo 8471.30.12...",</p><p>Leia-se "...processo 2003.01.26732...", mantidas as demais condições.</p>'
    + '<p class="assina">FULANO</p><p class="cargo">Ministro</p>';
  const r = readAnatomyInput({ source: 'DOU', representationId: 'syn', html });
  const by = (reason: string) => r.parts.find((p) => p.contextReasons.includes(reason));
  assert.equal(by('dou_identifica')?.type, 'epigraph');
  assert.equal(by('dou_ementa')?.type, 'summary');
  assert.equal(by('dou_assina')?.type, 'signature');
  assert.equal(by('dou_cargo')?.type, 'signature');
  for (const reason of ['dou_identifica', 'dou_ementa', 'dou_assina', 'dou_cargo', 'dou_rectification_original', 'dou_rectification_corrected']) {
    const part = by(reason); assert.ok(part, reason); assert.equal(part.context, 'prohibited'); assert.equal(part.legalStatus, 'unknown');
  }
  // Prose that merely mentions the phrase is not a rectification block, and other sources keep their own profile.
  const prose = readAnatomyInput({ source: 'DOU', representationId: 'syn', html: '<p>Art. 1º Onde se lê o edital, aplica-se.</p>' });
  assert.ok(!prose.parts.some((p) => p.contextReasons.includes('dou_rectification_original')));
  const confaz = readAnatomyInput({ source: 'CONFAZ', representationId: 'syn', html: '<p class="ementa">Texto</p><p>Leia-se "x".</p>' });
  assert.ok(!confaz.parts.some((p) => p.contextReasons.some((c) => c.startsWith('dou_'))));
});
