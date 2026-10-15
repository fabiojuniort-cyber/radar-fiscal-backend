import type { ReleaseView, SqlRunner } from './curation.read.js';

/** Approved Segmento v5.1 hash; single source of truth for the F2 overlay. */
export const F2_SOURCE_SEGMENT_SHA256 =
  '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67';

export interface F2SourceSuggestion {
  atuacao: string;
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
    const rows=await run<F2SourceRow>(`
      SELECT cnae_code,atuacao,suggested_products,suggested_ncms,
             source_sha256,source_batch_id
      FROM taxonomy_f2_segment_suggestions_readonly
      WHERE cnae_code=ANY($1::text[])
      ORDER BY cnae_code
    `,[cnaes]);
    for(const row of rows){
      if(!cnaes.includes(row.cnae_code)||!/^\\d{7}$/.test(row.cnae_code))
        throw new Error('F2_SOURCE_UNEXPECTED_CNAE');
      if(byCnae.has(row.cnae_code))throw new Error('F2_SOURCE_DUPLICATE_CNAE');
      if(row.source_sha256!==F2_SOURCE_SEGMENT_SHA256){
        byCnae.clear();
        console.warn('F2_SOURCE_SUGGESTIONS_SKIPPED=F2_SOURCE_HASH_MISMATCH');
        break;
      }
      byCnae.set(row.cnae_code,{
        atuacao:row.atuacao,
        suggestedProducts:row.suggested_products??'',
        suggestedNcms:row.suggested_ncms??'',
        sourceSha256:row.source_sha256,
        sourceBatchId:row.source_batch_id,
      });
    }
  }catch(error){
    const reason=error instanceof Error&&/^F2_SOURCE_[A-Z_]+$/.test(error.message)
      ?error.message:'F2_SOURCE_OVERLAY_UNAVAILABLE';
    console.warn('F2_SOURCE_SUGGESTIONS_SKIPPED='+reason);
  }
  const eligibleIds=new Set(eligible.map(c=>c.releaseConceptId));
  return {
    ...view,
    concepts:view.concepts.map(concept=>{
      if(!eligibleIds.has(concept.releaseConceptId))return concept;
      const source=byCnae.get(concept.officialCodes[0]!);
      const override=concept.f2DraftSuggestions;
      if(!source&&override?.products==null&&override?.ncms==null)return concept;
      const data:F2SourceSuggestion={
        atuacao:source?.atuacao??'',
        suggestedProducts:override?.products!=null?override.products.join(', '):source?.suggestedProducts??'',
        suggestedNcms:override?.ncms!=null?override.ncms.join(', '):source?.suggestedNcms??'',
        sourceSha256:source?.sourceSha256??'',
        sourceBatchId:source?.sourceBatchId??'',
      };
      return {...concept,f2Source:data};
    }),
  };
}
