import { createHash, randomUUID } from 'node:crypto';
import {collectionFilterActName} from './collection-filter.act-name.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { validateActiveCollectionFilter } from './collection-filter.direct-admin.js';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import {
  compileCollectionFilterPolicy, evaluateCollectionFilter,
  normalizeCollectionFilterType, type CollectionFilterMode,
  type CollectionFilterPolicyInput, type CompiledCollectionFilterPolicy,
} from './collection-filter.engine.js';

export interface DirectRuleInput {
  sourceCode: string;
  section: string;
  canonicalType: string;
  mode: CollectionFilterMode;
  newTypeId?: string | undefined;
}

export interface HistoricalCollectionCandidate {
  publication_id: string; title: string; act_type: string | null;
  source_act_type: string | null; source_code: string;
  section: string; content_text: string | null; relevant_excerpt: string | null;
  evidence_complete:boolean; has_material:boolean;
  type_conflict:boolean; provenance_conflict:boolean;
  has_company:boolean; has_other_source:boolean; content_hash: string | null;
}

export function evaluateHistoricalCollectionCandidate(
  policy: CompiledCollectionFilterPolicy, item: HistoricalCollectionCandidate,
) {
  return evaluateCollectionFilter(policy, {
    sourceCode:item.source_code, section:item.section,
    sourceActType:item.source_act_type, title:item.title,
    body:item.content_text,
    evidenceComplete:item.evidence_complete,
    materialAttachmentsUnexamined:item.has_material,
    provenanceConflict:item.provenance_conflict,
  });
}

/**
 * Read-only source-type evidence for conflicts. Both admin purge entry points
 * use this identical resolution (origin or current version; never guess if
 * their official raw types disagree). One query per candidate page (<=500).
 */
export async function loadConflictingSourceActTypes(
  trx: Transaction<DB>, items: readonly {publication_id:string;type_conflict:boolean}[],
): Promise<Map<string,string>> {
  const conflictedIds=items.filter(item=>item.type_conflict).map(item=>item.publication_id);
  const sourceTypes=new Map<string,string>();
  if(!conflictedIds.length)return sourceTypes;
  const sourceEvidence=await sql<{
    publication_id:string; origin_type:string|null;version_type:string|null;
  }>`
    SELECT p.id AS publication_id,
      NULLIF(btrim(o.metadata->'dou'->>'sourceActType'),'') AS origin_type,
      NULLIF(btrim(v.source_metadata->'dou'->>'sourceActType'),'') AS version_type
    FROM public.publications p
    LEFT JOIN LATERAL (
      SELECT po.metadata FROM public.publication_origins po
      JOIN public.sources s ON s.id=po.source_id AND s.code='dou'
      WHERE po.publication_id=p.id ORDER BY po.id LIMIT 1
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT pv.source_metadata FROM public.publication_versions pv
      WHERE pv.publication_id=p.id AND pv.is_current LIMIT 1
    ) v ON TRUE
    WHERE p.id=ANY(${conflictedIds}::uuid[])
  `.execute(trx);
  for(const evidence of sourceEvidence.rows){
    const origin=evidence.origin_type?.trim();
    const version=evidence.version_type?.trim();
    if(origin && version &&
       normalizeCollectionFilterType(origin)!==normalizeCollectionFilterType(version))continue;
    const raw=origin??version;
    if(raw)sourceTypes.set(evidence.publication_id,raw);
  }
  return sourceTypes;
}

function validated(input: DirectRuleInput): DirectRuleInput {
  const sourceCode = input.sourceCode.trim().toLowerCase();
  const section = input.section.trim().toUpperCase();
  const canonicalType = normalizeCollectionFilterType(input.canonicalType);
  if (!['dou','doe-sp'].includes(sourceCode)) throw new RangeError('unsupported_direct_filter_source');
  if (!canonicalType ||
      !['KEEP_ALWAYS','KEEP_IF_TAX_TERM','EXCLUDE_UNLESS_STRONG','EXCLUDE_ALWAYS'].includes(input.mode))
    throw new RangeError('invalid_direct_rule');
  return {...input,sourceCode,section,canonicalType};
}

export async function candidates(trx: Transaction<DB>, input: DirectRuleInput) {
  const rule = validated(input);
  const policies = await sql<{
    id:string; version:number; revision:number;
    context_window_words:number; weak_score_threshold:number;
    title_weight:number; summary_weight:number; body_weight:number;
  }>`SELECT id,version,revision,context_window_words,weak_score_threshold,
       title_weight,summary_weight,body_weight FROM collection_filter_policies
       WHERE status='APPROVED'`.execute(trx);
  const approved=policies.rows[0];
  if (!approved) throw new Error('approved_collection_filter_required');
  const [rawRules,rawAliases,rawTerms] = await Promise.all([
    sql<{source_code:string;section:string;canonical_type:string;mode:CollectionFilterMode}>`
       SELECT source_code,section,canonical_type,mode FROM collection_filter_type_rules
       WHERE policy_id=${approved.id}::uuid`.execute(trx),
    sql<{source_code:string;section:string;normalized_alias:string;canonical_type:string}>`
       SELECT source_code,section,normalized_alias,canonical_type FROM collection_filter_type_aliases
       WHERE policy_id=${approved.id}::uuid`.execute(trx),
    sql<{term_text:string;strength:'STRONG'|'WEAK'|'NEGATIVE';source_code:string|null;
      section:string|null;canonical_type:string|null;location_scope:'ANY'|'TITLE'|'SUMMARY'|'BODY'}>`
       SELECT term_text,strength,source_code,section,canonical_type,location_scope
       FROM collection_filter_terms WHERE policy_id=${approved.id}::uuid`.execute(trx),
  ]);
  const document: CollectionFilterPolicyInput = {
    version:Number(approved.version),
    contextWindowWords:Number(approved.context_window_words),
    weakScoreThreshold:Number(approved.weak_score_threshold),
    locationWeights:{title:Number(approved.title_weight),
      summary:Number(approved.summary_weight),body:Number(approved.body_weight)},
    rules:[...rawRules.rows.filter(r =>
       !(r.source_code===rule.sourceCode && r.section===rule.section &&
         normalizeCollectionFilterType(r.canonical_type)===rule.canonicalType))
       .map(r=>({sourceCode:r.source_code,section:r.section,
         canonicalType:r.canonical_type,mode:r.mode})),
       {sourceCode:rule.sourceCode,section:rule.section,
         canonicalType:rule.canonicalType,mode:rule.mode}],
    aliases:rawAliases.rows.map(a=>({sourceCode:a.source_code,section:a.section,
      alias:a.normalized_alias,canonicalType:a.canonical_type})),
    terms:rawTerms.rows.map(t=>({text:t.term_text,strength:t.strength,
      ...(t.source_code?{sourceCode:t.source_code}:{}),
      ...(t.section?{section:t.section}:{}),
      ...(t.canonical_type?{canonicalType:t.canonical_type}:{}),
      locationScope:t.location_scope})),
  };
  const engine=compileCollectionFilterPolicy(document);
  const ids:string[]=[];
  let blockedCompany=0;
  let blockedOtherSource=0;
  const blockedCompanyIds:string[]=[];
  const blockedOtherSourceIds:string[]=[];
  const samples:Array<{id:string;title:string;sourceCode:string;section:string;
    officialType:string|null;actName:string;pattern:string;protection:string|null}>=[];
  let cursor:string|null=null;
  let pages=0;
  const hash=createHash('sha256').update(JSON.stringify(['F3-NOME-01',rule,approved.id,approved.revision]));
  while (true) {
    if (++pages>1000) throw new Error('direct_filter_archive_limit_exceeded');
    const page=await sql<HistoricalCollectionCandidate>`
      SELECT * FROM collection_filter_f3_candidates(${cursor}::uuid,500,${rule.sourceCode})
    `.execute(trx);
    if (!page.rows.length) break;
    for (const item of page.rows) {
      const decision=evaluateHistoricalCollectionCandidate(engine,item);
      if (decision.decision!=='DISCARD' || decision.canonicalType!==rule.canonicalType ||
          decision.mode!==rule.mode || decision.matchedSection!==normalizeCollectionFilterType(rule.section)) continue;
      hash.update(JSON.stringify([item.publication_id,item.content_hash,item.title,
        item.source_act_type,item.section,item.provenance_conflict,
        item.has_company,item.has_other_source,decision.reasonCode]));
      if (samples.length<10) samples.push({id:item.publication_id,title:item.title,
        sourceCode:item.source_code,section:item.section,officialType:item.source_act_type,
        actName:collectionFilterActName(item.title),
        pattern:decision.matchedPattern??decision.canonicalType,
        protection:item.has_company?'COMPANY':item.has_other_source?'OTHER_ORIGIN':null});
      if (item.has_company){blockedCompany++;blockedCompanyIds.push(item.publication_id);}
      else if (item.has_other_source){blockedOtherSource++;blockedOtherSourceIds.push(item.publication_id);}
      else ids.push(item.publication_id);
    }
    cursor=page.rows[page.rows.length-1]!.publication_id;
    if (page.rows.length<500) break;
  }
  hash.update(String(blockedCompany)).update(String(blockedOtherSource));
  const token=hash.digest('hex');
  const policyRevision=Number(approved.revision);
  const confirmationToken=createHash('sha256').update(JSON.stringify([
    'F3-NOME-01-HISTORICAL-PURGE-V3',rule,policyRevision,token,ids.length,
  ])).digest('hex');
  return {actName:collectionFilterActName(input.canonicalType),ids,count:ids.length,blockedCompany,blockedOtherSource,
    blockedCompanyIds,blockedOtherSourceIds,samples,token,confirmationToken,policyRevision};
}

export async function previewDirectFilterRule(db:Kysely<DB>,userId:string,input:DirectRuleInput) {
  return withUserContext(db,userId,async trx=>{
    const {actName,count,blockedCompany,blockedOtherSource,samples,token,
      policyRevision,confirmationToken}=await candidates(trx,input);
    return {actName,count,blockedCompany,blockedOtherSource,samples,token,
      policyRevision,confirmationToken};
  });
}

/**
 * One user-confirmed step. The rule is persisted once, then at most 500 DOU
 * publications are removed. Each subsequent step must re-count and provide a
 * fresh preview token, and can only continue an already-active identical rule.
 * Never accept client-supplied publication IDs.
 */
export async function confirmDirectFilterRule(
  db: Kysely<DB>, userId: string, input: DirectRuleInput,
  expectedCount: number, previewToken: string,
  policyRevision: number, confirmationToken: string, resume = false,
) {
  const started = Date.now();
  return withUserContext(db, userId, async trx => {
    // Transactional, bounded work: a slow SQL statement rolls back this step,
    // leaving earlier committed steps and their audit evidence intact.
    await sql`SET LOCAL statement_timeout = '11000ms'`.execute(trx);
    await sql`SET LOCAL lock_timeout = '2500ms'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('collection-filter-direct-rule',0)
    )`.execute(trx);
    const rule = validated(input);
    const plan = await candidates(trx,rule);
    if(plan.policyRevision!==policyRevision ||
       plan.confirmationToken!==confirmationToken)
      throw new RangeError('f3_confirmation_token_stale_or_policy_revision_changed');
    if (plan.count !== expectedCount || plan.token !== previewToken) {
      return {changed:true,count:plan.count,blockedCompany:plan.blockedCompany,
        blockedOtherSource:plan.blockedOtherSource,token:plan.token,
        apagadas:0,restantes:plan.count,deletedCount:0};
    }

    const selection = plan.ids.slice(0,500);
    if (selection.length) {
      await sql`SELECT public.l17_lock_confirmation_targets(${selection}::uuid[])`.execute(trx);
      const locked = await candidates(trx,rule);
      if (locked.policyRevision!==policyRevision ||
           locked.confirmationToken!==confirmationToken)
         throw new RangeError('f3_confirmation_token_stale_or_policy_revision_changed');
       if (locked.count !== plan.count || locked.token !== plan.token) {
        return {changed:true,count:locked.count,blockedCompany:locked.blockedCompany,
          blockedOtherSource:locked.blockedOtherSource,token:locked.token,
          apagadas:0,restantes:locked.count,deletedCount:0};
      }
    }

    let revision: number;
    if (resume) {
      // Never re-save the rule on subsequent steps: a different admin may
      // have changed it. The caller must explicitly confirm any new rule.
      const active = await sql<{revision:number}>`
        SELECT p.revision FROM collection_filter_policies p
        JOIN collection_filter_type_rules r ON r.policy_id=p.id
        WHERE p.status='APPROVED'
          AND r.source_code=${rule.sourceCode}
          AND r.section=${rule.section}
          AND r.canonical_type=${rule.canonicalType}
          AND r.mode=${rule.mode}
        LIMIT 1
      `.execute(trx);
      if (!active.rows[0]) throw new RangeError('confirmed_rule_not_active');
      revision=Number(active.rows[0].revision);
    } else {
      const updated=await sql<{policy_revision:number}>`
        SELECT * FROM collection_filter_direct_set_rule(
          ${rule.sourceCode},${rule.section},${rule.canonicalType},
          ${rule.mode},${rule.newTypeId??null}::uuid)
      `.execute(trx);
      revision=Number(updated.rows[0]?.policy_revision);
    }

    await validateActiveCollectionFilter(trx);
    const lockedPolicy=await sql<{revision:number}>`SELECT public.collection_filter_confirm_policy_lock() AS revision`.execute(trx);
    if(Number(lockedPolicy.rows[0]?.revision)!==revision) throw new Error('collection_filter_policy_changed');
    const MAX_DELETES_PER_CONFIRM=500;
    const SQL_PURGE_CHUNK=100; // SQL 051 rejects arrays above 100.
    let apagadas=0;
    const operationId=randomUUID();
    for (let offset=0;offset<Math.min(MAX_DELETES_PER_CONFIRM,plan.ids.length);offset+=SQL_PURGE_CHUNK) {
      // Return the committed partial step before reverse-proxy timeout.
      // Eligibility/revalidation may consume the budget on a large archive.
      // Once safely confirmed, execute one bounded batch so the step progresses.
      if (offset>0 && Date.now()-started>16000) break;
      const batch=plan.ids.slice(offset,offset+SQL_PURGE_CHUNK);
      const purged=await sql<{count:number}>`
        SELECT collection_filter_direct_purge_batch(
          ${batch}::uuid[],${rule.sourceCode},${rule.section},
          ${rule.canonicalType},${rule.mode},${operationId}::uuid
        ) AS count
      `.execute(trx);
      const actual=Number(purged.rows[0]?.count);
      if (actual!==batch.length) throw new Error('direct_purge_count_mismatch');
      apagadas+=actual;
    }
    if (plan.count===0 || (plan.count>0 && apagadas===0)) {
      // Audit also a no-op step. A client treats zero progress as stopped,
      // never retries automatically.
      await sql`SELECT collection_filter_direct_purge_batch(
        ARRAY[]::uuid[],${rule.sourceCode},${rule.section},
        ${rule.canonicalType},${rule.mode},${operationId}::uuid
      )`.execute(trx);
    }
    // Re-evaluate the actual surviving archive inside this transaction.
    // Concurrent recapture and protected records must not leave a stale
    // "remaining = initial - deleted" estimate in the API response.
    const current=await candidates(trx,rule);
    return {changed:false,apagadas,restantes:current.count,
      deletedCount:apagadas,revision,elapsedMs:Date.now()-started};
  });
}

/**
 * Non-destructive classification. Saving a rule can never delete a publication;
 * historical purge requires a separate fresh revision-bound capability.
 */
export async function saveDirectFilterRule(
  db: Kysely<DB>, userId: string, input: DirectRuleInput,
  expectedCount: number, previewToken: string,
  policyRevision: number, confirmationToken: string,
):Promise<{revision:number;deletedCount:0;historicalPurgeRequired:true}> {
  return withUserContext(db,userId,async trx=>{
    await sql`SET LOCAL statement_timeout = '11000ms'`.execute(trx);
    await sql`SET LOCAL lock_timeout = '2500ms'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('collection-filter-direct-rule',0))`.execute(trx);
    const rule=validated(input);
    const plan=await candidates(trx,rule);
    if(plan.policyRevision!==policyRevision ||
       plan.confirmationToken!==confirmationToken ||
       plan.count!==expectedCount || plan.token!==previewToken)
      throw new RangeError('f3_preview_expired_or_policy_revision_changed');
    const result=await sql<{policy_revision:number}>`
      SELECT * FROM collection_filter_direct_set_rule(
        ${rule.sourceCode},${rule.section},${rule.canonicalType},
        ${rule.mode},${rule.newTypeId??null}::uuid)
    `.execute(trx);
    await validateActiveCollectionFilter(trx);
    return {revision:Number(result.rows[0]?.policy_revision),
      deletedCount:0 as const,historicalPurgeRequired:true as const};
  });
}
