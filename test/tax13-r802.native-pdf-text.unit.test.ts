import assert from 'node:assert/strict';
import test from 'node:test';
import {extractDouOnePageNativePdfText} from '../src/modules/taxonomy/legal-scope/dou-native-pdf-text.js';
import {legacyPdfFixture} from './doe-sp-legacy.pdf-fixtures.js';
import {syntheticWrappedOnePagePdf} from './dou-one-page.pdf-fixtures.js';

test('TAX13 DOU: native PDF extractor consumes one page without changing original bytes',async()=>{
 const content='DIARIO OFICIAL DA UNIAO N 80-B DESPACHO N 16 CONVENIO ICMS N 15 '+
  'CLAUSULA PRIMEIRA REGRAS FISCAIS DE MARCO DE 2024 '+
  'CLAUSULA SEGUNDA PRAZO DE PAGAMENTO CLAUSULA TERCEIRA MULTAS E ACRESCIMOS '+
  'CLAUSULA QUARTA RATIFICACAO NACIONAL E VIGENCIA';
 const bytes=syntheticWrappedOnePagePdf(content);
 const original=new Uint8Array(bytes);
 const result=await extractDouOnePageNativePdfText(bytes);
 assert.equal(result.status,'PDF_NATIVE_TEXT_EXTRACTED',JSON.stringify(result));
 assert.equal(result.pageCount,1);
 assert.ok(result.text?.includes('CONVENIO ICMS N 15'));
 assert.deepEqual(bytes,original,'PDF source bytes must remain intact for hashing');
});

test('TAX13 DOU: two-page and blank PDFs cannot be treated as text evidence',async()=>{
 const two=await extractDouOnePageNativePdfText(legacyPdfFixture({text:'two page pdf',pages:2}));
 assert.equal(two.status,'UNVERIFIED');
 assert.equal(two.reason,'DOU_PDF_TEXT_ONE_PAGE_REQUIRED');
 const blank=await extractDouOnePageNativePdfText(legacyPdfFixture({text:'',pages:1}));
 assert.equal(blank.status,'UNVERIFIED');
 assert.equal(blank.reason,'DOU_PDF_TEXT_EMPTY_OR_INCOMPLETE');
});
test('TAX13 DOU: malformed or oversized PDF cannot enter the native extractor',async()=>{
 for(const data of [Buffer.from('not PDF'),Buffer.alloc(20*1024*1024+1)]){
  const result=await extractDouOnePageNativePdfText(data);
  assert.equal(result.status,'UNVERIFIED');
  assert.equal(result.reason,'DOU_PDF_TEXT_INPUT_BOUNDS');
 }
});
