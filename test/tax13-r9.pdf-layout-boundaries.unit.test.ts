import assert from 'node:assert/strict';
import test from 'node:test';
import {assembleDouPdfTextItems} from '../src/modules/taxonomy/legal-scope/dou-native-pdf-text.js';

/** SYNTHETIC / NON_OFFICIAL. These tests cannot authenticate a DOU capture. */
const item=(str:string,x:number,y:number,width:number,hasEOL=false)=>({
 str,transform:[1,0,0,1,x,y],width,hasEOL,
});
test('R9-D07 synthetic: insert geometric word separator without changing fragments',()=>{
 const a=assembleDouPdfTextItems([
  item('CONVÊNIO',12,700,65),item('ICMS',84,700,35),
  item('Nº 15',125,700,32,true),
  item('CLÁUSULA PRIMEIRA',12,681,140),
 ]);
 assert.equal(a.status,'TEXT_ASSEMBLED');
 if(a.status==='TEXT_ASSEMBLED')
  assert.equal(a.text,'CONVÊNIO ICMS Nº 15\nCLÁUSULA PRIMEIRA');
});
test('R9-D07 synthetic: adjacent intra-word fragments are joined only with known geometry',()=>{
 const a=assembleDouPdfTextItems([
  item('CON',12,700,23),item('VÊNIO',35,700,44),
 ]);
 assert.equal(a.status,'TEXT_ASSEMBLED');
 if(a.status==='TEXT_ASSEMBLED')assert.equal(a.text,'CONVÊNIO');
 const unknown=assembleDouPdfTextItems([{str:'CONVÊNIO'},{str:'ICMS'}]);
 assert.deepEqual(unknown,{status:'TEXT_ASSEMBLED',text:'CONVÊNIO ICMS'});
});
test('R9-D07 synthetic: reordered items or unbounded overlapping text reject',()=>{
 for(const items of [
  [item('CLÁUSULA SEGUNDA',20,600,130),item('CLÁUSULA PRIMEIRA',20,700,140)],
  [item('TEXTO',190,700,40),item('ANTERIOR',10,700,65)],
  [item('A',120,700,60),item('B',130,700,20)],
 ]){
  const a=assembleDouPdfTextItems(items);
  assert.equal(a.status,'UNVERIFIED');
 }
});
