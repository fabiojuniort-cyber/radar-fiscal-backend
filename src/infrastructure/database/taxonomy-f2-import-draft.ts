import 'dotenv/config';
import { Pool } from 'pg';
import {
  assertCuratorSession,
  withCuratorTransaction,
} from '../../modules/taxonomy/curation/curation.draft.js';
import {
  currentDraftPlan,
  applyF2Draft,
  safeF2DraftError,
} from '../../modules/taxonomy/curation/curation.f2-draft-import.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

function fail(code: string): never { throw new Error(code); }
function parse(args: string[]): {mode: 'plan' | 'apply'; batch: string | undefined; sha: string | undefined; exceptionSha: string | undefined} {
  const input: Record<string,string> = {};
  for (const arg of args) {
    const match=/^--(mode|confirm-batch-id|confirm-content-sha256|coord-approval-exceptions-sha256)=([^\s]+)$/.exec(arg);
    if (!match || input[match[1]!]!==undefined) fail('F2_DRAFT_INVALID_ARGUMENT');
    input[match[1]!]=match[2]!;
  }
  if (input.mode!=='plan' && input.mode!=='apply') fail('F2_DRAFT_EXPLICIT_MODE_REQUIRED');
  if (input.mode==='apply' &&
    (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input['confirm-batch-id']??'') ||
      !/^[0-9a-f]{64}$/.test(input['confirm-content-sha256']??'')))
    fail('F2_DRAFT_CONFIRMATION_REQUIRED');
  if (input['coord-approval-exceptions-sha256'] && !/^[0-9a-f]{64}$/.test(input['coord-approval-exceptions-sha256']))
    fail('F2_DRAFT_COORD_EXCEPTION_APPROVAL_INVALID');
  return {mode:input.mode,batch:input['confirm-batch-id'],sha:input['confirm-content-sha256'],
    exceptionSha:input['coord-approval-exceptions-sha256']};
}
async function run() {
  const args=parse(process.argv.slice(2));
  const connection=resolveCuratorDatabaseUrl({
    DATABASE_URL:process.env.DATABASE_URL??'',
    DATABASE_CURATOR_URL:process.env.DATABASE_CURATOR_URL,
    DB_CURATOR_RUNTIME_PASSWORD:process.env.DB_CURATOR_RUNTIME_PASSWORD,
  });
  if(!connection)fail('F2_DRAFT_CURATOR_CREDENTIAL_MISSING');
  const url=new URL(connection);
  if(!['postgres:','postgresql:'].includes(url.protocol))fail('F2_DRAFT_CURATOR_CONNECTION_INVALID');
  const pool=new Pool({connectionString:connection,max:1,connectionTimeoutMillis:10000});
  try {
    if(args.mode==='plan') {
      const client=await pool.connect();let tx=false;
      try {
        await assertCuratorSession(client);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');tx=true;
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const identity=await client.query<{version:number}>("SELECT current_setting('server_version_num')::int AS version");
        if(identity.rows[0]!.version<180000)fail('F2_DRAFT_PG18_REQUIRED');
        const preview=await currentDraftPlan(client);
        await client.query('COMMIT');tx=false;
        console.log('F2_DRAFT_PLAN='+JSON.stringify({
          draftId:preview.draftId,draftVersion:preview.draftVersion,
          batchId:preview.source.batchId,contentSha256:preview.source.contentSha256,
          staging:{segmento:preview.source.segmentoRows,produto:preview.source.produtoRows,
            errors:0,warnings:preview.source.expectedWarnings},
          invalidOfficialCodes:preview.validation.invalidOfficialCodes,
          invalidConceptInputs:preview.validation.invalidConceptInputs,
          dimensions:preview.audit.dimensions,
          groupSlugMerges:preview.audit.groupSlugMerges,
          requiresCoordApproval:preview.audit.requiresCoordApproval,
          exceptionsApprovalSha256:preview.audit.exceptionsApprovalSha256,
          alreadyImported:preview.alreadyImported,
          published:false,
        }));
      } finally {
        if(tx)await client.query('ROLLBACK').catch(()=>{});
        client.release();
      }
      return;
    }
    const result=await withCuratorTransaction(pool,async(client)=>{
      const identity=await client.query<{version:number}>("SELECT current_setting('server_version_num')::int AS version");
      if(identity.rows[0]!.version<180000)fail('F2_DRAFT_PG18_REQUIRED');
      return applyF2Draft(client,{
        userId:'ops:f2-draft-01',
        justification:'Importação explícita de lote F2 validado, apenas no rascunho',
      },{batchId:args.batch!,contentSha256:args.sha!,
        exceptionsApprovalSha256:args.exceptionSha});
    });
    console.log('F2_DRAFT_IMPORT_RESULT='+JSON.stringify(result));
  }finally {await pool.end();}
}
run().catch(e=>{
  // Structured, allowlisted identifiers only; no SQL, messages, URLs, or values.
  console.error(safeF2DraftError(e));
  process.exitCode=1;
});
