import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ANATOMY_READER_LIMITS, readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { buildAnnexManifest, linkSeparateAnnexes } from '../src/modules/anatomy/annex-manifest.js';

// ANAT-EXT-01. Synthetic "Exemplo" acts generated here; never corpus, gold, reserve or official text.
const html = (blocks: string[]) => `<html><body>${blocks.map((b) => `<p>${b}</p>`).join('')}</body></html>`;
const read = (blocks: string[], id = 'ext') => readAnatomyInput({ source: 'DOU', representationId: id, html: html(blocks) });
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const MAIN = ['PORTARIA EXEMPLO Nº 9, DE 1 DE JANEIRO DE 2099', 'Art. 1º Ficam aprovados os anexos.', 'Art. 2º Vigência na publicação.',
  'ANEXO I - MODELO EXEMPLO', 'Art. 1º Campo um do modelo.', 'ANEXO II', 'Item exemplo do anexo dois.'];

test('inline annexes become manifest entries with exact span hash and descendant count', () => {
  const r = read(MAIN);
  const m = buildAnnexManifest(r);
  assert.deepEqual(m.map((a) => a.label.split(' - ')[0]), ['ANEXO I', 'ANEXO II']);
  for (const a of m) assert.equal(a.textSha256, sha(r.canonicalText.slice(a.span.start, a.span.end)));
  assert.ok(m[0]!.partCount >= 1);
  assert.ok(m[0]!.span.end <= m[1]!.span.start, 'annexes do not overlap');
});

test('separate annex files link by declared designation only; unmatched or repeated ones are reported', () => {
  const main = read(MAIN);
  const sep = (label: string, body: string[]) => ({ declaredLabel: label, representationId: `sep-${label}`, bytesSha256: sha(body.join()), result: read(body, label) });
  const m = linkSeparateAnnexes(main, [sep('Anexo  i', ['ANEXO I', 'Campo um.']), sep('ANEXO III', ['ANEXO III', 'x.']), sep('ANEXO I', ['ANEXO I', 'y.'])]);
  assert.equal(m.separate[0]!.inlinePartId, buildAnnexManifest(main)[0]!.partId);
  assert.equal(m.separate[1]!.inlinePartId, null);
  assert.equal(m.separate[2]!.inlinePartId, null);
  assert.deepEqual(m.issues, [{ code: 'annex_separate_without_heading', label: 'ANEXO III' }, { code: 'annex_label_duplicate', label: 'ANEXO I' }]);
  assert.equal(m.separate[0]!.textSha256, sha(read(['ANEXO I', 'Campo um.'], 'x').canonicalText), 'separate annex keeps its own text hash');
});

test('a prose reference to an annex is not an annex', () => {
  assert.equal(buildAnnexManifest(read(['Art. 1º Conforme o Anexo I desta Portaria.'])).length, 0);
});

test('extensive document: 3000 articles in 20 annexes, no loss, duplication or reordering, within a time budget', () => {
  const blocks: string[] = ['PORTARIA EXEMPLO Nº 1, DE 1 DE JANEIRO DE 2099'];
  for (let a = 1; a <= 20; a++) { blocks.push(`ANEXO ${a}`); for (let i = 1; i <= 150; i++) blocks.push(`Art. ${i}º Texto exemplo ${a}-${i}.`); }
  const t0 = performance.now();
  const r = read(blocks, 'big');
  const ms = performance.now() - t0;
  assert.ok(ms < 20_000, `read in ${ms.toFixed(0)}ms`);
  const arts = r.parts.filter((p) => p.type === 'article');
  assert.equal(arts.length, 3000);
  const texts = arts.map((p) => r.canonicalText.slice(p.span.start, p.span.end));
  assert.equal(new Set(texts).size, 3000, 'no duplication');
  for (let k = 1; k < arts.length; k++) assert.ok(arts[k]!.span.start > arts[k - 1]!.span.start, 'document order');
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
  const m = buildAnnexManifest(r);
  assert.equal(m.length, 20);
  assert.ok(m.every((a) => a.partCount >= 150));
});

test('beyond the size limit the reader degrades explicitly, never truncates silently', () => {
  const line = 'Art. 1º Texto exemplo muito repetido para exceder o limite. ';
  const big = line.repeat(Math.ceil(ANATOMY_READER_LIMITS.maxBytes / line.length) + 10);
  const r = readAnatomyInput({ source: 'DOU', representationId: 'huge', text: big });
  assert.ok(r.limitations.some((l) => l.code === 'input_size_limit'));
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
  assert.ok(r.canonicalText.length >= big.trim().length - 2, 'original retained');
});

test('deep nesting beyond the depth limit is reported, not dropped silently', () => {
  const deep = `<html><body>${'<div>'.repeat(ANATOMY_READER_LIMITS.maxDepth + 5)}<p>Art. 1º Fundo.</p>${'</div>'.repeat(ANATOMY_READER_LIMITS.maxDepth + 5)}</body></html>`;
  const r = readAnatomyInput({ source: 'DOU', representationId: 'deep', html: deep });
  assert.ok(r.limitations.length > 0, 'explicit limitation');
  assert.ok(r.canonicalText.includes('Art. 1º Fundo.'), 'text retained');
});
