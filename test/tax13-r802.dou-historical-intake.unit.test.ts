import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
 preflightHistoricalDouIntake,type HistoricalDouIntakeInput
} from '../src/modules/taxonomy/legal-scope/dou-historical-intake.js';

const base:HistoricalDouIntakeInput={
 acquisitionChannel:'MANUAL',materialKind:'TEXT_TRANSCRIPTION',
 mediaType:'text/plain',actFamily:'CONVÊNIO ICMS',
 actNumber:'52/91',douPublishedOn:'1991-09-30',
 section:'DO1',sourceUrl:'https://incombeta.in.gov.br/diario-oficial-da-uniao',
 transcription:'Texto ainda não autenticado do Convênio ICMS 52/91.'
};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

test('DOU historical: operator transcription is unverified; no database bytes returned',()=>{
 const x=preflightHistoricalDouIntake(base);
 assert.equal(x.status,'HISTORICAL_SOURCE_CANDIDATE');
 assert.equal(x.authenticatedOfficialPublication,false);
 assert.equal(x.grantsLegalCurrent,false);
 assert.equal(x.legalVigency,'UNVERIFIED');
 assert.equal(x.candidate?.canonicalActNumber,'52/1991');
 assert.equal(x.candidate?.sourceReferenceLevel,'INDEX_ONLY');
 assert.equal(x.candidate?.fileSha256,null);
 assert.equal(x.candidate?.transcriptionSha256,sha(base.transcription!));
 assert.equal(JSON.stringify(x).includes(base.transcription!),false,
  'no transcription or bytes may be embedded in lightweight return metadata');
});
test('DOU historical: automatic and manual acquisition do not change authority',()=>{
 const manual=preflightHistoricalDouIntake(base);
 const automatic=preflightHistoricalDouIntake({...base,acquisitionChannel:'AUTO'});
 assert.equal(manual.authenticatedOfficialPublication,automatic.authenticatedOfficialPublication);
 assert.equal(manual.grantsLegalCurrent,automatic.grantsLegalCurrent);
 assert.equal(manual.candidate?.transcriptionSha256,automatic.candidate?.transcriptionSha256);
 assert.equal(automatic.candidate?.acquisitionChannel,'AUTO');
});
test('DOU historical: 100/97 page pointer from index only remains UNVERIFIED',()=>{
 const x=preflightHistoricalDouIntake({...base,actNumber:'100/97',
  douPublishedOn:'1997-11-06',page:25191,transcription:'Texto de teste Convênio 100/97'});
 assert.equal(x.candidate?.canonicalActNumber,'100/1997');
 assert.equal(x.candidate?.page,25191);
 assert.equal(x.authenticatedOfficialPublication,false);
 assert.ok(x.candidate?.outstandingGates.includes('INDEPENDENT_ARCHIVAL_CUSTODY_AUTHENTICATION'));
});
test('DOU historical: PNG, PDF and JPEG bytes are hashed but never persisted here',()=>{
 const png=Buffer.from('89504e470d0a1a0a01020304','hex');
 const x=preflightHistoricalDouIntake({...base,materialKind:'DOU_HISTORICAL_SCAN',
  mediaType:'image/png',fileBytes:png,transcription:undefined});
 assert.equal(x.status,'HISTORICAL_SOURCE_CANDIDATE');
 assert.equal(x.candidate?.fileSizeBytes,png.length);
 assert.equal(x.candidate?.fileSha256,createHash('sha256').update(png).digest('hex'));
 assert.equal(JSON.stringify(x).includes(png.toString('hex')),false);
 const forged=preflightHistoricalDouIntake({...base,materialKind:'DOU_HISTORICAL_SCAN',
  mediaType:'application/pdf',fileBytes:Buffer.from('NOT-PDF'),transcription:undefined});
 assert.equal(forged.status,'UNVERIFIED');
 assert.equal(forged.reason,'HISTORICAL_INTAKE_NOT_PDF');
});
test('DOU historical: spoofed source, directory traversal, excess size and bad edition fail closed',()=>{
 const cases:Array<Partial<HistoricalDouIntakeInput>>=[
  {sourceUrl:'https://evil.example/diario-oficial-da-uniao'},
  {sourceUrl:'https://incombeta.in.gov.br.evil.example/diario-oficial-da-uniao'},
  {sourceUrl:'http://incombeta.in.gov.br/diario-oficial-da-uniao'},
  {sourceUrl:'https://incombeta.in.gov.br@evil.example/diario-oficial-da-uniao'},
  {originalFilename:'../../suspicious.pdf'},
  {actNumber:'52/2026'},
  {douPublishedOn:'1991-02-30'},
  {douPublishedOn:'2020-09-30'},
  {page:0},
  {transcription:' '},
  {transcription:'x'.repeat(200001)},
  {fileBytes:Buffer.alloc(16*1024*1024+1)}
 ];
 for(const override of cases){
  const x=preflightHistoricalDouIntake({...base,...override});
  assert.equal(x.status,'UNVERIFIED',JSON.stringify({...override,fileBytes:undefined,transcription:typeof override.transcription==='string'?override.transcription.slice(0,20):undefined}));
  assert.equal(x.grantsLegalCurrent,false);
 }
 const none=preflightHistoricalDouIntake({...base,sourceUrl:undefined,transcription:undefined});
 assert.equal(none.status,'UNVERIFIED');
});
test('DOU historical: ambiguous short year 00 resolves to 2000, not 1900',()=>{
 const x=preflightHistoricalDouIntake({...base,
  actNumber:'1/00',douPublishedOn:'2000-01-20'});
 assert.equal(x.status,'HISTORICAL_SOURCE_CANDIDATE');
 assert.equal(x.candidate?.canonicalActNumber,'1/2000');
});

test('DOU historical operator CLI is dry-run only and requires explicit approval',async()=>{
 const {spawnSync}=await import('node:child_process');
 const flags=[
  '--channel=MANUAL','--kind=DOU_HISTORICAL_SCAN','--mime=application/pdf',
  '--family=CONVÊNIO ICMS','--act=52/91','--date=1991-09-30','--section=DO1',
  '--source-url=https://incombeta.in.gov.br/diario-oficial-da-uniao'
 ];
 const run=(approval:string|undefined)=>spawnSync(process.execPath,
  ['--import','tsx','src/tools/tax13-dou-historical-intake-cli.ts',...flags],
  {cwd:process.cwd(),encoding:'utf8',
   env:{...process.env,NODE_ENV:'test',
    TAX13_DOU_READ_ONLY_APPROVED:approval||''}});
 const denied=run(undefined);
 assert.notEqual(denied.status,0,'no run without intentional dry-run approval');
 const result=run('true');
 assert.equal(result.status,0,result.stderr.slice(-1200));
 const parsed=JSON.parse(result.stdout);
 assert.equal(parsed.status,'HISTORICAL_SOURCE_CANDIDATE');
 assert.equal(parsed.authenticatedOfficialPublication,false);
 assert.equal(parsed.grantsLegalCurrent,false);
 assert.equal(parsed.candidate.sourceReferenceLevel,'INDEX_ONLY');
});
test('DOU historical operator CLI checks bounded staging root and keeps file bytes out of stdout',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {mkdtemp,writeFile,rm,symlink}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'tax13-r802-historical-'));
 const pdf=join(root,'official-looking-not-certified.pdf');
 const bytes=Buffer.from('%PDF-1.7\nSynthetic. NO legal provenance.');
 const flags=[
  '--channel=MANUAL','--kind=DOU_HISTORICAL_SCAN','--mime=application/pdf',
  '--family=CONVÊNIO ICMS','--act=100/97','--date=1997-11-06',
  '--section=DO1','--page=25191'
 ];
 try{
  await writeFile(pdf,bytes);
  const exec=(file:string)=>spawnSync(process.execPath,
   ['--import','tsx','src/tools/tax13-dou-historical-intake-cli.ts',...flags,'--file='+file],
   {cwd:process.cwd(),encoding:'utf8',
    env:{...process.env,NODE_ENV:'test',TAX13_DOU_READ_ONLY_APPROVED:'true',
     TAX13_DOU_INTAKE_STAGING_ROOT:root}});
  const allowed=exec(pdf);
  assert.equal(allowed.status,0,allowed.stderr.slice(-1200));
  const result=JSON.parse(allowed.stdout);
  assert.equal(result.candidate.fileSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.authenticatedOfficialPublication,false);
  assert.equal(allowed.stdout.includes('Synthetic.'),false);
  const foreign=exec('/etc/hosts');
  assert.notEqual(foreign.status,0,'outside staging root forbidden');
  const link=join(root,'disguised.pdf');
  await symlink('/etc/hosts',link);
  assert.notEqual(exec(link).status,0,'symlink to external file forbidden');
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
