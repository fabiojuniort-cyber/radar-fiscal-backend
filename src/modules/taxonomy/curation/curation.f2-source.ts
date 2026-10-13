import type { ReleaseView, SqlRunner } from './curation.read.js';

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

  const rows = await run<F2SourceRow>(
    `SELECT cnae_code, atuacao, suggested_products, suggested_ncms,
            source_sha256, source_batch_id
       FROM taxonomy_f2_segment_suggestions_readonly
      WHERE cnae_code = ANY($1::text[])
      ORDER BY cnae_code`,
    [cnaes],
  );
  const byCnae = new Map<string, F2SourceSuggestion>();
  for (const row of rows) {
    if (!cnaes.includes(row.cnae_code) || !/^\d{7}$/.test(row.cnae_code)) {
      throw new Error('F2_SOURCE_UNEXPECTED_CNAE');
    }
    if (byCnae.has(row.cnae_code)) throw new Error('F2_SOURCE_DUPLICATE_CNAE');
    // The view guarantees the approved SHA. Refuse any unexpected payload
    // rather than letting unaudited values masquerade as official suggestions.
    if (row.source_sha256 !==
        '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd') {
      throw new Error('F2_SOURCE_HASH_MISMATCH');
    }
    byCnae.set(row.cnae_code, {
      atuacao: row.atuacao,
      suggestedProducts: row.suggested_products ?? '',
      suggestedNcms: row.suggested_ncms ?? '',
      sourceSha256: row.source_sha256,
      sourceBatchId: row.source_batch_id,
    });
  }
  if (byCnae.size === 0) return view;

  return {
    ...view,
    concepts: view.concepts.map((concept) => {
      if (!eligible.includes(concept)) return concept;
      const f2Source = byCnae.get(concept.officialCodes[0]!);
      return f2Source ? { ...concept, f2Source } : concept;
    }),
  };
}
