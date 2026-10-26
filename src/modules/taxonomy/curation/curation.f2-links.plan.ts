import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const F2_LINK_RULE = 'onb03-t07-t08-v3';
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
export interface LinkExclusion {
  cnae: string; segment: string; kind: 'PRODUCT' | 'NCM' | 'CNAE'; reason: string; count: number;
  token: string; normalized: string | null; sourceLine: number; rowSha256: string;
  origin: 'STAGING' | 'CURATED'; candidates: string[];
}
export interface OperationalPlan {
  ruleVersion: string; sourceSha256: string; planSha256: string;
  links: ProposedLink[]; exclusions: LinkExclusion[];
  bySegment: {segment: string; products: number; ncms: number; excluded: number}[];
}

/** Preserve zeros; never pad, truncate or expand a suggestion to eight digits.
 * Any digit length is accepted only with exact CURRENT catalog or descendant evidence.
 */
export function operationalNcm(raw: string): string | null {
  if (!/^[0-9.\s]+$/.test(raw.trim())) return null;
  const digits = raw.replace(/[.\s]/g, '');
  return /^\d+$/.test(digits) ? digits : null;
}
export function buildOperationalPlan(input: {
  sourceSha256: string; sources: LinkSource[]; concepts: LinkConcept[];
  /** Codes from CURRENT NCM editions; ancestors are supported by catalog descendants. */
  catalogNcms: string[]; catalogIdentity: string;
}): OperationalPlan {
  const active = input.concepts.filter(c => c.membershipStatus === 'INCLUDED');
  const products = active.filter(c => c.dimensionCode === 'product');
  const productIndex = new Map<string, LinkConcept[]>();
  for (const product of products) {
    const key = textKey(product.label);
    productIndex.set(key, [...productIndex.get(key) ?? [], product]);
  }
  const catalog = new Set(input.catalogNcms.filter(code=>/^\d+$/.test(code)));
  // Include each ancestor as evidence of a strict descendant, retaining the
  // original digit prefix as the target (never pad or expand to a child).
  const supportedNcms = new Set<string>();
  for (const code of catalog) {
    for (let length=1;length<=code.length;length++) supportedNcms.add(code.slice(0,length));
  }
  const links = new Map<string, ProposedLink>();
  const exclusions: LinkExclusion[] = [];
  const segments = new Map<string, {segment:string; products:number; ncms:number; excluded:number}>();
  const sourceCounts = new Map<string,number>();
  for (const source of input.sources) sourceCounts.set(source.cnae, (sourceCounts.get(source.cnae) ?? 0) + 1);
  for (const source of [...input.sources].sort((a,b)=>a.line-b.line)) {
    const segment = source.segment.trim() || 'Sem segmento';
    if (!segments.has(segment)) segments.set(segment,{segment,products:0,ncms:0,excluded:0});
    const count = segments.get(segment)!;
    const exclude = (kind:LinkExclusion['kind'],reason:string,token:string,
      origin:'STAGING'|'CURATED'='STAGING',candidates:string[]=[]) => {
      exclusions.push({cnae:source.cnae,segment,kind,reason,count:1,token,
        normalized:kind==='NCM'?operationalNcm(token):null,sourceLine:source.line,
        rowSha256:source.rowSha256,origin,candidates:[...candidates].sort()});
      count.excluded++;
    };
    const sectors = active.filter(c=>c.dimensionCode==='sector' && c.officialCodes.length===1 && c.officialCodes[0]===source.cnae);
    if (!/^\d{7}$/.test(source.cnae) || sectors.length!==1 || sourceCounts.get(source.cnae)!==1) {
      exclude('CNAE','CNAE_NOT_UNIQUE_IN_SOURCE_AND_DRAFT',source.cnae,'STAGING',sectors.map(c=>c.code)); continue;
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
          if(matches.length!==1) { exclude(kind,matches.length?'PRODUCT_AMBIGUOUS':'PRODUCT_NOT_FOUND',token,curated==null?'STAGING':'CURATED',matches.map(c=>c.code)); continue; }
          target=matches[0]!.code;
        } else {
          const code=operationalNcm(token);
          if(!code) { exclude(kind,'NCM_UNSUPPORTED_SHAPE',token,curated==null?'STAGING':'CURATED'); continue; }
          if(!supportedNcms.has(code)) { exclude(kind,'NCM_NOT_IN_CURRENT_CATALOG',token,curated==null?'STAGING':'CURATED'); continue; }
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
  if(!isDeepStrictEqual(checked.links,value.links)) throw new Error('F2_LINK_APPROVAL_STALE');
  return checked;
}
