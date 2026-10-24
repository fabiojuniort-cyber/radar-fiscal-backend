import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {Pool}=await import('pg');
const {resolveCuratorDatabaseUrl}=await import(pathToFileURL(resolve('dist/infrastructure/database/curator-url.js')).href);
const {CurationError,requireOpenDraft,assertCuratorSession}=await import(pathToFileURL(resolve('dist/modules/taxonomy/curation/curation.draft.js')).href);
const {buildF2DraftPlan,readF2Stage}=await import(pathToFileURL(resolve('dist/modules/taxonomy/curation/curation.f2-draft-import.js')).href);
const {loadReleaseView,pgRunner,findOpenDraft,findLatestPublishedRelease}=await import(pathToFileURL(resolve('dist/modules/taxonomy/curation/curation.read.js')).href);


export const F2_LINK_RULE = 'onb03-t07-t08-v1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
export interface LinkConcept {
  code: string; dimensionCode: string; label: string; membershipStatus: string;
  officialCodes: string[]; f2DraftSuggestions?: {products: string[] | null; ncms: string[] | null};
}
export interface LinkSource {
  cnae: string; segment: string; line: number; rowSha256: string;
  products: string; ncms: string;
}
export interface ProposedLink {
  id: string; cnae: string; sectorCode: string; segment: string;
  kind: 'PRODUCT' | 'NCM'; target: string;
  evidence: { sourceLine: number; rowSha256: string; origin: 'STAGING' | 'CURATED'; token: string };
}
export interface LinkExclusion { cnae: string; segment: string; kind: 'PRODUCT' | 'NCM' | 'CNAE'; reason: string; count: number }
export interface OperationalPlan {
  ruleVersion: string; sourceSha256: string; planSha256: string;
  links: ProposedLink[]; exclusions: LinkExclusion[];
  bySegment: {segment: string; products: number; ncms: number; excluded: number}[];
}

/** Preserve zeros; never pad, truncate or expand a suggestion to eight digits.
 * Any length is inspected; unsupported shapes remain evidence, not a link.
 */
export function operationalNcm(raw: string): string | null {
  if (!/^[0-9.\s]+$/.test(raw.trim())) return null;
  const digits = raw.replace(/[.\s]/g, '');
  return [2,4,5,6,7,8].includes(digits.length) && /^\d+$/.test(digits) ? digits : null;
}
export function buildOperationalPlan(input: {
  sourceSha256: string; sources: LinkSource[]; concepts: LinkConcept[];
  /** Exact prefixes present in a CURRENT NCM edition, including non-leaves. */
  catalogNcms: string[]; catalogIdentity: string;
}): OperationalPlan {
  const active = input.concepts.filter(c => c.membershipStatus === 'INCLUDED');
  const products = active.filter(c => c.dimensionCode === 'product');
  const productIndex = new Map<string, LinkConcept[]>();
  for (const product of products) {
    const key = textKey(product.label);
    productIndex.set(key, [...productIndex.get(key) ?? [], product]);
  }
  const catalog = new Set(input.catalogNcms);
  const links = new Map<string, ProposedLink>();
  const exclusions: LinkExclusion[] = [];
  const segments = new Map<string, {segment:string; products:number; ncms:number; excluded:number}>();
  const sourceCounts = new Map<string,number>();
  for (const source of input.sources) sourceCounts.set(source.cnae, (sourceCounts.get(source.cnae) ?? 0) + 1);
  for (const source of [...input.sources].sort((a,b)=>a.line-b.line)) {
    const segment = source.segment.trim() || 'Sem segmento';
    if (!segments.has(segment)) segments.set(segment,{segment,products:0,ncms:0,excluded:0});
    const count = segments.get(segment)!;
    const exclude = (kind:LinkExclusion['kind'],reason:string) => {
      exclusions.push({cnae:source.cnae,segment,kind,reason,count:1}); count.excluded++;
    };
    const sectors = active.filter(c=>c.dimensionCode==='sector' && c.officialCodes.length===1 && c.officialCodes[0]===source.cnae);
    if (!/^\d{7}$/.test(source.cnae) || sectors.length!==1 || sourceCounts.get(source.cnae)!==1) {
      exclude('CNAE','CNAE_NOT_UNIQUE_IN_SOURCE_AND_DRAFT'); continue;
    }
    const sector = sectors[0]!;
    for (const kind of ['PRODUCT','NCM'] as const) {
      const curated = kind==='PRODUCT' ? sector.f2DraftSuggestions?.products : sector.f2DraftSuggestions?.ncms;
      // Source lists use semicolon. Commas inside product labels are not separators.
      const values = curated ?? (kind==='PRODUCT' ? source.products : source.ncms).split(';');
      for (const raw of values) {
        const token=raw.trim();
        if (!token || token==='-' || token==='—') continue;
        let target:string;
        if (kind==='PRODUCT') {
          const matches=productIndex.get(textKey(token)) ?? [];
          if(matches.length!==1) { exclude(kind,matches.length?'PRODUCT_AMBIGUOUS':'PRODUCT_NOT_FOUND'); continue; }
          target=matches[0]!.code;
        } else {
          const code=operationalNcm(token);
          if(!code) { exclude(kind,'NCM_UNSUPPORTED_SHAPE'); continue; }
          if(!catalog.has(code)) { exclude(kind,'NCM_NOT_IN_CURRENT_CATALOG'); continue; }
          target=code;
        }
        const identity={cnae:source.cnae,sectorCode:sector.code,kind,target};
        const id=hash(identity);
        if(links.has(id)) continue;
        links.set(id,{...identity,id,segment,evidence:{sourceLine:source.line,rowSha256:source.rowSha256,
          origin:curated==null?'STAGING':'CURATED',token}});
        if(kind==='PRODUCT') count.products++; else count.ncms++;
      }
    }
  }
  const ordered=[...links.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const bySegment=[...segments.values()].sort((a,b)=>a.segment.localeCompare(b.segment));
  // Bind all source/effective draft inputs and CURRENT catalog, not only accepted links.
  const planSha256=hash({ruleVersion:F2_LINK_RULE,sourceSha256:input.sourceSha256,
    sources:input.sources,concepts:[...active].sort((a,b)=>a.code.localeCompare(b.code)),
    catalogIdentity:input.catalogIdentity,catalogNcms:[...catalog].sort(),links:ordered,exclusions});
  return {ruleVersion:F2_LINK_RULE,sourceSha256:input.sourceSha256,planSha256,links:ordered,exclusions,bySegment};
}
export interface LinkApproval {
  ruleVersion: string; planSha256: string; candidateIds: string[];
  approvedBy: string; justification: string; links: ProposedLink[];
}
export function approveOperationalPlan(plan:OperationalPlan, input:{
  planSha256:string; candidateIds:string[]; approvedBy:string; justification:string;
}):LinkApproval {
  if(input.planSha256!==plan.planSha256) throw new Error('F2_LINK_PLAN_STALE');
  if(!input.approvedBy.trim() || input.justification.trim().length<3) throw new Error('F2_LINK_APPROVAL_REQUIRED');
  const ids=[...new Set(input.candidateIds)].sort();
  const selected=plan.links.filter(link=>ids.includes(link.id));
  if(selected.length!==ids.length) throw new Error('F2_LINK_CANDIDATE_UNKNOWN');
  return {ruleVersion:F2_LINK_RULE,planSha256:plan.planSha256,candidateIds:ids,
    approvedBy:input.approvedBy,justification:input.justification.trim(),links:selected};
}
export function checkedOperationalApproval(plan:OperationalPlan, raw:unknown):LinkApproval {
  if(!raw || typeof raw!=='object') throw new Error('F2_LINK_APPROVAL_INVALID');
  const value=raw as LinkApproval;
  if(value.ruleVersion!==F2_LINK_RULE || !Array.isArray(value.candidateIds) ||
     !value.candidateIds.every(id=>typeof id==='string') || typeof value.approvedBy!=='string' ||
     typeof value.justification!=='string') throw new Error('F2_LINK_APPROVAL_INVALID');
  const checked=approveOperationalPlan(plan,value);
  if(JSON.stringify(checked.links)!==JSON.stringify(value.links)) throw new Error('F2_LINK_APPROVAL_STALE');
  return checked;
}
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
if(process.argv.slice(2).length!==1 || process.argv[2]!=='--plan') {
  console.error('Usage: taxonomy:f2-links -- --plan (read only; no apply/publication mode)'); process.exit(1);
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
    bySegment:plan.bySegment,published:false,profilesModified:false,
  }));
} catch(error) {
  console.error('F2_LINK_PLAN_FAILED'); process.exitCode=1;
} finally {
  await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end();
}
