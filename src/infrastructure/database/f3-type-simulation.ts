import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import {
  compileCollectionFilterPolicy, evaluateCollectionFilter, collectionFilterTitleType,
  normalizeCollectionFilterType, normalizeCollectionFilterSection, normalizeCollectionFilterText,
  type CollectionFilterPolicyInput, type CollectionFilterPublication,
  type CollectionFilterDecision,
} from '../../modules/collection/collection-filter.engine.js';

type Verdict = 'KEEP' | 'DISCARD';
type Status = 'kept' | 'eligible' | 'protected';
const POMPEIA_ID = '65411060-690d-46ac-8153-ce51562ea1f4';
type PublicSample = {
  publicationId: string; title: string; publishedOn: string | null; source: string;
  section: string; officialType: string; titleType: string; before: Verdict; after: Verdict;
  reason: string; protection: string[];
};
export interface SimulationResultRow {
  publicationId: string; source: string; section: string; oldConflict: boolean;
  before: Verdict; after: Verdict; hasCompany: boolean; originCount: number;
  sample: PublicSample;
}
export function classifySimulationPublication(rows: readonly SimulationResultRow[]): Status {
  if (!rows.length) throw new Error('empty_publication_group');
  if (!rows.some(row => row.after === 'DISCARD')) return 'kept';
  if (rows.some(row => row.hasCompany || row.originCount > 1)) return 'protected';
  return rows.every(row => row.after === 'DISCARD') ? 'eligible' : 'kept';
}
export function summarizeSimulation(rows: readonly SimulationResultRow[]) {
  const groups = new Map<string, SimulationResultRow[]>();
  for (const row of rows) {
    const group = groups.get(row.publicationId) ?? [];
    group.push(row); groups.set(row.publicationId, group);
  }
  const counts = { kept: 0, eligible: 0, protected: 0 };
  const samples: Record<Status, PublicSample[]> = {kept: [], eligible: [], protected: []};
  const conflicts: Record<string, {publications: number; beforeKeep: number; beforeDiscard: number;
    afterKeep: number; afterDiscard: number; keepToDiscard: number; discardToKeep: number}> = {};
  for (const group of groups.values()) {
    const status = classifySimulationPublication(group); counts[status]++;
    const preferred = group.find(row => row.after === 'DISCARD') ?? group[0]!;
    if (samples[status].length < 10) samples[status].push(preferred.sample);
    for (const section of ['DO1', 'DO3']) {
      const relevant = group.filter(row => row.source === 'dou' && row.section === section && row.oldConflict);
      if (!relevant.length) continue;
      const before: Verdict = relevant.some(row => row.before === 'KEEP') ? 'KEEP' : 'DISCARD';
      const after: Verdict = relevant.some(row => row.after === 'KEEP') ? 'KEEP' : 'DISCARD';
      const counter = conflicts[section] ??= {publications:0, beforeKeep:0, beforeDiscard:0,
        afterKeep:0, afterDiscard:0, keepToDiscard:0, discardToKeep:0};
      counter.publications++; counter[before === 'KEEP' ? 'beforeKeep' : 'beforeDiscard']++;
      counter[after === 'KEEP' ? 'afterKeep' : 'afterDiscard']++;
      if (before === 'KEEP' && after === 'DISCARD') counter.keepToDiscard++;
      if (before === 'DISCARD' && after === 'KEEP') counter.discardToKeep++;
    }
  }
  return {publications: groups.size, counts, conflicts, samples};
}

export function listRuleRedundancies(policy: CollectionFilterPolicyInput) {
  const rules = policy.rules.filter(rule => ['dou','doe-sp'].includes(rule.sourceCode.toLowerCase()));
  const result: Array<{source:string; section:string; pattern:string; candidates:
    Array<{type:string; mode:string; normalized:string; kind:'NORMALIZED_COLLISION'|'PREFIX_VARIANT'}>}> = [];
  for (const rule of rules) {
    const pattern = normalizeCollectionFilterType(rule.canonicalType);
    if (!pattern) continue;
    const candidates = rules.filter(other => other !== rule
      && other.sourceCode.toLowerCase() === rule.sourceCode.toLowerCase()
      && normalizeCollectionFilterText(other.section ?? '') === normalizeCollectionFilterText(rule.section ?? ''))
      .map(other => ({type:other.canonicalType, mode:other.mode, normalized:normalizeCollectionFilterType(other.canonicalType)}))
      .filter(other => other.normalized === pattern || other.normalized.startsWith(pattern + ' '))
      .map(other => ({...other, kind:other.normalized === pattern ? 'NORMALIZED_COLLISION' as const : 'PREFIX_VARIANT' as const}));
    if (candidates.length) result.push({source:rule.sourceCode, section:normalizeCollectionFilterText(rule.section ?? ''), pattern, candidates});
  }
  return result;
}

const POLICY_SQL = `SELECT p.id, p.version, p.revision, p.created_at,
  jsonb_build_object('version',p.version,'contextWindowWords',p.context_window_words,
    'weakScoreThreshold',p.weak_score_threshold,'locationWeights',jsonb_build_object(
      'title',p.title_weight,'summary',p.summary_weight,'body',p.body_weight),
    'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceCode',r.source_code,
      'section',r.section,'canonicalType',r.canonical_type,'mode',r.mode)
      ORDER BY r.source_code,r.section,r.canonical_type) FROM public.collection_filter_type_rules r WHERE r.policy_id=p.id),'[]'::jsonb),
    'aliases',COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceCode',a.source_code,
      'section',a.section,'alias',a.normalized_alias,'canonicalType',a.canonical_type)
      ORDER BY a.source_code,a.section,a.normalized_alias) FROM public.collection_filter_type_aliases a WHERE a.policy_id=p.id),'[]'::jsonb),
    'terms',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('text',t.term_text,
      'strength',t.strength,'sourceCode',NULLIF(t.source_code,''),'section',NULLIF(t.section,''),
      'canonicalType',NULLIF(t.canonical_type,''),'locationScope',t.location_scope))
      ORDER BY t.strength,t.normalized_term) FROM public.collection_filter_terms t WHERE t.policy_id=p.id),'[]'::jsonb)) AS document
  FROM public.collection_filter_policies p WHERE p.status='APPROVED' ORDER BY p.version DESC LIMIT 1`;

const PUBLICATIONS_SQL = `WITH page AS (
  SELECT p.id,p.title,p.act_type,p.published_on,p.first_collected_at FROM public.publications p
  WHERE ($1::uuid IS NULL OR p.id>$1::uuid)
    AND EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources s ON s.id=po.source_id
      WHERE po.publication_id=p.id AND lower(s.code) IN ('dou','doe-sp')) ORDER BY p.id LIMIT 500
)
SELECT p.*,s.code AS source_code,o.id AS origin_id,o.metadata AS origin_metadata,
  v.id AS version_id,v.source_metadata AS version_metadata,v.content_text,v.relevant_excerpt,v.captured_at,
  (SELECT pv.captured_at FROM public.publication_versions pv WHERE pv.publication_id=p.id AND pv.version_no=1 LIMIT 1) AS first_version_captured_at,
  (SELECT count(*)::int FROM public.publication_versions pv WHERE pv.publication_id=p.id AND pv.is_current) AS current_version_count,
  EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id) AS has_company,
  (SELECT count(*)::int FROM public.publication_origins po WHERE po.publication_id=p.id) AS origin_count,
  EXISTS(SELECT 1 FROM public.publication_files pf WHERE pf.publication_version_id=v.id) AS has_file
FROM page p JOIN public.publication_origins o ON o.publication_id=p.id
JOIN public.sources s ON s.id=o.source_id AND lower(s.code) IN ('dou','doe-sp')
LEFT JOIN LATERAL(SELECT pv.id,pv.source_metadata,pv.content_text,pv.relevant_excerpt,pv.captured_at
  FROM public.publication_versions pv WHERE pv.publication_id=p.id AND pv.is_current
  ORDER BY pv.version_no DESC,pv.id LIMIT 1) v ON true ORDER BY p.id,o.id`;

function record(value: unknown): Record<string,unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function text(value:unknown):string {return typeof value === 'string' ? value.trim() : '';}
export function historicalMaterial(origin:Record<string,unknown>,version:Record<string,unknown>,hasFile:boolean):boolean {
  const files=origin.files??version.files;
  const metadata={files,dou:origin.dou??version.dou};
  return hasMaterial(metadata) || (!Array.isArray(files) && hasFile);
}
function hasMaterial(metadata:Record<string,unknown>):boolean {
  const dou = record(metadata.dou);
  return (Array.isArray(metadata.files) && metadata.files.some(file => {
    const f=record(file); return f.versionRole !== 'PROVENANCE' && (f.versionRole === 'MATERIAL_CONTENT' || record(f.metadata).kind === 'ATTACHMENT');
  })) || (Array.isArray(dou.parts) && dou.parts.some(part => ['true',true].includes(record(part).hasHighlightImage as string|boolean)));
}
type Baseline = {
  compileCollectionFilterPolicy(input:CollectionFilterPolicyInput):unknown;
  evaluateCollectionFilter(policy:unknown, input:CollectionFilterPublication):{decision:Verdict; reasonCode:string};
  collectionFilterTypeConflict(official:string, parsed:string):boolean;
};
interface ArchiveRow {
  id:string; title:string; act_type:string|null; published_on:string|Date|null;
  source_code:string; origin_metadata:unknown; version_metadata:unknown;
  content_text:string|null; relevant_excerpt:string|null; current_version_count:number;
  has_company:boolean; origin_count:number; has_file:boolean;
  first_collected_at:string|Date|null; captured_at:string|Date|null; first_version_captured_at:string|Date|null;
}
interface SavedRule {
  id:string; source_code:string; section:string; canonical_type:string; mode:string; created_at:string|Date;
}
type PompeiaEvidence = {
  publicationId:string; source:string; rawSection:string; originSection:string; versionSection:string;
  officialType:string; originOfficialType:string; versionOfficialType:string; titleType:string; title:string;
  firstCollectedAt:string|Date|null; firstVersionCapturedAt:string|Date|null; currentVersionCapturedAt:string|Date|null;
  capturedAtField:'publication_versions.captured_at'; before:Verdict; beforeReason:string;
  after:Verdict; afterReason:string; matchedPattern:string|null; matchedTypeSource:string|null;
  provenanceConflict:boolean; protection:string[]; winningRule:SavedRule|null;
  ruleCreatedAfterInitialCapture:boolean|null;
};
const sha256 = (data:string|Buffer) => createHash('sha256').update(data).digest('hex');

/** All SQL is static SELECT, plus read-only transaction control. No write/execute branch. */
export async function runF3TypeSimulation(client: Client, baseline: Baseline) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshot = (await client.query(`SELECT transaction_timestamp() AS taken_at, pg_current_snapshot()::text AS snapshot,
      current_setting('transaction_read_only') AS read_only,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unfiltered`)).rows[0];
    if (snapshot.read_only !== 'on' || snapshot.unfiltered !== true) throw new Error('readonly_unfiltered_role_required');
    const policyRow = (await client.query(POLICY_SQL)).rows[0];
    if (!policyRow) throw new Error('approved_policy_required');
    const input = policyRow.document as CollectionFilterPolicyInput;
    const savedRules=(await client.query<SavedRule>(`SELECT id,source_code,section,canonical_type,mode,created_at
      FROM public.collection_filter_type_rules WHERE policy_id=$1 ORDER BY source_code,section,canonical_type`,[policyRow.id])).rows;
    const next = compileCollectionFilterPolicy(input), previous = baseline.compileCollectionFilterPolicy(input);
    const results:SimulationResultRow[] = [];
    const pompeiaOrigins:PompeiaEvidence[]=[];
    const unknowns = new Map<string,{source:string; section:string; input:'OFFICIAL'|'TITLE'; type:string; publications:Set<string>}>();
    let after:string|null=null;
    for (;;) {
      const page:ArchiveRow[] = (await client.query<ArchiveRow>(PUBLICATIONS_SQL,[after])).rows;
      if (!page.length) break;
      for (const row of page) {
        const source=text(row.source_code).toLowerCase(), o=record(row.origin_metadata), v=record(row.version_metadata);
        const od=source === 'dou' ? record(o.dou):o, vd=source === 'dou' ? record(v.dou):v;
        const os=text(od.section), vs=text(vd.section), ot=text(od[source === 'dou'?'sourceActType':'publicationType']), vt=text(vd[source === 'dou'?'sourceActType':'publicationType']);
        const section=normalizeCollectionFilterSection(os||vs).replace(/^(DO[123])E$/,'$1'), official=ot||vt, title=text(row.title);
        const conflict=baseline.collectionFilterTypeConflict(official,text(row.act_type));
        const publication:CollectionFilterPublication = {
          sourceCode:source,section:os||vs,sourceActType:official,actType:text(row.act_type),title,
          body:text(row.content_text),typeConflict:conflict,
          evidenceComplete:Boolean(text(row.content_text)) && row.current_version_count===1
            && ![od,vd].some(meta => meta.scopeStructureIncomplete===true || meta.scopeStructureIncomplete==='true'
              || Object.prototype.hasOwnProperty.call(meta,'titleFallback')),
          materialAttachmentsUnexamined:historicalMaterial(o,v,row.has_file),
          provenanceConflict:row.current_version_count !== 1
            || Boolean(os && vs && normalizeCollectionFilterText(os)!==normalizeCollectionFilterText(vs))
            || Boolean(ot && vt && normalizeCollectionFilterType(ot)!==normalizeCollectionFilterType(vt)),
        };
        // Legacy runtime did not pass relevant_excerpt as summary.
        const legacyInput = {...publication,section:os||vs,summary:null,
          materialAttachmentsUnexamined:row.has_file || hasMaterial(o) || hasMaterial(v)};
        const oldDecision = source === 'dou' ? baseline.evaluateCollectionFilter(previous,legacyInput)
          : {decision:'KEEP' as const,reasonCode:'BASELINE_POLICY_NOT_ENFORCED'};
        const before:Verdict=oldDecision.decision;
        const decision:CollectionFilterDecision=evaluateCollectionFilter(next,publication);
        const protection = [row.has_company ? 'COMPANY_MATCH':null, row.origin_count>1 ? 'OTHER_ORIGIN':null].filter((x):x is string=>Boolean(x));
        if (row.id===POMPEIA_ID) {
          const winningRule=savedRules.find(rule => normalizeCollectionFilterText(rule.source_code)===normalizeCollectionFilterText(source)
            && normalizeCollectionFilterText(rule.section)===normalizeCollectionFilterText(decision.matchedSection??'')
            && normalizeCollectionFilterType(rule.canonical_type)===decision.canonicalType
            && rule.mode===decision.mode)??null;
          const captured=row.first_version_captured_at??row.first_collected_at;
          pompeiaOrigins.push({publicationId:row.id,source,rawSection:os||vs,originSection:os,versionSection:vs,
            officialType:official.slice(0,160),originOfficialType:ot.slice(0,160),versionOfficialType:vt.slice(0,160),
            titleType:collectionFilterTitleType(title).slice(0,160),title:title.slice(0,240),
            firstCollectedAt:row.first_collected_at??null,firstVersionCapturedAt:row.first_version_captured_at??null,
            currentVersionCapturedAt:row.captured_at??null,capturedAtField:'publication_versions.captured_at',
            before,beforeReason:oldDecision.reasonCode,after:decision.decision,afterReason:decision.reasonCode,
            matchedPattern:decision.matchedPattern??null,matchedTypeSource:decision.matchedTypeSource??null,
            provenanceConflict:publication.provenanceConflict??false,protection,winningRule,
            ruleCreatedAfterInitialCapture:winningRule&&captured?new Date(winningRule.created_at)>new Date(captured):null});
        }
        results.push({publicationId:row.id,source,section,oldConflict:source === 'dou' && conflict,before,
          after:decision.decision,hasCompany:row.has_company,originCount:row.origin_count,
          sample:{publicationId:row.id,title:title.slice(0,240),publishedOn:row.published_on ? new Date(row.published_on).toISOString().slice(0,10):null,
            source,section,officialType:official.slice(0,160),titleType:collectionFilterTitleType(title).slice(0,160),
            before,after:decision.decision,reason:decision.reasonCode,protection}});
        for (const [kind,raw] of [['OFFICIAL',official],['TITLE',collectionFilterTitleType(title)]] as const) {
          const normalized=normalizeCollectionFilterType(raw); if(!normalized) continue;
          const probe=evaluateCollectionFilter(next,{...publication,sourceActType:kind==='OFFICIAL'?raw:'',
            actType:'',title:kind==='TITLE'?raw:''});
          if (probe.reasonCode!=='UNKNOWN_TYPE') continue;
          const key=JSON.stringify([source,section,kind,normalized]);
          const bucket=unknowns.get(key)??{source,section,input:kind,type:normalized,publications:new Set<string>()};
          bucket.publications.add(row.id); unknowns.set(key,bucket);
        }
      }
      after=page[page.length-1]!.id;
    }
    const report={formatVersion:1,snapshot,policy:{id:policyRow.id,version:policyRow.version,revision:policyRow.revision,createdAt:policyRow.created_at??null,
      sha256:sha256(JSON.stringify(input)),ruleCount:input.rules.length},
      ...summarizeSimulation(results),originsEvaluated:results.length,
      pompeia:{publicationId:POMPEIA_ID,found:pompeiaOrigins.length>0,origins:pompeiaOrigins},
      unknownTypesTop20:[...unknowns.values()].map(bucket=>({...bucket,publications:bucket.publications.size}))
        .sort((a,b)=>b.publications-a.publications||a.type.localeCompare(b.type,'en')).slice(0,20),
      redundancies:listRuleRedundancies(input),
      notes:['DOE-SP baseline KEEP: old policy was not enforced; connector-specific capture filters are not replayed.',
        'All extra origins conservatively protect the publication; no origin is removed.',
        'Existing archive only; records previously discarded or deleted cannot be reconstructed.',
        'Simulation is not a deletion preview authorization. No destructive operation is available.']};
    await client.query('ROLLBACK'); return report;
  } catch(error) {await client.query('ROLLBACK').catch(()=>undefined); throw error;}
}

export async function f3SimulationMain(args=process.argv.slice(2)) {
  const permitted=args.length===0 || (args.length===2 && args[0]==='--output' && Boolean(args[1]));
  if (!permitted) throw new Error('only_output_option_supported');
  const connectionString=process.env.F3_SIMULATION_DATABASE_URL;
  if (!connectionString) throw new Error('simulation_database_url_required');
  const baselineUrl=pathToFileURL(resolve('ops/f3/ccfaa15.baseline-engine.mjs'));
  const [moduleBytes,provenanceBytes,newEngineBytes]=await Promise.all([
    readFile(baselineUrl),readFile(resolve('ops/f3/ccfaa15.baseline-provenance.json')),
    readFile(new URL('../../modules/collection/collection-filter.engine.js',import.meta.url)).catch(()=>
      readFile(new URL('../../modules/collection/collection-filter.engine.ts',import.meta.url)))]);
  const provenance=JSON.parse(provenanceBytes.toString('utf8')) as {moduleSha256:string};
  if (sha256(moduleBytes)!==provenance.moduleSha256) throw new Error('baseline_digest_mismatch');
  const baseline=await import(baselineUrl.href) as Baseline;
  const client=new Client({connectionString,application_name:'f3-type-simulation',
    options:'-c default_transaction_read_only=on',statement_timeout:120_000});
  try {
    await client.connect();
    const report={...await runF3TypeSimulation(client,baseline),engines:{baseline:provenance,newEngineSha256:sha256(newEngineBytes)}};
    if (args[1]) await writeFile(resolve(args[1]),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    // Bounded records avoid truncating Railway's per-line log limit.
    // Public metadata only. No body/excerpt/tenant identity/URL/connection details.
    const {samples,unknownTypesTop20,redundancies,pompeia,...summary}=report;
    console.log('F3_SIMULATION_SUMMARY='+JSON.stringify(summary));
    console.log('F3_SIMULATION_POMPEIA_STATUS='+JSON.stringify({publicationId:pompeia.publicationId,found:pompeia.found,origins:pompeia.origins.length}));
    for (const evidence of pompeia.origins) console.log('F3_SIMULATION_POMPEIA='+JSON.stringify(evidence));
    for (const bucket of ['kept','eligible','protected'] as const) {
      for (const sample of samples[bucket]) console.log('F3_SIMULATION_SAMPLE='+JSON.stringify({bucket,...sample}));
    }
    for (const item of unknownTypesTop20) console.log('F3_SIMULATION_UNKNOWN='+JSON.stringify(item));
    for (const {candidates,...pattern} of redundancies) {
      for (const candidate of candidates) console.log('F3_SIMULATION_REDUNDANCY='+JSON.stringify({...pattern,candidate}));
    }
    console.log('F3_SIMULATION_PASS; READ_ONLY; NO_WRITE; NO_DELETE');
  } finally {await client.end().catch(()=>undefined);}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  f3SimulationMain().catch((error:unknown)=>{
    const code=record(error).code;
    const message=error instanceof Error?error.message:'';
    const reason=typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)?code:
      /^(conflicting|duplicate) filter (rule|alias|term)/.test(message)?'POLICY_COLLISION':
      /^[a-z_]+$/.test(message)?message:'UNEXPECTED';
    console.error('F3_SIMULATION_FAILED; reason='+reason+'; NO_DELETE');process.exitCode=1;
  });
}
