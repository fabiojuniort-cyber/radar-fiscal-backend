import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { CurationError, requireOpenDraft, type CuratorActor } from './curation.draft.js';
import { buildF2DraftPlan, readF2Stage } from './curation.f2-draft-import.js';
import { loadReleaseView, pgRunner, type SqlRunner } from './curation.read.js';
import { approveOperationalPlan, buildOperationalPlan, checkedOperationalApproval,
  type LinkApproval, type OperationalPlan, type ProposedLink } from './curation.f2-links.plan.js';

export async function currentOperationalPlan(client:PoolClient, releaseId?:string):Promise<OperationalPlan> {
  const id=releaseId ?? (await requireOpenDraft(client)).id;
  const snapshot=await readF2Stage(client);
  const imported=buildF2DraftPlan(snapshot); // exact pair, row hashes and full content digest
  const view=await loadReleaseView(pgRunner(client),id);
  if(!view) throw new CurationError('DRAFT_NOT_FOUND',404);
  const catalog=await client.query<{code:string; edition:string; source:string|null}>(`
    SELECT regexp_replace(e.official_code,'[^0-9]','','g') AS code,
           ed.edition_code AS edition,ed.source_sha256 AS source
    FROM official_catalog_entries e
    JOIN official_catalog_editions ed ON ed.id=e.catalog_edition_id
    JOIN official_catalogs c ON c.id=ed.catalog_id
    WHERE c.code='NCM' AND ed.status='CURRENT'
    ORDER BY e.official_code
  `);
  return buildOperationalPlan({
    sourceSha256:imported.contentSha256,
    sources:snapshot.segments.map(row=>({cnae:row.cnae_code,segment:row.raw_cells[1]??'',
      line:row.source_line,rowSha256:row.row_sha256,products:row.raw_cells[6]??'',ncms:row.raw_cells[7]??''})),
    concepts:view.concepts.map(c=>({code:c.code,dimensionCode:c.dimensionCode,label:c.label,
      membershipStatus:c.membershipStatus,officialCodes:c.officialCodes,
      ...(c.f2DraftSuggestions?{f2DraftSuggestions:c.f2DraftSuggestions}:{})})),
    catalogNcms:catalog.rows.map(r=>r.code),
    catalogIdentity:createHash('sha256').update(JSON.stringify(catalog.rows)).digest('hex'),
  });
}
export async function saveOperationalApproval(client:PoolClient,actor:CuratorActor,input:{
  planSha256:string; candidateIds:string[];
}):Promise<LinkApproval> {
  const draft=await requireOpenDraft(client);
  const plan=await currentOperationalPlan(client,draft.id);
  let approval:LinkApproval;
  try { approval=approveOperationalPlan(plan,{...input,approvedBy:actor.userId,justification:actor.justification}); }
  catch(error) { throw new CurationError(error instanceof Error?error.message:'F2_LINK_APPROVAL_INVALID',409); }
  const result=await client.query(`
    UPDATE taxonomy_releases SET manifest=jsonb_set(manifest,'{f2Operational}', $2::jsonb)
    WHERE id=$1::uuid AND status='DRAFT'
  `,[draft.id,JSON.stringify(approval)]);
  if(result.rowCount!==1) throw new CurationError('DRAFT_NOT_EDITABLE',409);
  // Reuse the existing allowlisted curation audit action; full approval evidence is in manifest.
  await client.query(`
    INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id)
    VALUES(NULL,'ADMIN',$1,'TAXONOMY_F2_SUGGESTIONS_CHANGED','taxonomy_curation',$2::uuid,
      public.audit_project('TAXONOMY_F2_SUGGESTIONS_CHANGED','taxonomy_curation',$3::jsonb),gen_random_uuid())
  `,[actor.userId,draft.id,JSON.stringify({conceptCode:'f2.operational_links',
    productsCount:approval.links.filter(l=>l.kind==='PRODUCT').length,
    ncmsCount:approval.links.filter(l=>l.kind==='NCM').length,justification:actor.justification})]);
  return approval;
}
/** Called inside the SAME locked transaction as publication. No implicit approval. */
export async function validateOperationalPublication(client:PoolClient,releaseId:string,manifest:unknown):Promise<LinkApproval|null> {
  const raw=manifest && typeof manifest==='object' ? (manifest as Record<string,unknown>).f2Operational : undefined;
  if(raw===undefined) return null; // Existing releases/curation are unchanged until explicitly opted in.
  try { return checkedOperationalApproval(await currentOperationalPlan(client,releaseId),raw); }
  catch(error) { throw new CurationError(error instanceof Error && /^F2_LINK_[A-Z_]+$/.test(error.message)
    ?error.message:'F2_LINK_PUBLICATION_INVALID',409); }
}
/** Read-only runtime contract: published evidence only, never the administrative overlay. */
export async function publishedOperationalLinks(run:SqlRunner,cnae:string):Promise<ProposedLink[]> {
  if(!/^\d{7}$/.test(cnae)) return [];
  const rows=await run<{approval:LinkApproval|null}>(`
    SELECT manifest->'f2Operational' AS approval FROM taxonomy_releases
    WHERE status='PUBLISHED'
    ORDER BY version_major DESC,version_minor DESC,version_patch DESC LIMIT 1
  `);
  const approval=rows[0]?.approval;
  if(!approval || approval.ruleVersion!=='onb03-t07-t08-v1' || !Array.isArray(approval.links)) return [];
  return approval.links.filter(link=>link.cnae===cnae);
}
