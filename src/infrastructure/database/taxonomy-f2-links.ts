import 'dotenv/config';
import { Pool } from 'pg';
import { resolveCuratorDatabaseUrl } from './curator-url.js';
import { currentOperationalPlan } from '../../modules/taxonomy/curation/curation.f2-links.js';
import { assertCuratorSession } from '../../modules/taxonomy/curation/curation.draft.js';
import { findLatestPublishedRelease, findOpenDraft, pgRunner } from '../../modules/taxonomy/curation/curation.read.js';

if(!process.argv.includes('--plan') || process.argv.slice(2).some(arg=>!['--plan','--exclusions'].includes(arg))) {
  console.error('Usage: taxonomy:f2-links -- --plan [--exclusions] (read only; no apply/publication mode)'); process.exit(1);
}
const connectionString=resolveCuratorDatabaseUrl({
  DATABASE_URL:process.env.DATABASE_URL??'',
  DATABASE_CURATOR_URL:process.env.DATABASE_CURATOR_URL,
  DB_CURATOR_RUNTIME_PASSWORD:process.env.DB_CURATOR_RUNTIME_PASSWORD,
});
if(!connectionString) throw new Error('CURATOR_DATABASE_MISCONFIGURED');
const pool=new Pool({connectionString,max:1});
const client=await pool.connect();
try {
  await assertCuratorSession(client);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL ROLE radar_taxonomy_curator');
  await client.query("SET LOCAL statement_timeout='60s'");
  const draft=await findOpenDraft(pgRunner(client));
  const basis=draft ?? await findLatestPublishedRelease(pgRunner(client));
  if(!basis) throw new Error('NO_RELEASE_FOR_PLAN');
  const plan=await currentOperationalPlan(client,basis.id);
  console.log('F2_LINK_PLAN='+JSON.stringify({
    ruleVersion:plan.ruleVersion,planSha256:plan.planSha256,sourceSha256:plan.sourceSha256,
    basis:draft?'DRAFT':'PUBLISHED_PREVIEW_ONLY',version:basis.version,
    proposed:plan.links.length,products:plan.links.filter(l=>l.kind==='PRODUCT').length,
    ncms:plan.links.filter(l=>l.kind==='NCM').length,excluded:plan.exclusions.length,
    bySegment:plan.bySegment,
    exclusions:process.argv.includes('--exclusions')?plan.exclusions:undefined,
    excludedByReason:Object.fromEntries([...new Set(plan.exclusions.map(e=>e.reason))].sort().map(reason=>
      [reason,plan.exclusions.filter(e=>e.reason===reason).length])),published:false,profilesModified:false,
  }));
} catch(error) {
  console.error('F2_LINK_PLAN_FAILED'); process.exitCode=1;
} finally {
  await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end();
}
