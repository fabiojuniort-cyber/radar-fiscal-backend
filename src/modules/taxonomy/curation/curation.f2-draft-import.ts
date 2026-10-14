import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  createConcept, createGroup, requireOpenDraft, updateConcept,
  type CuratorActor, type ConceptAliasInput, type ConceptInput,
} from './curation.draft.js';
import { initializeF2Actuacao, persistF2ActuacaoCnaeOrigins } from './curation.actuacao.js';
import { loadReleaseView, pgRunner } from './curation.read.js';
import { normalizeAliasText } from '../baseline/baseline.parser.js';
import { normalizeOfficialCode } from './curation.constants.js';

export const SEGMENTO_SHA = '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67';
export const PRODUTO_SHA = '261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a';
const DIGEST = (value: string) => createHash('sha256').update(value).digest('hex');
const bad = (code: string): never => { throw new Error(code); };
const CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const NCM = /^\d{2}(?:\d{2}){0,3}$/;
const CNAE = /^\d{7}$/;
const LENGTH = { sector: 1332, product: 4225 } as const;

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
  ncm_normalized: string[];
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
    if(!Array.isArray(row.ncm_normalized)||row.ncm_normalized.some(x=>typeof x!=='string'||!NCM.test(x)))
      bad('F2_DRAFT_PRODUCT_NCM_INVALID');
    const canonical=Array.from(new Set(row.ncm_normalized));
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

export async function readF2Stage(client:PoolClient):Promise<F2StageSnapshot> {
  const batches=await client.query<Batch>(
    'SELECT id,status,segmento_sha256,produto_sha256,content_sha256,segmento_rows,produto_rows,expected_warnings '+
    'FROM public.taxonomy_f2_import_batches WHERE segmento_sha256=$1 AND produto_sha256=$2',
    [SEGMENTO_SHA,PRODUTO_SHA]);
  if(batches.rows.length!==1)bad('F2_DRAFT_APPROVED_BATCH_MISSING');
  const batch=batches.rows[0]!;
  const [segments,products]=await Promise.all([
    client.query<SegmentRow>('SELECT source_line,cnae_code,atuacao,raw_cells,row_sha256 FROM public.taxonomy_f2_import_segment_rows WHERE batch_id=$1::uuid ORDER BY source_line',[batch.id]),
    client.query<ProductRow>('SELECT source_line,product_code,ncm_normalized,raw_cells,row_sha256 FROM public.taxonomy_f2_import_product_rows WHERE batch_id=$1::uuid ORDER BY source_line',[batch.id]),
  ]);
  return {batch,segments:segments.rows,products:products.rows};
}
export async function currentDraftPlan(client:PoolClient):Promise<{
  draftId:string;draftVersion:string;source:F2DraftPlan;alreadyImported:boolean;
  create:{sector:number;product:number};update:{sector:number;product:number};
}>{
  const draft=await requireOpenDraft(client);
  const plan=buildF2DraftPlan(await readF2Stage(client));
  const ledger=await client.query<{source_content_sha256:string}>(
    'SELECT source_content_sha256 FROM public.taxonomy_f2_draft_import_ledger WHERE release_id=$1::uuid AND batch_id=$2::uuid',
    [draft.id,plan.batchId]);
  if(ledger.rows.length && ledger.rows[0]!.source_content_sha256!==plan.contentSha256)
    bad('F2_DRAFT_LEDGER_CONFLICT');
  const view=await loadReleaseView(pgRunner(client),draft.id,{includeRetired:true});
  if(!view)bad('F2_DRAFT_RELEASE_UNAVAILABLE');
  for(const dimension of ['sector','product']){
    if(!view.dimensions.some(d=>d.code===dimension))bad('F2_DRAFT_DIMENSION_MISSING');
  }
  const codes=new Set(view.concepts.map(c=>c.code));
  const created={sector:plan.sector.filter(x=>!codes.has(x.code)).length,
    product:plan.product.filter(x=>!codes.has(x.code)).length};
  return {draftId:draft.id,draftVersion:draft.version,source:plan,
    alreadyImported:ledger.rows.length>0,create:created,
    update:{sector:plan.segmentoRows-created.sector,product:plan.produtoRows-created.product}};
}
async function upsertDimension(client:PoolClient,actor:CuratorActor,dimension:'sector'|'product',
  concepts:DraftImportConcept[],draftId:string):Promise<{created:number;updated:number;groupsCreated:number}> {
  const view=await loadReleaseView(pgRunner(client),draftId,{includeRetired:true});
  if(!view)bad('F2_DRAFT_RELEASE_UNAVAILABLE');
  const byCode=new Map(view.concepts.filter(c=>c.dimensionCode===dimension).map(c=>[c.code,c]));
  const byGroup=new Map(view.groups.filter(g=>g.dimensionCode===dimension)
    .map(g=>[normalizeAliasText(g.label),g.id]));
  const report={created:0,updated:0,groupsCreated:0};
  for(const item of concepts){
    let groupId=byGroup.get(normalizeAliasText(item.group));
    if(!groupId){
      groupId=await createGroup(client,actor,dimension,{label:item.group});
      byGroup.set(normalizeAliasText(item.group),groupId);
      report.groupsCreated++;
    }
    const current=byCode.get(item.code);
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
  }
  return report;
}
async function verifyDraftReadback(client:PoolClient,draftId:string,plan:F2DraftPlan):Promise<void>{
  const view=await loadReleaseView(pgRunner(client),draftId);
  if(!view)bad('F2_DRAFT_READBACK_RELEASE_MISSING');
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
  batchId:string;contentSha256:string;
}):Promise<Record<string,unknown>> {
  const preview=await currentDraftPlan(client);
  const {source,draftId}=preview;
  if(source.batchId!==confirmed.batchId||source.contentSha256!==confirmed.contentSha256)
    bad('F2_DRAFT_CONFIRMATION_MISMATCH');
  if(preview.alreadyImported){
    await verifyDraftReadback(client,draftId,source);
    return {draftId,draftVersion:preview.draftVersion,batchId:source.batchId,
      reusedExisting:true,imported:{sector:1332,product:4225},published:false,readback:'PASS'};
  }
  const segmentResult=await upsertDimension(client,actor,'sector',source.sector,draftId);
  const productResult=await upsertDimension(client,actor,'product',source.product,draftId);
  await initializeF2Actuacao(client,actor);
  const origins=await persistF2ActuacaoCnaeOrigins(client,actor,source.atuacaoOrigins,SEGMENTO_SHA);
  if(origins.originCount!==LENGTH.sector)bad('F2_DRAFT_ACTUACAO_COUNT_MISMATCH');
  await verifyDraftReadback(client,draftId,source);
  await client.query(
    'INSERT INTO public.taxonomy_f2_draft_import_ledger (release_id,batch_id,source_content_sha256,segmento_rows,produto_rows) VALUES ($1::uuid,$2::uuid,$3,$4,$5)',
    [draftId,source.batchId,source.contentSha256,LENGTH.sector,LENGTH.product]);
  return {draftId,draftVersion:preview.draftVersion,batchId:source.batchId,
    reusedExisting:false,imported:{sector:LENGTH.sector,product:LENGTH.product},
    changes:{sector:segmentResult,product:productResult,actuacaoOrigins:origins.originCount},
    readback:'PASS',published:false};
}
