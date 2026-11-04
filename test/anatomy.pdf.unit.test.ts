import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractPdfLines, readPdfInput } from '../src/modules/anatomy/pdf-reader.js';
import { buildSyntheticPdf } from './support/synthetic-pdf.js';

// ANAT-PDF-01. Synthetic PDFs generated in the test ("Exemplo" acts); never the corpus, gold, reserve or official files.
const PAGE1 = [
  { text: 'PORTARIA EXEMPLO Nº 77, DE 2 DE JANEIRO DE 2099', y: 780 },
  { text: 'CAPÍTULO I', y: 750 },
  { text: 'Art. 1º Fica criado o regime de teste (sem efeito real).', y: 730 },
  { text: 'Parágrafo único. Aplica-se às operações exemplo.', y: 710 },
];
const PAGE2 = [
  { text: 'Art. 2º São requisitos:', y: 780 },
  { text: 'I - primeiro requisito;', y: 760 },
  { text: 'II - segundo requisito.', y: 740 },
  { text: 'Art. 3º Esta Portaria entra em vigor na data de sua publicação.', y: 720 },
];

test('extraction keeps text unchanged, in reading order, with page and line numbers, even when drawn out of order', async () => {
  const scrambled = [...PAGE1].reverse(); // drawn bottom-up: the reader must restore top-down order
  const { pages, lines } = await extractPdfLines(buildSyntheticPdf([scrambled, PAGE2]));
  assert.equal(pages, 2);
  assert.deepEqual(lines.map((l) => l.text), [...PAGE1, ...PAGE2].map((l) => l.text), 'no loss, duplication, truncation or reordering');
  assert.deepEqual(lines.map((l) => `${l.page}:${l.line}`), ['1:1', '1:2', '1:3', '1:4', '2:1', '2:2', '2:3', '2:4']);
});

test('the anatomy of a PDF reuses the reader: groups, articles, sole paragraph and incisos are recognised', async () => {
  const r = await readPdfInput(buildSyntheticPdf([PAGE1, PAGE2]), { source: 'DOU', representationId: 'pdf-sint' });
  const types = r.parts.map((p) => p.type);
  for (const t of ['group', 'article', 'paragraph', 'inciso']) assert.ok(types.includes(t as never), `${t} recognised`);
  assert.equal(r.parts.filter((p) => p.type === 'article').length, 3);
  assert.ok(r.parts.some((p) => p.contextReasons[0] === 'paragraph_sole'));
  assert.equal(r.coverage.accountedLength, r.canonicalText.length, 'complete coverage');
  assert.ok(r.parts.every((p) => p.legalStatus === 'unknown'), 'no validity inferred');
});

test('traceability: every pointer names the PDF hash, page and line of its passage', async () => {
  const bytes = buildSyntheticPdf([PAGE1, PAGE2]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const r = await readPdfInput(bytes, { source: 'DOU', representationId: 'pdf-sint' });
  assert.equal(r.pdf.sha256, sha);
  const art3 = r.parts.find((p) => p.type === 'article' && r.canonicalText.slice(p.span.start).startsWith('Art. 3º'))!;
  assert.ok(art3.sourcePointers.every((s) => s.representation === 'attachment'));
  assert.equal(art3.sourcePointers[0]!.locator, `pdf:sha256=${sha};page=2;line=4`);
  for (const m of r.sourceMap) assert.match(m.pointer.locator, /^pdf:sha256=[a-f0-9]{64};page=\d+;line=\d+$/u);
  // Each mapped line's text is exactly the canonical text at its span.
  for (const l of r.pdf.lines) assert.equal(r.canonicalText.slice(l.start, l.end), l.text);
});

test('Portuguese accents and symbols survive extraction (º, ª, ç, ã, é, §)', async () => {
  const { lines } = await extractPdfLines(buildSyntheticPdf([[{ text: '§ 1º A ação é válida na 2ª instância; não há exceção.', y: 700 }]]));
  assert.equal(lines[0]!.text, '§ 1º A ação é válida na 2ª instância; não há exceção.');
});

test('a PDF without a text layer yields no invented text and an explicit limitation', async () => {
  const r = await readPdfInput(buildSyntheticPdf([[]]), { source: 'DOU', representationId: 'pdf-vazio' });
  assert.equal(r.canonicalText.trim(), '');
  assert.ok(r.limitations.some((l) => l.code === 'pdf_without_text_layer'));
  assert.equal(r.pdf.pages, 1);
});

test('a long multi-page PDF keeps every line in order (extensive document)', async () => {
  const pages = Array.from({ length: 30 }, (_, p) => Array.from({ length: 40 }, (_, i) => ({ text: `Art. ${p * 40 + i + 1}º Texto exemplo ${p + 1}-${i + 1}.`, y: 800 - i * 18 })));
  const r = await readPdfInput(buildSyntheticPdf(pages), { source: 'DOU', representationId: 'pdf-longo' });
  assert.equal(r.pdf.lines.length, 1200);
  assert.equal(r.parts.filter((p) => p.type === 'article').length, 1200);
  assert.deepEqual(r.pdf.lines.slice(-1)[0], { ...r.pdf.lines.slice(-1)[0]!, page: 30, line: 40 });
});

test('characters special to HTML (&, <, >) are preserved verbatim, never interpreted as markup', async () => {
  const line = 'Art. 1º Se A < B & C > D, aplica-se <b>nada</b> aqui.';
  const r = await readPdfInput(buildSyntheticPdf([[{ text: line, y: 700 }]]), { source: 'DOU', representationId: 'pdf-esc' });
  assert.equal(r.canonicalText, `${line}\n`);
  assert.equal(r.pdf.lines[0]!.start, 0);
});

test('R2-05: a mixed PDF (text page + image-only page) is partial and names the unread page; no OCR, no invented text', async () => {
  const r = await readPdfInput(buildSyntheticPdf([PAGE1, []], { imagePages: [1] }), { source: 'DOU', representationId: 'pdf-misto' });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.pdf.pageCoverage, [{ page: 1, state: 'text' }, { page: 2, state: 'no_text_layer' }]);
  const lim = r.limitations.filter((l) => l.code === 'pdf_page_without_text_layer');
  assert.equal(lim.length, 1); assert.match(lim[0]!.message, /page 2\b/u);
  assert.ok(r.pdf.lines.every((l) => l.page === 1));
});

test('R2-05: all-text PDF stays complete; an image-only PDF is without text layer; a blank page is "empty", not a loss', async () => {
  const full = await readPdfInput(buildSyntheticPdf([PAGE2, PAGE2]), { source: 'DOU', representationId: 'pdf-txt' });
  assert.equal(full.status, 'complete', 'fully recognized text pages are not degraded by page coverage');
  assert.ok(full.pdf.pageCoverage.every((c) => c.state === 'text'));
  const scan = await readPdfInput(buildSyntheticPdf([[]], { imagePages: [0] }), { source: 'DOU', representationId: 'pdf-scan' });
  assert.ok(scan.limitations.some((l) => l.code === 'pdf_without_text_layer'));
  assert.deepEqual(scan.pdf.pageCoverage, [{ page: 1, state: 'no_text_layer' }]);
  const blank = await readPdfInput(buildSyntheticPdf([PAGE1, []]), { source: 'DOU', representationId: 'pdf-branco' });
  assert.deepEqual(blank.pdf.pageCoverage, [{ page: 1, state: 'text' }, { page: 2, state: 'empty' }]);
  assert.ok(!blank.limitations.some((l) => l.code === 'pdf_page_without_text_layer'));
});

test('R2 fidelity (documented limit): repeated spaces come out as ONE space, from the pdfjs text layer; nothing else is edited or added', async () => {
  const { lines } = await extractPdfLines(buildSyntheticPdf([[{ text: 'Art. 1º  Valor   exemplo.', y: 700 }, { text: 'Sem-hífen- unido', y: 680 }]]));
  assert.equal(lines[0]!.text, 'Art. 1º Valor exemplo.', 'measured pdfjs normalization of space runs');
  assert.equal(lines[1]!.text, 'Sem-hífen- unido', 'hyphens and words kept as drawn');
  const split = await extractPdfLines(buildSyntheticPdf([[{ text: 'Art. 2º', y: 700, x: 72 }, { text: 'Texto', y: 700, x: 200 }]]));
  assert.equal(split.lines[0]!.text, 'Art. 2º Texto', 'one space inserted between runs of a line');
});
