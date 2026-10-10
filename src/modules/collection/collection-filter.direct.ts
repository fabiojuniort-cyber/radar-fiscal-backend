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
  newTypeId?: string;
}

interface Candidate {
  publication_id: string; title: string; act_type: string | null;
  section: string; content_text: string | null; relevant_excerpt: string | null;
  source_act_type: string | null; has_material: boolean;
  has_company: boolean; content_hash: string | null;
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

async function candidates(trx: Transaction<DB>, input: DirectRuleInput) {
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
  let cursor:string|null=null;
  let pages=0;
  const hash=createHash('sha256').update(JSON.stringify([rule,approved.id,approved.revision]));
  while (true) {
    if (++pages>1000) throw new Error('direct_filter_archive_limit_exceeded');
    const page=await sql<Candidate>`
      SELECT * FROM collection_filter_direct_candidates(${cursor}::uuid,500)
    `.execute(trx);
    if (!page.rows.length) break;
    for (const item of page.rows) {
      const decision=evaluateCollectionFilter(engine,{
        sourceCode:rule.sourceCode, section:item.section,
        actType:item.act_type,title:item.title,
        body:item.content_text,summary:item.relevant_excerpt,
        evidenceComplete:Boolean(item.content_text?.trim()),
        materialAttachmentsUnexamined:item.has_material,
        typeConflict:!!item.source_act_type && normalizeCollectionFilterType(item.source_act_type)
          !==normalizeCollectionFilterType(item.act_type??''),
        provenanceConflict:false,
      });
      if (decision.decision!=='DISCARD' || decision.canonicalType!==rule.canonicalType ||
          decision.section!==normalizeCollectionFilterType(rule.section)) continue;
      hash.update(item.publication_id).update(item.content_hash??'');
      if (item.has_company) blockedCompany++;
      else ids.push(item.publication_id);
    }
    cursor=page.rows[page.rows.length-1]!.publication_id;
    if (page.rows.length<500) break;
  }
  hash.update(String(blockedCompany));
  return {ids,count:ids.length,blockedCompany,token:hash.digest('hex')};
}

export async function previewDirectFilterRule(db:Kysely<DB>,userId:string,input:DirectRuleInput) {
  return withUserContext(db,userId,async trx=>{
    const {count,blockedCompany,token}=await candidates(trx,input);
    return {count,blockedCompany,token};
  });
}

export async function confirmDirectFilterRule(
  db:Kysely<DB>,userId:string,input:DirectRuleInput,
  expectedCount:number,previewToken:string,
) {
  return withUserContext(db,userId,async trx=>{
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('collection-filter-direct-rule',0)
    )`.execute(trx);
    const plan=await candidates(trx,input);
    if (plan.count!==expectedCount || plan.token!==previewToken)
      return {changed:true,count:plan.count,blockedCompany:plan.blockedCompany,
        token:plan.token,deletedCount:0};
    // The rule and all purge batches share a single transaction. Any FK, RLS,
    // append-only or audit failure rolls back both the rule and deletions.
    const rule=validated(input);
    const result=await sql<{policy_revision:number}>`
       SELECT * FROM collection_filter_direct_set_rule(
         ${rule.sourceCode},${rule.section},${rule.canonicalType},
         ${rule.mode},${rule.newTypeId??null}::uuid)
    `.execute(trx);
    const operationId=randomUUID();
    const ruleIds=plan.ids;
    for (let i=0;i<ruleIds.length;i+=100) {
      const batch=ruleIds.slice(i,i+100);
      await sql`SELECT collection_filter_direct_purge_batch(
        ${batch}::uuid[],${rule.sourceCode},${rule.section},
        ${rule.canonicalType},${rule.mode},${operationId}::uuid
      )`.execute(trx);
    }
    return {changed:false,deletedCount:ruleIds.length,
      revision:Number(result.rows[0]?.policy_revision)};
  });
}
