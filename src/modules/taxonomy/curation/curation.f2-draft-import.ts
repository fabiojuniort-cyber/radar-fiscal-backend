import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  createConcept, createGroup, requireOpenDraft, updateConcept,
  type CuratorActor, type ConceptAliasInput, type ConceptInput,
} from './curation.draft.js';
import { initializeF2Actuacao, persistF2ActuacaoCnaeOrigins } from './curation.actuacao.js';
import { loadReleaseView, pgRunner, type ReleaseView } from './curation.read.js';
import { normalizeAliasText } from '../baseline/baseline.parser.js';
import { normalizeOfficialCode } from './curation.constants.js';

export const SEGMENTO_SHA = '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67';
export const PRODUTO_SHA = '261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a';
export const F2_APPROVED_BATCH_ID = 'f4ab4f0c-9755-4957-9b51-826aeddb4bca';
const DIGEST = (value: string) => createHash('sha256').update(value).digest('hex');
const bad = (code: string): never => { throw new Error(code); };
const CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const NCM = /^\d{2,8}$/;
const CNAE = /^\d{7}$/;
const LENGTH = { sector: 1332, product: 4225 } as const;

/** Keep precisely in sync with slugify() used by createGroup in curation.draft.ts.
 * Group uniqueness is (release, dimension, code), NOT normalized label.
 */
export function f2GroupSlugify(label: string): string {
  return normalizeAliasText(label)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** Reuse an existing (even historically retired) group by its database code. */
export async function getOrCreateF2Group(
  idsByCode: Map<string,string>,
  label: string,
  create: () => Promise<string>,
): Promise<{id:string;created:boolean}> {
  const code=f2GroupSlugify(label);
  const id=idsByCode.get(code);
  if(id) return {id,created:false};
  const createdId=await create();
  idsByCode.set(code,createdId);
  return {id:createdId,created:true};
}



export type F2DraftStage = 'preflight' | 'sector' | 'product' | 'actuacao' | 'readback' | 'ledger';
export class F2DraftStageError extends Error {
  constructor(readonly stage: F2DraftStage, readonly sourceLine: number | undefined, cause: unknown) {
    super('F2_DRAFT_STAGE_FAILURE', { cause });
  }
}
async function inF2DraftStage<T>(
  stage: F2DraftStage, line: number | undefined, operation: () => Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof F2DraftStageError) throw error;
    throw new F2DraftStageError(stage, line, error);
  }
}

/** Strictly allowlisted metadata. Never print driver messages, SQL, details or values. */
export function safeF2DraftError(error: unknown): string {
  const outer = error instanceof F2DraftStageError ? error : null;
  const original = outer?.cause ?? error;
  const metadata = original && typeof original === 'object'
    ? original as Record<string, unknown> : {};
  const value = (key: string): string => typeof metadata[key] === 'string'
    ? metadata[key] as string : '';
  const rawMessage = original instanceof Error ? original.message : '';
  const safeNcm = /^F2_DRAFT_PRODUCT_NCM_INVALID line=\d+ reason=(?:LENGTH_\d+|NOT_ARRAY|NOT_STRING|NON_DIGIT)$/;
  const safeF2 = /^F2_[A-Z0-9_]+$/;
  const code = safeF2.test(rawMessage) || safeNcm.test(rawMessage)
    ? rawMessage : 'F2_DRAFT_IMPORT_BLOCK';
  const pieces = [code, 'stage=' + (outer?.stage ?? 'preflight')];
  if (outer?.sourceLine !== undefined && Number.isSafeInteger(outer.sourceLine) &&
      outer.sourceLine >= 1) pieces.push('line=' + outer.sourceLine);
  const pgCode = value('code');
  if (/^[A-Z0-9]{5}$/.test(pgCode)) pieces.push('sqlstate=' + pgCode);
  // Curator domain codes are safe to show as identifiers only (no messages).
  else if (/^[A-Z][A-Z0-9_]{2,63}$/.test(pgCode)) pieces.push('domain=' + pgCode);
  for (const [key, printed] of [
    ['constraint', 'constraint'], ['table', 'table'], ['column', 'column'],
  ] as const) {
    const identifier = value(key);
    if (/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) pieces.push(printed + '=' + identifier);
  }
  return pieces.join(' ');
}


interface Batch {
  id: string;
  status: string;
  segmento_sha256: string;
  produto_sha256: string;
  content_sha256: string;
  segmento_rows: number;
  produto_rows: number;
  expected_warnings: number;
}
interface SegmentRow {
  source_line: number;
  cnae_code: string;
  atuacao: string;
  raw_cells: string[];
  row_sha256: string;
}
interface ProductRow {
  source_line: number;
  product_code: string;
  /** pg JSONB is expected to decode as a string array; never coerce numbers (leading zeroes). */
  ncm_normalized: unknown;
  raw_cells: string[];
  row_sha256: string;
}
export interface F2StageSnapshot {
  batch: Batch;
  segments: SegmentRow[];
  products: ProductRow[];
}
export interface DraftImportConcept {
  line: number;
  code: string;
  dimension: 'sector' | 'product';
  label: string;
  definition: string;
  group: string;
  officialCodes: string[];
  aliases: ConceptAliasInput[];
  profileVisible: boolean;
  classifyByLabel: boolean;
  displayOrder: number | null;
}
export interface F2DraftPlan {
  batchId: string;
  contentSha256: string;
  segmentoRows: number;
  produtoRows: number;
  expectedWarnings: number;
  sector: DraftImportConcept[];
  product: DraftImportConcept[];
  atuacaoOrigins: { sourceLine: number; cnaeCode: string; atuacaoLabel: string }[];
}

/** Preserve approved 2–8 digit NCM prefixes (including 3/5/7 and zero-prefixes).
 * No normalization/coercion occurs: PostgreSQL jsonb must be an array of strings.
 * Errors contain only source line and structural reason, never product/customer data.
 */
export function validateF2DraftProductNcms(raw: unknown, sourceLine: number): string[] {
  const invalid = (reason: string): never =>
    bad(`F2_DRAFT_PRODUCT_NCM_INVALID line=${sourceLine} reason=${reason}`);
  if (!Array.isArray(raw)) invalid('NOT_ARRAY');
  const codes: string[] = [];
  for (const code of raw as unknown[]) {
    if (typeof code !== 'string') invalid('NOT_STRING');
    if (!/^\d+$/.test(code as string)) invalid('NON_DIGIT');
    if (!NCM.test(code as string)) invalid(`LENGTH_${(code as string).length}`);
    codes.push(code as string);
  }
  return [...new Set(codes)];
}

function normalizeCell(value: string): string {
  if(typeof value!=='string')bad('F2_DRAFT_CELL_INVALID');
  return value.trim();
}
function optFlag(value: string): boolean {
  const v=normalizeCell(value).toLocaleLowerCase('pt-BR');
  if(!v || v==='-' || v==='não' || v==='nao' || v==='0' || v==='false')return false;
  if(['x','✓','sim','s','1','true'].includes(v))return true;
  return bad('F2_DRAFT_BOOLEAN_INVALID');
}
function asOrder(value: string): number | null {
  const v=normalizeCell(value);
  if(!v)return null;
  if(!/^\d{1,5}$/.test(v))return bad('F2_DRAFT_ORDER_INVALID');
  return Number(v);
}
function aliases(value: string): ConceptAliasInput[] {
  const parts=value.split(';').map(x=>x.trim()).filter(x=>x && x!=='-' && x!=='—');
  const seen=new Set<string>();
  return parts.filter(x=>{const key=normalizeAliasText(x);if(!key||seen.has(key))return false;seen.add(key);return true;})
    .map(text=>({text,aliasType:'EXACT_LEXICAL' as const}));
}
function codeFor(dimension: 'sector'|'product',sourceCode: string,fallback: string): string {
  const code=normalizeCell(sourceCode)||dimension+'.'+fallback;
  if(!CODE.test(code)||!code.startsWith(dimension+'.'))return bad('F2_DRAFT_CONCEPT_CODE_INVALID');
  return code;
}
function checkRows(rows: {source_line:number;raw_cells:string[];row_sha256:string}[],length:number,width:number) {
  if(rows.length!==length)bad('F2_DRAFT_ROW_COUNT_MISMATCH');
  rows.forEach((row,i)=>{
    if(row.source_line!==i+2||!Array.isArray(row.raw_cells)||row.raw_cells.length!==width||
       row.raw_cells.some(x=>typeof x!=='string'))bad('F2_DRAFT_SOURCE_LINE_INVALID');
    if(DIGEST(JSON.stringify(row.raw_cells))!==row.row_sha256)bad('F2_DRAFT_ROW_HASH_MISMATCH');
  });
}
export function buildF2DraftPlan(snapshot: F2StageSnapshot): F2DraftPlan {
  const {batch,segments,products}=snapshot;
  if(batch?.status!=='STAGED'||batch.segmento_sha256!==SEGMENTO_SHA||
     batch.produto_sha256!==PRODUTO_SHA||
     batch.segmento_rows!==LENGTH.sector||batch.produto_rows!==LENGTH.product||
     batch.expected_warnings!==448)bad('F2_DRAFT_BATCH_CONTRACT_MISMATCH');
  checkRows(segments,LENGTH.sector,12);
  checkRows(products,LENGTH.product,10);
  if(DIGEST(JSON.stringify({segmento:segments.map(x=>x.raw_cells),
    produto:products.map(x=>x.raw_cells)}))!==batch.content_sha256)bad('F2_DRAFT_CONTENT_HASH_MISMATCH');

  const sector:DraftImportConcept[]=segments.map(row=>{
    const c=row.raw_cells;
    if(!CNAE.test(row.cnae_code)||normalizeOfficialCode(c[3]??'')!==row.cnae_code)
      bad('F2_DRAFT_CNAE_MISMATCH');
    const label=normalizeCell(c[4]??'');
    const sub=normalizeCell(c[1]??'');
    const parent=normalizeCell(c[0]??'');
    if(!label||!sub||!parent)bad('F2_DRAFT_SECTOR_LABEL_MISSING');
    return {line:row.source_line,code:codeFor('sector',c[11]??'','cnae_'+row.cnae_code),
      dimension:'sector',label,definition:label,group:parent+' – '+sub,
      officialCodes:[row.cnae_code],aliases:aliases(c[5]??''),
      profileVisible:optFlag(c[8]??''),classifyByLabel:optFlag(c[9]??''),
      displayOrder:asOrder(c[10]??'')};
  });
  const product:DraftImportConcept[]=products.map(row=>{
    const c=row.raw_cells;
    const group=normalizeCell(c[1]??'');
    const label=normalizeCell(c[2]??'');
    if(!group||!label)bad('F2_DRAFT_PRODUCT_LABEL_MISSING');
    const canonical = validateF2DraftProductNcms(row.ncm_normalized, row.source_line);
    return {line:row.source_line,
      code:codeFor('product',c[8]??'','f2_'+DIGEST(row.product_code).slice(0,20)),
      dimension:'product',label,definition:normalizeCell(c[9]??'')||label,
      group,officialCodes:canonical,aliases:aliases(c[4]??''),
      profileVisible:optFlag(c[5]??''),classifyByLabel:optFlag(c[6]??''),
      displayOrder:asOrder(c[7]??'')};
  });
  for(const list of [sector,product]){
    const codes=new Set<string>();
    for(const item of list){
      if(codes.has(item.code))bad('F2_DRAFT_DUPLICATE_CODE');
      codes.add(item.code);
    }
  }
  const cnaes=new Set(segments.map(row=>row.cnae_code));
  const productCodes=new Set(products.map(row=>row.product_code));
  if(cnaes.size!==LENGTH.sector||productCodes.size!==LENGTH.product)
    bad('F2_DRAFT_DUPLICATE_SOURCE_IDENTITY');
  return {batchId:batch.id,contentSha256:batch.content_sha256,segmentoRows:sector.length,
    produtoRows:product.length,expectedWarnings:448,sector,product,
    atuacaoOrigins:segments.map(row=>({sourceLine:row.source_line,cnaeCode:row.cnae_code,atuacaoLabel:row.atuacao}))};
}


export interface F2DimensionAudit {
  created: number;
  updated: number;
  equal: number;
  outsideLot: {
    count: number;
    examples: { code: string; officialCodes: string[]; membershipStatus: string }[];
  };
  duplicateOfficialCodes: {
    count: number;
    examples: { officialCode: string; conceptCodes: string[]; conceptCount: number }[];
  };
  /** Informative only: distinct incoming labels that reuse a pre-existing group code. */
  groupSlugMerges: {count:number;examples:{label:string;code:string}[]};
}
export interface F2DraftAudit {
  dimensions: { sector: F2DimensionAudit; product: F2DimensionAudit };
  /** A digest of ALL exceptions, including items not shown in examples. */
  exceptionsApprovalSha256: string | null;
  requiresCoordApproval: boolean;
  identicalCodes: { sector: string[]; product: string[] };
  groupSlugMerges: {count:number;examples:{dimension:'sector'|'product';label:string;code:string}[]};
}

/** Pure, read-only comparison with the exact release view used by apply. */
export function auditF2Draft(plan: F2DraftPlan, view: ReleaseView, draftId: string): F2DraftAudit {
  const identicalCodes = { sector: [] as string[], product: [] as string[] };
  const fullExceptions: Record<string, unknown> = {};
  const dimensions = {} as F2DraftAudit['dimensions'];
  for (const dimension of ['sector', 'product'] as const) {
    const incoming = plan[dimension];
    const existing = view.concepts.filter(c => c.dimensionCode === dimension);
    const incomingCodes = new Set(incoming.map(c => c.code));
    const existingByCode = new Map(existing.map(c => [c.code, c]));
    const dimensionGroups=view.groups.filter(g=>g.dimensionCode===dimension);
    const groupById = new Map(dimensionGroups.map(g => [g.id, g.label]));
    // Existing group codes include retired groups; simulate createGroup's code lookup
    // and count label variants merging onto the same slug (not a new approval gate).
    const seenGroupLabels = new Map<string,Set<string>>();
    for(const group of dimensionGroups){
      seenGroupLabels.set(group.code,new Set([normalizeAliasText(group.label)]));
    }
    const groupSlugMergeExamples:{label:string;code:string}[]=[];
    let groupSlugMergeCount=0;
    for(const item of incoming){
      const code=f2GroupSlugify(item.group);
      const label=normalizeAliasText(item.group);
      const labels=seenGroupLabels.get(code);
      if(!labels){seenGroupLabels.set(code,new Set([label]));continue;}
      if(labels.has(label))continue;
      labels.add(label);
      groupSlugMergeCount++;
      if(groupSlugMergeExamples.length<10)
        groupSlugMergeExamples.push({label:item.group,code});
    }
    const outside = existing.filter(c => !incomingCodes.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    const officialOwners = new Map<string, Set<string>>();
    const register = (code: string, officialCodes: readonly string[]) => {
      for (const officialCode of new Set(officialCodes)) {
        let owners = officialOwners.get(officialCode);
        if (!owners) { owners = new Set(); officialOwners.set(officialCode, owners); }
        owners.add(code);
      }
    };
    for (const item of incoming) register(item.code, item.officialCodes);
    // Retired concepts do not create active collisions, but are still counted outside.
    for (const item of outside.filter(c => c.membershipStatus === 'INCLUDED')) {
      register(item.code, item.officialCodes);
    }
    const duplicates = [...officialOwners.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([officialCode, owners]) => ({ officialCode, conceptCodes: [...owners].sort() }))
      .sort((a, b) => a.officialCode.localeCompare(b.officialCode));
    let created = 0, updated = 0, equal = 0;
    for (const item of incoming) {
      const current = existingByCode.get(item.code);
      if (!current) { created++; continue; }
      const group = current.groupId ? groupById.get(current.groupId) : undefined;
      const existingAliases = new Set(current.aliases.map(a => normalizeAliasText(a.text)));
      const changed =
        current.membershipStatus !== 'INCLUDED' ||
        current.label !== item.label ||
        current.definition !== item.definition ||
        normalizeAliasText(group ?? '') !== normalizeAliasText(item.group) ||
        current.profileVisible !== item.profileVisible ||
        current.classifyByLabel !== item.classifyByLabel ||
        current.displayOrder !== item.displayOrder ||
        JSON.stringify([...new Set(current.officialCodes)].sort()) !==
          JSON.stringify([...new Set(item.officialCodes)].sort()) ||
        item.aliases.some(a => !existingAliases.has(normalizeAliasText(a.text)));
      if (changed) updated++;
      else { equal++; identicalCodes[dimension].push(item.code); }
    }
    dimensions[dimension] = {
      created, updated, equal,
      outsideLot: { count: outside.length,
        examples: outside.slice(0, 10).map(c => ({
          code: c.code, officialCodes: c.officialCodes, membershipStatus: c.membershipStatus,
        })) },
      duplicateOfficialCodes: { count: duplicates.length, examples: duplicates.slice(0, 10)
        .map(d => ({ officialCode: d.officialCode, conceptCount: d.conceptCodes.length,
          conceptCodes: d.conceptCodes.slice(0, 10) })) },
      groupSlugMerges:{count:groupSlugMergeCount,examples:groupSlugMergeExamples},
    };
    // No truncation in the approval digest, even if preview examples are limited to 10.
    fullExceptions[dimension] = {
      outside: outside.map(c => ({ code: c.code, codes: [...c.officialCodes].sort(),
        membershipStatus: c.membershipStatus })),
      duplicates,
    };
  }
  const requiresCoordApproval = (['sector', 'product'] as const).some(d =>
    dimensions[d].outsideLot.count > 0 || dimensions[d].duplicateOfficialCodes.count > 0);
  return {
    dimensions, identicalCodes, requiresCoordApproval,
    groupSlugMerges:{
      count:dimensions.sector.groupSlugMerges.count+dimensions.product.groupSlugMerges.count,
      examples:([
        ...dimensions.sector.groupSlugMerges.examples.map(e=>({...e,dimension:'sector' as const})),
        ...dimensions.product.groupSlugMerges.examples.map(e=>({...e,dimension:'product' as const})),
      ]).slice(0,10),
    },
    exceptionsApprovalSha256: requiresCoordApproval
      ? DIGEST(JSON.stringify({ draftId, batchId: plan.batchId,
        contentSha256: plan.contentSha256, exceptions: fullExceptions }))
      : null,
  };
}

export async function readF2Stage(client:PoolClient):Promise<F2StageSnapshot> {
  const batches=await client.query<Batch>(
    'SELECT id,status,segmento_sha256,produto_sha256,content_sha256,segmento_rows,produto_rows,expected_warnings '+
    'FROM public.taxonomy_f2_import_batches WHERE segmento_sha256=$1 AND produto_sha256=$2 AND id=$3::uuid',
    [SEGMENTO_SHA,PRODUTO_SHA,F2_APPROVED_BATCH_ID]);
  if(batches.rows.length!==1)bad('F2_DRAFT_APPROVED_BATCH_MISSING');
  const batch=batches.rows[0]!;
  if (batch.status !== 'STAGED') bad('F2_DRAFT_BATCH_NOT_STAGED');
  const [segments,products]=await Promise.all([
    client.query<SegmentRow>('SELECT source_line,cnae_code,atuacao,raw_cells,row_sha256 FROM public.taxonomy_f2_import_segment_rows WHERE batch_id=$1::uuid ORDER BY source_line',[batch.id]),
    client.query<ProductRow>('SELECT source_line,product_code,ncm_normalized,raw_cells,row_sha256 FROM public.taxonomy_f2_import_product_rows WHERE batch_id=$1::uuid ORDER BY source_line',[batch.id]),
  ]);
  return {batch,segments:segments.rows,products:products.rows};
}
export async function currentDraftPlan(client:PoolClient):Promise<{
  draftId:string;draftVersion:string;source:F2DraftPlan;alreadyImported:boolean;
  audit:F2DraftAudit;
}>{
  const draft=await requireOpenDraft(client);
  const plan=buildF2DraftPlan(await readF2Stage(client));
  const ledger=await client.query<{source_content_sha256:string}>(
    'SELECT source_content_sha256 FROM public.taxonomy_f2_draft_import_ledger WHERE release_id=$1::uuid AND batch_id=$2::uuid',
    [draft.id,plan.batchId]);
  if(ledger.rows.length && ledger.rows[0]!.source_content_sha256!==plan.contentSha256)
    bad('F2_DRAFT_LEDGER_CONFLICT');
  const view=await loadReleaseView(pgRunner(client),draft.id,{includeRetired:true});
  if(!view)throw new Error('F2_DRAFT_RELEASE_UNAVAILABLE');
  for(const dimension of ['sector','product']){
    if(!view.dimensions.some(d=>d.code===dimension))bad('F2_DRAFT_DIMENSION_MISSING');
  }
  const audit = auditF2Draft(plan, view, draft.id);
  return {draftId:draft.id,draftVersion:draft.version,source:plan,
    alreadyImported:ledger.rows.length>0,audit};
}
async function upsertDimension(client:PoolClient,actor:CuratorActor,dimension:'sector'|'product',
  concepts:DraftImportConcept[],draftId:string,identicalCodes:ReadonlySet<string>):Promise<{created:number;updated:number;groupsCreated:number}> {
  const view=await loadReleaseView(pgRunner(client),draftId,{includeRetired:true});
  if(!view)throw new Error('F2_DRAFT_RELEASE_UNAVAILABLE');
  const byCode=new Map(view.concepts.filter(c=>c.dimensionCode===dimension).map(c=>[c.code,c]));
  const byGroup=new Map(view.groups.filter(g=>g.dimensionCode===dimension)
    .map(g=>[g.code,g.id]));
  const report={created:0,updated:0,groupsCreated:0};
  for(const item of concepts){
    await inF2DraftStage(dimension,item.line,async()=>{
    const group=await getOrCreateF2Group(byGroup,item.group,
      ()=>createGroup(client,actor,dimension,{label:item.group}));
    const groupId=group.id;
    if(group.created)report.groupsCreated++;
    const current=byCode.get(item.code);
    if (current && identicalCodes.has(item.code)) return;
    const allAliases=new Map<string,ConceptAliasInput>();
    for(const alias of [...(current?.aliases??[]),...item.aliases]){
      const key=normalizeAliasText(alias.text);
      if(key&&!allAliases.has(key))allAliases.set(key,{text:alias.text,aliasType:alias.aliasType as ConceptAliasInput['aliasType']});
    }
    const values:ConceptInput={
      label:item.label,definition:item.definition,groupId,officialCodes:item.officialCodes,
      aliases:[...allAliases.values()],profileVisible:item.profileVisible,
      classifyByLabel:item.classifyByLabel,displayOrder:item.displayOrder,
      membershipStatus:'INCLUDED'
    };
    if(current){
      await updateConcept(client,actor,item.code,values);
      report.updated++;
    }else{
      await createConcept(client,actor,dimension,{...values,code:item.code});
      report.created++;
    }
    });
  }
  return report;
}
async function verifyDraftReadback(client:PoolClient,draftId:string,plan:F2DraftPlan):Promise<void>{
  const view=await loadReleaseView(pgRunner(client),draftId);
  if(!view)throw new Error('F2_DRAFT_READBACK_RELEASE_MISSING');
  const map=new Map(view.concepts.map(c=>[c.code,c]));
  for(const row of [...plan.sector,...plan.product]){
    const got=map.get(row.code);
    if(!got||got.dimensionCode!==row.dimension||got.label!==row.label||
       got.membershipStatus!=='INCLUDED'||got.profileVisible!==row.profileVisible||
       got.classifyByLabel!==row.classifyByLabel||
       JSON.stringify([...got.officialCodes].sort())!==JSON.stringify([...row.officialCodes].sort()))
      bad('F2_DRAFT_READBACK_MISMATCH');
  }
}
export async function applyF2Draft(client:PoolClient,actor:CuratorActor,confirmed:{
  batchId:string;contentSha256:string;exceptionsApprovalSha256?:string | undefined;
}):Promise<Record<string,unknown>> {
  const preview=await inF2DraftStage('preflight',undefined,()=>currentDraftPlan(client));
  const {source,draftId}=preview;
  if(source.batchId!==confirmed.batchId||source.contentSha256!==confirmed.contentSha256)
    bad('F2_DRAFT_CONFIRMATION_MISMATCH');
  if (preview.audit.requiresCoordApproval &&
      preview.audit.exceptionsApprovalSha256 !== confirmed.exceptionsApprovalSha256)
    bad('F2_DRAFT_COORD_EXCEPTION_APPROVAL_REQUIRED');
  if(preview.alreadyImported){
    await inF2DraftStage('readback',undefined,()=>verifyDraftReadback(client,draftId,source));
    return {draftId,draftVersion:preview.draftVersion,batchId:source.batchId,
      reusedExisting:true,imported:{sector:1332,product:4225},published:false,readback:'PASS'};
  }
  const segmentResult=await inF2DraftStage('sector',undefined,()=>upsertDimension(client,actor,'sector',source.sector,draftId,
    new Set(preview.audit.identicalCodes.sector)));
  const productResult=await inF2DraftStage('product',undefined,()=>upsertDimension(client,actor,'product',source.product,draftId,
    new Set(preview.audit.identicalCodes.product)));
  await inF2DraftStage('actuacao',undefined,()=>initializeF2Actuacao(client,actor));
  const origins=await inF2DraftStage('actuacao',undefined,()=>persistF2ActuacaoCnaeOrigins(client,actor,source.atuacaoOrigins,SEGMENTO_SHA));
  if(origins.originCount!==LENGTH.sector)bad('F2_DRAFT_ACTUACAO_COUNT_MISMATCH');
  await inF2DraftStage('readback',undefined,()=>verifyDraftReadback(client,draftId,source));
  await inF2DraftStage('ledger',undefined,()=>client.query(
    'INSERT INTO public.taxonomy_f2_draft_import_ledger (release_id,batch_id,source_content_sha256,segmento_rows,produto_rows) VALUES ($1::uuid,$2::uuid,$3,$4,$5)',
    [draftId,source.batchId,source.contentSha256,LENGTH.sector,LENGTH.product]));
  return {draftId,draftVersion:preview.draftVersion,batchId:source.batchId,
    reusedExisting:false,imported:{sector:LENGTH.sector,product:LENGTH.product},
    changes:{sector:segmentResult,product:productResult,actuacaoOrigins:origins.originCount},
    readback:'PASS',published:false};
}
