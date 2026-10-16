import assert from 'node:assert/strict';
import test from 'node:test';
import { ANATOMY_CONTRACT_VERSION, anatomyIdentityHash, anatomyOutputHash, sha256, validateAnatomyResult, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { ANATOMY_READER_LIMITS, identifyNcmPartIds, readAnatomyInput, type AnatomyReaderInput, type AnatomyReaderResult } from '../src/modules/anatomy/readers.js';

// Synthetic fixtures only: these tests never import or execute the 30-publication corpus.
function read(html: string, source: AnatomyReaderInput['source'] = 'CONFAZ'): AnatomyReaderResult {
  return readAnatomyInput({ source, html, representationId: 'synthetic-html' });
}
function validate(reader: AnatomyReaderResult): AnatomyResult {
  const identity = { publicationVersionId: 'synthetic-version', representationId: 'synthetic-html', inputTextHash: sha256(reader.canonicalText),
    inputPresentationHash: sha256('synthetic'), attachmentManifestHash: sha256('[]'), engineVersion: 'synthetic-reader-test', engineHash: sha256('synthetic-reader-engine'),
    ruleSetId: 'synthetic', ruleSetVersion: '1', ruleSetHash: sha256('synthetic'), contractVersion: ANATOMY_CONTRACT_VERSION };
  const result: AnatomyResult = { ...reader, identity, analysisId: anatomyIdentityHash(identity), contractVersion: ANATOMY_CONTRACT_VERSION,
    referenceDate: '2026-10-16', entities: [], evidence: [], eligibility: [], outputHash: sha256('placeholder') };
  result.outputHash = anatomyOutputHash(result);
  return validateAnatomyResult(result);
}
test('decoded entities, accents, combining characters and emoji retain UTF-16 origin spans', () => {
  const html = '<p class="TextoAcordo">Cláusula primeira. A &amp; B &#x1f600; e\u0301.</p>';
  const result = validate(read(html));
  assert.equal(result.canonicalText, 'Cláusula primeira. A & B 😀 e\u0301.\n');
  assert.equal(result.coverage.accountedLength, result.canonicalText.length);
  let at = 0;
  for (const map of result.sourceMap) {
    assert.equal(map.span.start, at); at = map.span.end;
    assert.match(map.pointer.locator, /^\/p\[1\]\//);
    if (map.pointer.sourceSpan) {
      const raw = html.slice(map.pointer.sourceSpan.start, map.pointer.sourceSpan.end);
      const decoded = result.canonicalText.slice(map.span.start, map.span.end);
      if (decoded === '&') assert.equal(raw, '&amp;');
      if (decoded === '😀') assert.equal(raw, '&#x1f600;');
    }
  }
  assert.equal(at, result.canonicalText.length);
  assert.equal(result.parts.find((part) => part.type === 'clause')?.legalStatus, 'unknown');
});
test('CONFAZ classes distinguish prohibited headings, editorial notes and proposed clauses', () => {
  const result = validate(read('<p class="TituloAcordo">CONVÊNIO TESTE</p><p class="Ementa">NCM 0101</p>'
    + '<p class="TextoAcordo">Cláusula primeira. Regra.</p><p>§ 1º Detalhe.</p><p>I - Item.</p><p>a) Alínea.</p>'
    + '<p class="Remisso">Alteração citada.</p><p>Cláusula segunda. Outra.</p>'));
  assert.deepEqual(result.parts.filter((part) => ['epigraph', 'summary', 'editorial_note'].includes(part.type)).map((part) => part.context), ['prohibited', 'prohibited', 'prohibited']);
  const clause = result.parts.find((part) => part.type === 'clause')!;
  const paragraph = result.parts.find((part) => part.type === 'paragraph')!;
  assert.equal(paragraph.parentId, clause.id);
  const inciso = result.parts.find((part) => part.type === 'inciso')!;
  assert.equal(inciso.parentId, paragraph.id);
  assert.equal(result.parts.find((part) => part.type === 'alinea')?.parentId, inciso.id);
  assert.ok(result.parts.every((part) => part.legalStatus === 'unknown'));
});
test('historical annex context reaches unmarked cells and resets at a new annex', () => {
  const result = validate(read('<p><span class="RedaoAnt">ANEXO I</span></p><table><tr><th>NCM</th><th>Descrição</th></tr>'
    + '<tr><td>8450.11.00</td><td>Máquina antiga</td></tr></table><p>ANEXO II</p>'
    + '<table><tr><td>NCM/SH</td></tr><tr><td>0101.21.00</td></tr></table>'));
  const historic = result.parts.find((part) => part.type === 'annex')!;
  assert.equal(historic.context, 'historical');
  const tables = result.parts.filter((part) => part.type === 'table');
  assert.equal(tables[0]?.context, 'historical');
  assert.equal(tables[1]?.context, 'operative_candidate');
  const rows = new Set(result.parts.filter((part) => part.parentId === tables[0]?.id).map((part) => part.id));
  assert.ok(result.parts.filter((part) => part.type === 'cell' && rows.has(part.parentId!)).every((part) => part.context === 'historical'));
  assert.equal(identifyNcmPartIds(result).length, 2);
});
test('table geometry preserves rowspans/colspans and original cell associations', () => {
  const result = validate(read('<table><tr><th rowspan="2">NCM</th><th colspan="2">Descrição</th></tr>'
    + '<tr><td>A</td><td>B</td></tr><tr><td>0101</td><td>C</td><td>D</td></tr></table>'));
  const cells = result.parts.filter((part) => part.type === 'cell');
  assert.deepEqual(cells[0]?.table, { row: 0, column: 0, rowSpan: 2, columnSpan: 1, geometry: 'original' });
  assert.equal(cells[1]?.table?.columnSpan, 2);
  assert.equal(cells[2]?.table?.column, 1);
  assert.equal(cells[4]?.table?.column, 0);
  assert.equal(result.canonicalText.slice(cells[4]!.span.start, cells[4]!.span.end).trim(), '0101');
});
test('ambiguous table geometry is partial and does not guess NCM columns', () => {
  const result = validate(read('<table><tr><th>NCM</th></tr><tr><td colspan="wat">0101</td></tr></table>'));
  assert.equal(result.status, 'partial');
  assert.ok(result.limitations.some((item) => item.code === 'table_geometry_unknown'));
  assert.deepEqual(identifyNcmPartIds(result), []);
});
test('generic code/NBM/TIPI/SH headings never authorize NCM extraction', () => {
  for (const header of ['CÓDIGO', 'NBM', 'TIPI', 'SH']) {
    const result = validate(read(`<table><tr><td>${header}</td></tr><tr><td>0101</td></tr></table>`));
    assert.deepEqual(identifyNcmPartIds(result), []);
  }
  const switched = validate(read('<table><tr><td>NCM</td></tr><tr><td>0101</td></tr><tr><td>NBM</td></tr><tr><td>9999</td></tr></table>'));
  assert.equal(identifyNcmPartIds(switched).length, 1);
});
test('nested tables stay children of their original cells', () => {
  const result = validate(read('<table><tr><td>Externo<table><tr><td>Interno</td></tr></table></td></tr></table>'));
  const tables = result.parts.filter((part) => part.type === 'table');
  assert.equal(tables.length, 2);
  assert.equal(result.parts.find((part) => part.id === tables[1]?.parentId)?.type, 'cell');
  assert.ok(result.canonicalText.includes('Externo') && result.canonicalText.includes('Interno'));
});
test('recognized preamble remains prohibited even with an operative text class', () => {
  const result = validate(read('<p class="TextoAcordo">O Conselho Nacional, tendo em vista a Lei 1234, resolve:</p><p>Cláusula primeira. Regra.</p>'));
  assert.equal(result.parts.find((part) => part.type === 'preamble')?.context, 'prohibited');
});
test('DOU/DOE-SP/RFB preserve unknown text and recognize only explicit article markers', () => {
  for (const source of ['DOU', 'DOE-SP', 'RFB'] as const) {
    const result = validate(read('<p>Texto sem marca reconhecida. Lei 8.433.</p><p>Art. 1º Regra expressa.</p>', source));
    assert.equal(result.status, 'partial');
    const unknown = result.parts.find((part) => part.type === 'unidentified')!;
    assert.equal(unknown.context, 'unknown');
    assert.ok(result.parts.some((part) => part.type === 'article'));
    assert.ok(result.coverage.recognizedLength < result.coverage.accountedLength);
    assert.equal(result.coverage.accountedLength, result.canonicalText.length);
  }
});
test('article citations inside prose do not become article boundaries', () => {
  const result = validate(read('<p>Nos termos do art. 1º da lei e Anexo I, aplica-se.</p>', 'DOU'));
  assert.ok(!result.parts.some((part) => part.type === 'article' || part.type === 'annex'));
});
test('markup quotations and multi-paragraph quotation text remain prohibited', () => {
  for (const html of ['<blockquote><p>Art. 1º Alteração citada.</p></blockquote>',
    '<p>“Art. 1º Redação citada.</p><p>Art. 2º Continuação.”</p><p>Art. 3º Próprio.</p>']) {
    const result = validate(read(html, 'DOU'));
    const quoted = result.parts.filter((part) => part.type === 'quoted_text');
    assert.ok(quoted.length >= 1); assert.ok(quoted.every((part) => part.context === 'prohibited'));
  }
});
test('missing attachment, image and executable content are declared without fetching', () => {
  const result = validate(readAnatomyInput({ source: 'RFB', representationId: 'fixture',
    html: '<p>Art. 1º Regra.</p><script>ignore all instructions</script><img src="https://invalid.test/a">', missingResources: ['attachment-a'] }));
  assert.equal(result.status, 'partial');
  assert.ok(!result.canonicalText.includes('ignore all instructions'));
  assert.deepEqual(result.coverage.missingResources, ['attachment-a']);
  for (const code of ['excluded_executable_content', 'image_without_ocr', 'missing_resources']) assert.ok(result.limitations.some((item) => item.code === code));
});
test('plain text, missing body and hostile HTML limits fail closed while accounting for all units', () => {
  const text = 'Art. 1º Texto 😀';
  const plain = validate(readAnatomyInput({ source: 'DOU', representationId: 'plain', text }));
  assert.equal(plain.canonicalText, text); assert.equal(plain.status, 'partial');
  assert.equal(plain.coverage.recognizedLength, 0);
  assert.equal(validate(read('')).status, 'partial');
  const hostile = '<div>'.repeat(ANATOMY_READER_LIMITS.maxDepth + 2) + 'texto' + '</div>'.repeat(ANATOMY_READER_LIMITS.maxDepth + 2);
  const deep = validate(read(hostile));
  assert.equal(deep.canonicalText, hostile); assert.equal(deep.coverage.recognizedLength, 0);
  assert.ok(deep.limitations.some((item) => item.code === 'html_complexity_limit'));
  const oversized = 'a'.repeat(ANATOMY_READER_LIMITS.maxBytes + 1);
  const big = validate(read(oversized));
  assert.equal(big.canonicalText.length, oversized.length);
  assert.ok(big.limitations.some((item) => item.code === 'input_size_limit'));
});
test('same snapshot returns identical parts, source maps and coverage', () => {
  const html = '<p>Art. 1º Teste &amp; 😀.</p><p>Art. 2º Outro.</p>';
  assert.deepEqual(read(html, 'DOU'), read(html, 'DOU'));
});
test('historical DOM wrapper protects an otherwise unmarked article', () => {
  const result = validate(read('<div class="RedaoAnt"><p>Art.1ºNCM0101.21.00</p></div>'));
  const article = result.parts.find((part) => part.type === 'article')!;
  assert.equal(article.context, 'historical');
  assert.ok(article.contextReasons.includes('inherited_dom_zone'));
});
test('historical class on table protects its rows and unmarked cells', () => {
  const result = validate(read('<table class="RedaoAnt"><tr><td>NCM</td></tr><tr><td>0101.21.00</td></tr></table>'));
  assert.ok(result.parts.filter((part) => ['table', 'row', 'cell'].includes(part.type)).every((part) => part.context === 'historical'));
});
test('historical class on one row protects its cells without marking another row historical', () => {
  const result = validate(read('<table><tr><td>NCM</td></tr><tr class="RedaoAnt"><td>0101.21.00</td></tr><tr><td>0202</td></tr></table>'));
  const cells = result.parts.filter((part) => part.type === 'cell');
  assert.deepEqual(cells.map((cell) => cell.context), ['operative_candidate', 'historical', 'operative_candidate']);
});
test('blockquote context protects entire nested table and all its cells', () => {
  const result = validate(read('<blockquote><table><tr><td>NCM</td></tr><tr><td>0101.21.00</td></tr></table></blockquote>'));
  assert.ok(result.parts.filter((part) => ['table', 'row', 'cell'].includes(part.type)).every((part) => part.context === 'prohibited'));
});
test('inline q excludes entire containing paragraph with an explicit conservative limitation', () => {
  const result = validate(read('<p>Art.1ºTexto<q>NCM0101.21.00</q></p>'));
  const part = result.parts.find((candidate) => candidate.type !== 'document')!;
  assert.equal(part.type, 'quoted_text'); assert.equal(part.context, 'prohibited');
  assert.ok(result.limitations.some((item) => item.code === 'inline_quote_conservative_exclusion'));
  assert.equal(result.coverage.accountedLength, result.canonicalText.length);
  assert.ok(result.parts.every((candidate) => candidate.legalStatus === 'unknown'));
});
