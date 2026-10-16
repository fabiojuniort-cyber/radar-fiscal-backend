import assert from 'node:assert/strict';
import test from 'node:test';
import {validateF2Suggestions} from '../src/modules/taxonomy/curation/curation.f2-suggestions.js';
import {attachF2SourceSuggestions} from '../src/modules/taxonomy/curation/curation.f2-source.js';
import type {ReleaseView} from '../src/modules/taxonomy/curation/curation.read.js';

test('F2-TAB-02 B1: preserves leading zeros and 2-to-8 digit NCMs',()=>{
  assert.deepEqual(validateF2Suggestions({
    suggestedProducts:[' Arroz ','Milho','arroz'],
    suggestedNcms:['01.02','0012345','12345678','01.02'],
  }),{
    suggestedProducts:['Arroz','Milho'],
    suggestedNcms:['0102','0012345','12345678'],
  });
  assert.throws(()=>validateF2Suggestions({suggestedProducts:[],suggestedNcms:['123456789']}),
    {code:'F2_SUGGESTIONS_INVALID_NCM'});
});
test('F2-TAB-02 B1: release override [] clears staging source without staging writes',async()=>{
  const concept={releaseConceptId:'rc1',dimensionCode:'sector',membershipStatus:'INCLUDED',
    officialCodes:['0111301'],f2DraftSuggestions:{products:[],ncms:['000123']}} as ReleaseView['concepts'][number];
  const view={concepts:[concept]} as ReleaseView;
  const result=await attachF2SourceSuggestions(async(sql,params)=>{
    assert.match(sql,/taxonomy_f2_segment_suggestions_readonly/);
    assert.deepEqual(params,[['0111301']]);
    return [{cnae_code:'0111301',atuacao:'Produtor rural',suggested_products:'Arroz',
      suggested_ncms:'1006',source_sha256:'695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67',
      source_batch_id:'batch'}] as never;
  },view);
  assert.equal(result.concepts[0]?.f2Source?.suggestedProducts,'');
  assert.equal(result.concepts[0]?.f2Source?.suggestedNcms,'000123');
  assert.equal(result.concepts[0]?.f2Source?.atuacao,'Produtor rural');
});
