import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import {
  compileCollectionFilterPolicy, evaluateCollectionFilter,
  normalizeCollectionFilterType, type CollectionFilterMode,
  type CollectionFilterPolicyInput,
} from './collection-filter.engine.js';

export interface DirectRuleInput {
  sourceCode: string;
  section: string;
  canonicalType: string;
  mode: CollectionFilterMode;
  newTypeId?: string | undefined;
}

interface Candidate {
  publication_id: string; title: string; act_type: string | null;
  section: string; content_text: string | null; relevant_excerpt: string | null;
  evidence_complete:boolean; has_material:boolean;
  type_conflict:boolean; provenance_conflict:boolean;
  has_company:boolean; has_other_source:boolean; content_hash: string | null;
}

function validated(input: DirectRuleInput): DirectRuleInput {
  const sourceCode = input.sourceCode.trim().toLowerCase();
  const section = input.section.trim().toUpperCase();
  const canonicalType = normalizeCollectionFilterType(input.canonicalType);
  if (sourceCode !== 'dou') throw new RangeError('only_dou_direct_filter_supported');
  if (!section || !canonicalType ||
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
  // Push down source/section/normalized raw type (including aliases) before
  // fetching full text. The existing TS engine still owns final classification.
  const typeKeys=[...new Set([
    rule.canonicalType,
    ...rawAliases.rows.filter(a =>
      normalizeCollectionFilterType(a.source_code)===normalizeCollectionFilterType(rule.sourceCode)
      && normalizeCollectionFilterType(a.section)===normalizeCollectionFilterType(rule.section)
      && normalizeCollectionFilterType(a.canonical_type)===rule.canonicalType,
    ).map(a=>normalizeCollectionFilterType(a.normalized_alias)),
  ])];
  const ids:string[]=[];
  let blockedCompany=0;
  let blockedOtherSource=0;
  const blockedCompanyIds:string[]=[];
  const blockedOtherSourceIds:string[]=[];
  let cursor:string|null=null;
  let pages=0;
  const hash=createHash('sha256').update(JSON.stringify([rule,approved.id,approved.revision]));
  while (true) {
    if (++pages>1000) throw new Error('direct_filter_archive_limit_exceeded');
    const page=await sql<Candidate>`
      SELECT * FROM collection_filter_direct_candidates(${cursor}::uuid,500,${normalizeCollectionFilterType(rule.section)},${typeKeys}::text[])
    `.execute(trx);
    if (!page.rows.length) break;
    for (const item of page.rows) {
      const decision=evaluateCollectionFilter(engine,{
        sourceCode:rule.sourceCode, section:item.section,
        actType:item.act_type,title:item.title,
        body:item.content_text,summary:item.relevant_excerpt,
        evidenceComplete:item.evidence_complete,
        materialAttachmentsUnexamined:item.has_material,
        typeConflict:item.type_conflict,
        provenanceConflict:item.provenance_conflict,
      });
      if (decision.decision!=='DISCARD' || decision.canonicalType!==rule.canonicalType ||
          decision.section!==normalizeCollectionFilterType(rule.section)) continue;
      hash.update(item.publication_id).update(item.content_hash??'');
      if (item.has_company){blockedCompany++;blockedCompanyIds.push(item.publication_id);}
      else if (item.has_other_source){blockedOtherSource++;blockedOtherSourceIds.push(item.publication_id);}
      else ids.push(item.publication_id);
    }
    cursor=page.rows[page.rows.length-1]!.publication_id;
    if (page.rows.length<500) break;
  }
  hash.update(String(blockedCompany)).update(String(blockedOtherSource));
  return {ids,count:ids.length,blockedCompany,blockedOtherSource,
    blockedCompanyIds,blockedOtherSourceIds,token:hash.digest('hex')};
}

export async function previewDirectFilterRule(db:Kysely<DB>,userId:string,input:DirectRuleInput) {
  return withUserContext(db,userId,async trx=>{
    const {count,blockedCompany,blockedOtherSource,token}=await candidates(trx,input);
    return {count,blockedCompany,blockedOtherSource,token};
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
  expectedCount: number, previewToken: string, resume = false,
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
    if (plan.count !== expectedCount || plan.token !== previewToken) {
      return {changed:true,count:plan.count,blockedCompany:plan.blockedCompany,
        blockedOtherSource:plan.blockedOtherSource,token:plan.token,
        apagadas:0,restantes:plan.count,deletedCount:0};
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

    const MAX_DELETES_PER_CONFIRM=500;
    const SQL_PURGE_CHUNK=100; // SQL 051 rejects arrays above 100.
    let apagadas=0;
    const operationId=randomUUID();
    for (let offset=0;offset<Math.min(MAX_DELETES_PER_CONFIRM,plan.ids.length);offset+=SQL_PURGE_CHUNK) {
      // Return the committed partial step before reverse-proxy timeout.
      if (Date.now()-started>16000) break;
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
