/**
 * L-18: READ-ONLY preview of the 81-title recovery.
 * Reads the approved 26-date manifest, connects to INLABS and evaluates the
 * active collection filter. It DOES NOT create runs or persist publications,
 * archive receipts, discards or database state.
 *
 * Required: DATABASE_URL, INLABS_EMAIL, INLABS_PASSWORD.
 * Run after build: node dist/infrastructure/database/dou-l18-preview.js
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { DouConnector } from '../../modules/collection/dou.connector.js';
import { douBackfillBatches, planDouExplicitReplayDates, saoPauloDate } from '../../modules/collection/dou-backfill.js';
import { loadApprovedCollectionFilterRuntime, evaluateRuntimeCollectionFilter } from '../../modules/collection/collection-filter.runtime.js';
import { normalizePublication } from '../../modules/collection/publication.normalizer.js';
import { l18TitleKey } from './dou-l18-reconcile.js';
import type { ConnectorPublication } from '../../modules/collection/connector.contract.js';
import type { DB } from './database.types.js';

type Original = { date:string; section:string; title:string; actNumber:string; officialUrl:string };
type Manifest = {version:number; dates:string[]; sections:string[]; items:Original[]};
type Decision = {date:string;section:string;title:string;key:string;outcome:'MAINTAIN'|'DISCARD';reason:string;identity:string};
const originalKey = (date:string,section:string,title:string) =>
  date+'|'+section+'|'+l18TitleKey(title);
export function l18PreviewReconcile(manifest:Manifest, all:Decision[], sourceDiscarded:number) {
  const byKey = new Map<string,Decision[]>();
  for (const item of all) {
    const list = byKey.get(item.key) ?? [];
    list.push(item); byKey.set(item.key,list);
  }
  const matched = new Set<string>();
  const originals = manifest.items.map(row => {
    const key = originalKey(row.date,row.section,row.title);
    const rows = byKey.get(key) ?? [];
    const retained = [...new Map(rows.filter(x=>x.outcome==='MAINTAIN').map(x=>[x.identity,x])).values()];
    if (retained.length === 1) matched.add(retained[0]!.identity);
    return {
      date:row.date,section:row.section,title:row.title,
      status:retained.length === 1?'RECOVERABLE':retained.length > 1?'AMBIGUOUS':
        rows.some(x=>x.outcome==='DISCARD')?'DISCARDED_BY_FILTER':'NOT_FOUND',
    };
  });
  const count = (status:string) => originals.filter(x=>x.status===status).length;
  const maintained = new Map(all.filter(x=>x.outcome==='MAINTAIN').map(x=>[x.identity,x]));
  const excluded = all.filter(x=>x.outcome==='DISCARD');
  return {
    originals:manifest.items.length,
    recoverable:count('RECOVERABLE'),
    originalFiltered:count('DISCARDED_BY_FILTER'),
    ambiguous:count('AMBIGUOUS'),
    notFound:count('NOT_FOUND'),
    otherMaintained:[...maintained.keys()].filter(x=>!matched.has(x)).length,
    discardedByCollectionFilter:new Set(excluded.map(x=>x.identity)).size,
    discardedByConnectorScope:sourceDiscarded,
    totalDiscarded:new Set(excluded.map(x=>x.identity)).size+sourceDiscarded,
    originalsStatus:originals,
  };
}
function record(x:unknown):Record<string,unknown> {
  return x!==null&&typeof x==='object'&&!Array.isArray(x) ? x as Record<string,unknown> : {};
}
function checkManifest(m:Manifest) {
  if(m.version!==1||m.items.length!==81||m.dates.length!==26||
    new Set(m.dates).size!==26||m.sections.join(',')!=='DO1,DO1E,DO3'||
    new Set(m.items.map(x=>x.date)).size!==26||
    m.items.some(x=>!m.dates.includes(x.date)||!m.sections.includes(x.section)))
    throw new Error('L18_PREVIEW_INVALID_APPROVED_MANIFEST');
}
async function main() {
  if (process.argv.includes('--apply')||process.argv.includes('--ack-l18-81'))
    throw new Error('L18_PREVIEW_READ_ONLY_NO_APPLY');
  const databaseUrl=process.env.DATABASE_URL;
  if(!databaseUrl||!process.env.INLABS_EMAIL||!process.env.INLABS_PASSWORD)
    throw new Error('L18_PREVIEW_REQUIRES_DATABASE_URL_AND_INLABS_CREDENTIALS');
  const manifest=JSON.parse(readFileSync('ops/l18/recovery-manifest-81.json','utf8')) as Manifest;
  checkManifest(manifest);
  const dates=planDouExplicitReplayDates({dates:manifest.dates,today:saoPauloDate(new Date())});
  if(dates.length!==26)throw new Error('L18_PREVIEW_DATES_MISMATCH');
  const db=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:databaseUrl,max:2})})});
  try {
    const source=await db.selectFrom('sources').select(['id','code','connector_key','is_active'])
      .where('code','=','dou').executeTakeFirstOrThrow();
    if(!source.is_active||source.connector_key!=='dou')throw new Error('DOU_SOURCE_NOT_ACTIVE');
    const runtime=await loadApprovedCollectionFilterRuntime(db,source.id,{readOnly:true});
    if(!runtime)throw new Error('L18_PREVIEW_APPROVED_FILTER_REQUIRED');
    const all:Decision[]=[];
    let connectorIgnored=0;
    const batchReports:unknown[]=[];
    for(const datesBatch of douBackfillBatches(dates)){
      const connector=new DouConnector({
        dates:datesBatch,
        sections:['DO1','DO1E','DO3'],
        credentials:()=>({email:process.env.INLABS_EMAIL!,password:process.env.INLABS_PASSWORD!}),
        readState:async()=>({archives:{}}),
        allowEmptyBatch:true,
      });
      const abort=new AbortController();
      const result=await connector.collectIncremental({
        sourceId:source.id,runId:randomUUID(),attemptId:randomUUID(),signal:abort.signal,
      },async(publication:ConnectorPublication)=>{
        const normalized=normalizePublication({sourceId:source.id,publication});
        const decision=evaluateRuntimeCollectionFilter(runtime,normalized).decision;
        const dou=record(record(publication.metadata).dou);
        const date=normalized.publishedOn??String(dou.publicationDate??'');
        const section=String(dou.section??'');
        if(!datesBatch.includes(date)||!manifest.sections.includes(section))
          throw new Error('L18_PREVIEW_PUBLICATION_OUTSIDE_APPROVED_SCOPE');
        all.push({
          date,section,title:normalized.title,
          key:originalKey(date,section,normalized.title),
          outcome:decision.decision==='DISCARD'?'DISCARD':'MAINTAIN',
          reason:decision.reasonCode,
          identity:normalized.identityHash,
        });
      });
      const dou=record(record(result.metadata).dou);
      const scope=record(dou.scope);
      const ignored=Number(scope.ignoredCount??0);
      if(!Number.isSafeInteger(ignored)||ignored<0)throw new Error('L18_PREVIEW_SCOPE_TELEMETRY_UNAVAILABLE');
      connectorIgnored+=ignored;
      const problems=result.partialFailures??[];
      batchReports.push({dates:datesBatch,emitted:all.length,
        connectorScopeDiscarded:ignored,partialFailures:problems.map(x=>({code:x.code,itemReference:x.itemReference??null}))});
      console.log('L18_READ_ONLY_BATCH='+JSON.stringify(batchReports.at(-1)));
      if(problems.length)throw new Error('L18_PREVIEW_INCOMPLETE_ARCHIVES');
    }
    const matches=l18PreviewReconcile(manifest,all,connectorIgnored);
    console.log('L18_READ_ONLY_PREVIEW='+JSON.stringify({
      complete:true,dbWrites:0,policyId:runtime.policyId,policyVersion:runtime.policyVersion,
      policyRevision:runtime.policyRevision,sections:manifest.sections,dates,
      batches:batchReports, ...matches,
      note:'Recoverable is a read-only prediction, not proof of restored publications.',
    }));
  }finally{await db.destroy();}
}
if(process.argv[1]?.endsWith('dou-l18-preview.js')){
  void main().catch(err=>{console.error('L18_PREVIEW_FAILED='+String(err));process.exitCode=1;});
}
