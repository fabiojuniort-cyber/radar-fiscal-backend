import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCgibsText } from '../src/modules/collection/cgibs.text.js';
import { legacyPdfFixture } from './doe-sp-legacy.pdf-fixtures.js';
import { zip } from './cgibs.fixtures.js';

test('reads the native text layer of a published act', async () => {
  const extracted = await extractCgibsText(
    legacyPdfFixture({ text: 'RESOLUCAO CGIBS No 1 de 2026' }),
    'application/pdf',
  );
  assert.equal(extracted.extraction, 'PDF_TEXT');
  assert.match(extracted.text, /RESOLUCAO CGIBS No 1 de 2026/);
  assert.equal(extracted.pageCount, 1);
  assert.equal(extracted.pagesSkipped, 0);
});

test('trusts the bytes when the portal serves a PDF as octet-stream', async () => {
  const extracted = await extractCgibsText(
    legacyPdfFixture({ text: 'Manual de integracao tecnica' }),
    'application/octet-stream',
  );
  assert.equal(extracted.extraction, 'PDF_TEXT');
  assert.match(extracted.text, /Manual de integracao tecnica/);
});

test('a non-PDF attachment is reported, never guessed at', async () => {
  const extracted = await extractCgibsText(zip('planilha'), 'application/zip');
  assert.equal(extracted.extraction, 'UNSUPPORTED_MEDIA');
  assert.equal(extracted.text, '');
});

// One unreadable attachment must not fail the other acts of the run, so the
// reason is returned instead of thrown.
test('a damaged file yields a reason instead of throwing', async () => {
  const extracted = await extractCgibsText(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'), 'application/pdf');
  assert.equal(extracted.extraction, 'UNREADABLE');
  assert.equal(extracted.text, '');
});

test('a PDF with no text layer is told apart from one that failed to open', async () => {
  const extracted = await extractCgibsText(legacyPdfFixture({ text: '' }), 'application/pdf');
  assert.equal(extracted.extraction, 'PDF_WITHOUT_TEXT');
  assert.equal(extracted.text, '');
});

test('an oversized file stays linked and unread rather than loaded', async () => {
  const huge = new Uint8Array(49 * 1024 * 1024);
  huge.set(new TextEncoder().encode('%PDF'));
  const extracted = await extractCgibsText(huge, 'application/pdf');
  assert.equal(extracted.extraction, 'TOO_LARGE');
});
