import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { extractDoeSpLegacyPdfText } from '../src/modules/collection/doe-sp-legacy.text.js';
import { legacyPdfFixture } from './doe-sp-legacy.pdf-fixtures.js';

test('native PDF text, page count and certification removal preserve the caller buffer', async () => {
  const bytes = legacyPdfFixture({ text: 'DOE SP native text', pages: 2 });
  const before = new Uint8Array(bytes);
  for (let use = 0; use < 2; use += 1) {
    assert.deepEqual(await extractDoeSpLegacyPdfText(bytes), {
      text: 'DOE SP native text\nDOE SP native text', pageCount: 2,
      scanned: false, extraction: 'PDF_NATIVE_TEXT', largestImagePixels: 0,
    });
    assert.deepEqual(bytes, before, 'pdf.js must not detach or mutate caller-owned bytes');
  }
  const stamped = legacyPdfFixture({ text: 'Lei 123. Página do Diário Oficial certificada ABC123' });
  assert.equal((await extractDoeSpLegacyPdfText(stamped)).text, 'Lei 123.');
});

test('large raster with embedded text is OCR, without changing its text', async () => {
  assert.deepEqual(await extractDoeSpLegacyPdfText(legacyPdfFixture({ text: 'OCR text layer', scanned: true })), {
    text: 'OCR text layer', pageCount: 1, scanned: true,
    extraction: 'PDF_EMBEDDED_OCR', largestImagePixels: 2_250_000,
  });
});

test('valid blank and image-only PDFs remain EMPTY', async () => {
  for (const scanned of [false, true]) {
    assert.deepEqual(await extractDoeSpLegacyPdfText(legacyPdfFixture({ text: '', scanned })), {
      text: '', pageCount: 1, scanned, extraction: 'EMPTY', largestImagePixels: scanned ? 2_250_000 : 0,
    });
  }
});

test('invalid and zero-byte PDFs retain the non-retryable ConnectorError contract', async () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('not a PDF')]) {
    const before = new Uint8Array(bytes);
    await assert.rejects(extractDoeSpLegacyPdfText(bytes), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'DOE_SP_LEGACY_INVALID_PDF');
      assert.equal(error.kind, 'PROCESSING_ERROR');
      assert.equal(error.retryable, false);
      assert.equal(typeof error.metadata?.cause, 'string');
      return true;
    });
    assert.deepEqual(bytes, before);
  }
  assert.equal((await extractDoeSpLegacyPdfText(legacyPdfFixture())).extraction, 'PDF_NATIVE_TEXT');
});

test('fresh wrapper bootstrap does not import pdf.js; concurrent and subsequent extractions share one import', async () => {
  // A distinct URL resets the wrapper's promise even if another test already
  // loaded pdf.js. Count import requests, not cached module evaluations. This
  // regression test needs neither a subprocess nor an empty global ESM cache.
  const source = new URL('../src/modules/collection/doe-sp-legacy.text.ts', import.meta.url);
  source.searchParams.set('first-use-test', String(performance.now()));
  let imports = 0;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'pdfjs-dist/legacy/build/pdf.mjs' && context.parentURL === source.href) imports += 1;
    return nextResolve(specifier, context);
  } });
  try {
    const { extractDoeSpLegacyPdfText: extractFresh } = await import(source.href) as typeof import('../src/modules/collection/doe-sp-legacy.text.js');
    assert.equal(imports, 0, 'Wrapper bootstrap must not request pdf.js');
    const bytes = legacyPdfFixture({ text: 'Concurrent native text' });
    const before = new Uint8Array(bytes);
    const results = await Promise.all(Array.from({ length: 8 }, () => extractFresh(bytes)));
    assert.equal(imports, 1, 'Concurrent first use must share the import promise');
    for (const value of results) assert.equal(value.text, 'Concurrent native text');
    await extractFresh(bytes);
    assert.equal(imports, 1, 'Subsequent use must retain the cached promise');
    assert.deepEqual(bytes, before);
  } finally {
    hooks.deregister();
  }
});
