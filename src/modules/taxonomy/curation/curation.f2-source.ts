import type { ReleaseView, SqlRunner } from './curation.read.js';

/** Approved Segmento v5.1 hash; single source of truth for the F2 overlay. */
export const F2_SOURCE_SEGMENT_SHA256 =
  '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67';

export interface F2SourceSuggestion {
  atuacao: string;
  /** Editable release memberships (1..12), independent of XLSX provenance. */
  actuacaoCodes: string[];
  suggestedProducts: string;
  suggestedNcms: string;
  /** Immutable XLSX provenance. Not a legal or published classification. */
  sourceSha256: string;
  sourceBatchId: string;
}

interface F2SourceRow {
  cnae_code: string;
  atuacao: string;
  suggested_products: string | null;
  suggested_ncms: string | null;
  source_sha256: string;
  source_batch_id: string;
}

/**
 * Admin-only, read-only overlay from the exact-hash F2 staging projection.
 *
 * Never writes curation, releases, tenants, tags or NCM match evidence.
 * A staged XLSX suggestion is not part of any published taxonomy release.
 * No fuzzy matching: only a concept's one exact 7-digit official CNAE.
 */
export async function attachF2SourceSuggestions(
  run: SqlRunner,
  view: ReleaseView,
): Promise<ReleaseView> {
  const eligible = view.concepts.filter(
    (concept) =>
      concept.dimensionCode === 'sector' &&
      concept.membershipStatus === 'INCLUDED' &&
      concept.officialCodes.length === 1 &&
      /^\d{7}$/.test(concept.officialCodes[0] ?? ''),
  );
  const cnaes = [...new Set(eligible.map((concept) => concept.officialCodes[0]!))];
  if (cnaes.length === 0) return view;

  // Staging is an immutable read-only fallback. Curated release values
  // override it, including [] (an explicit removal), and survive publication.
  const byCnae=new Map<string,F2SourceSuggestion>();
  try {
    const rows=await run<F2SourceRow>(`SELECT cnae_code,atuacao,suggested_products,suggested_ncms,
             source_sha256,source_batch_id
      FROM taxonomy_f2_segment_suggestions_readonly
      WHERE cnae_code=ANY($1::text[])
      ORDER BY cnae_code
    `,[cnaes]);
    for(const row of rows){
      if(!cnaes.includes(row.cnae_code)||!/^\d{7}$/.test(row.cnae_code))
        throw new Error('F2_SOURCE_UNEXPECTED_CNAE');
      if(byCnae.has(row.cnae_code))throw new Error('F2_SOURCE_DUPLICATE_CNAE');
      if(row.source_sha256!==F2_SOURCE_SEGMENT_SHA256){
        byCnae.clear();
        console.warn('F2_SOURCE_SUGGESTIONS_SKIPPED=F2_SOURCE_HASH_MISMATCH');
        break;
      }
      byCnae.set(row.cnae_code,{
        atuacao:row.atuacao,
        actuacaoCodes:[],
        suggestedProducts:row.suggested_products??'',
        suggestedNcms:row.suggested_ncms??'',
        sourceSha256:row.source_sha256,
        sourceBatchId:row.source_batch_id,
      });
    }
  }catch(error){
    byCnae.clear();
    const reason=error instanceof Error&&/^F2_SOURCE_[A-Z_]+$/.test(error.message)
      ?error.message:'F2_SOURCE_OVERLAY_UNAVAILABLE';
    console.warn('F2_SOURCE_SUGGESTIONS_SKIPPED='+reason);
  }
  // Curated release memberships override the immutable one-to-one XLSX origin.
  // No stored override means the original one-code association still applies.
  const parsed=/^v(\d+)\.(\d+)\./.exec(view.release.version);
  const major=Number(parsed?.[1]??0), minor=Number(parsed?.[2]??0);
  const supportsMulti=major>1||(major===1&&minor>=8);
  const originRows=supportsMulti ? await run<{cnae_code:string;code:string}>(`
    SELECT o.cnae_code,c.code
    FROM taxonomy_release_actuacao_cnae_origins o
    JOIN taxonomy_release_concepts rc ON rc.id=o.release_concept_id
      AND rc.release_id=o.release_id
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    WHERE o.release_id=$1::uuid AND o.cnae_code=ANY($2::text[])
    ORDER BY o.cnae_code,c.code
  `,[view.release.id,cnaes]) : [];
  const overrides=supportsMulti ? await run<{cnae_code:string;code:string}>(`
    SELECT a.cnae_code,c.code
    FROM taxonomy_release_cnae_actuacoes a
    JOIN taxonomy_release_concepts rc ON rc.id=a.release_actuacao_concept_id
      AND rc.release_id=a.release_id
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    WHERE a.release_id=$1::uuid AND a.cnae_code=ANY($2::text[])
    ORDER BY a.cnae_code,c.code
  `,[view.release.id,cnaes]) : [];
  const atuacaoByCnae=new Map<string,string[]>();
  for(const row of originRows) atuacaoByCnae.set(row.cnae_code,[row.code]);
  const seenOverrides=new Set<string>();
  for(const row of overrides){
    if(!seenOverrides.has(row.cnae_code)){
      atuacaoByCnae.set(row.cnae_code,[]);
      seenOverrides.add(row.cnae_code);
    }
    atuacaoByCnae.get(row.cnae_code)!.push(row.code);
  }
  const eligibleSet=new Set(eligible);
  if(byCnae.size===0&&atuacaoByCnae.size===0&&!eligible.some(c=>c.f2DraftSuggestions?.products!=null||c.f2DraftSuggestions?.ncms!=null))return view;
  return {
    ...view,
    concepts:view.concepts.map(concept=>{
      if(!eligibleSet.has(concept))return concept;
      const source=byCnae.get(concept.officialCodes[0]!);
      const override=concept.f2DraftSuggestions;
      const actuacaoCodes=atuacaoByCnae.get(concept.officialCodes[0]!)??[];
      if(!source&&!actuacaoCodes.length&&override?.products==null&&override?.ncms==null)return concept;
      const data:F2SourceSuggestion={
        atuacao:source?.atuacao??'',
        actuacaoCodes,
        suggestedProducts:override?.products!=null?override.products.join(', '):source?.suggestedProducts??'',
        suggestedNcms:override?.ncms!=null?override.ncms.join(', '):source?.suggestedNcms??'',
        sourceSha256:source?.sourceSha256??'',
        sourceBatchId:source?.sourceBatchId??'',
      };
      return {...concept,f2Source:data};
    }),
  };
}
