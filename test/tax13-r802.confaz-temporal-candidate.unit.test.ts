import assert from 'node:assert/strict';
import test from 'node:test';
import {assessDouConfazTemporalCandidate} from '../src/modules/taxonomy/legal-scope/dou-confaz-temporal-candidate.js';

const case15={
 actReference:'CONVENIO_ICMS:15:2024',
 originalActOfficialUrl:'https://www.confaz.fazenda.gov.br/legislacao/convenios/2024/CV015_24',
 originalPublishedOn:'2024-04-25',
 ratificationActOfficialUrl:'https://www.confaz.fazenda.gov.br/legislacao/atos-declaratorios/2024/ad010_24',
 ratificationReferences:['CONVENIO_ICMS:15:2024'],
 ratificationPublishedOn:'2024-05-02',
 declaredEffectsFrom:'2024-04-01',
 exceptionalDeadline:'2024-04-25',
 referenceDate:'2026-10-10',
} as const;

test('CONFAZ 15/24: ratification and retrospective effects are separate from elapsed deadline and CURRENT',()=>{
 const result=assessDouConfazTemporalCandidate(case15);
 assert.equal(result.status,'DOU_RATIFICATION_TEMPORAL_FACTS_ONLY');
 assert.equal(result.grantsLegalCurrent,false);
 if(result.status==='UNVERIFIED')return;
 assert.equal(result.originalPublishedOn,'2024-04-25');
 assert.equal(result.ratificationPublishedOn,'2024-05-02');
 assert.equal(result.declaredEffectsFrom,'2024-04-01');
 assert.equal(result.exceptionalDeadline,'2024-04-25');
 assert.equal(result.ratificationAfterExceptionalDeadline,true);
 assert.equal(result.exceptionalDeadlineBeforeReferenceDate,true);
 assert.equal(result.operationalEffectInReferencePeriod,'NOT_ASSESSED');
 assert.equal(result.amendmentsAndRevocationReview,'NOT_PERFORMED');
});

test('CONFAZ timing candidate cannot infer historical payment deadline as ongoing payment obligation',()=>{
 for(const asOf of ['2024-04-20','2024-04-25','2024-05-03','2026-10-10']){
  const r=assessDouConfazTemporalCandidate({...case15,referenceDate:asOf});
  assert.equal(r.status,'DOU_RATIFICATION_TEMPORAL_FACTS_ONLY');
  assert.equal(r.grantsLegalCurrent,false);
  if(r.status==='UNVERIFIED')continue;
  assert.equal(r.exceptionalDeadlineBeforeReferenceDate,asOf>'2024-04-25');
  assert.equal(r.operationalEffectInReferencePeriod,'NOT_ASSESSED');
 }
});

test('CONFAZ timing inputs reject spoofed official host, false ratification or impossible dates',()=>{
 const invalid=[
  {...case15,ratificationReferences:['CONVENIO_ICMS:16:2024']},
  {...case15,originalActOfficialUrl:'https://www.confaz.fazenda.gov.br.evil.example/legislacao/convenios/2024/CV015_24'},
  {...case15,ratificationActOfficialUrl:'http://www.confaz.fazenda.gov.br/legislacao/atos-declaratorios/2024/ad010_24'},
  {...case15,originalPublishedOn:'2024-02-31'},
  {...case15,ratificationPublishedOn:'2024-04-20'},
  {...case15,declaredEffectsFrom:'2025-04-01'},
  {...case15,exceptionalDeadline:'2024-13-01'},
  {...case15,ratificationActOfficialUrl:'https://www.confaz.fazenda.gov.br/legislacao/atos-declaratorios/2024/ad010_24?x=1'},
 ];
 for(const sample of invalid){
  const outcome=assessDouConfazTemporalCandidate(sample);
  assert.equal(outcome.status,'UNVERIFIED',JSON.stringify(sample));
  assert.equal(outcome.grantsLegalCurrent,false);
 }
});
