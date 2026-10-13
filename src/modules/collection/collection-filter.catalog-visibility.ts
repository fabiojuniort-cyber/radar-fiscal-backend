import { sql, type RawBuilder } from 'kysely';

/** F3 uses physical exclusion. The old generated type flag cannot override
 * a kept/protected DOU or DOE-SP publication. Other sources keep legacy behavior.
 * This is a static source boundary; it never loads or evaluates policy rules. */
export function collectionFilterCatalogVisibility(
  alias: 'p'|'t'|'f'|'sf', feed = false,
): RawBuilder<boolean> {
  const id=sql.ref(`${alias}.${feed?'publication_id':'id'}`);
  const hidden=sql.ref(`${alias}.is_hidden`);
  return sql<boolean>`(NOT ${hidden} OR EXISTS (
    SELECT 1 FROM publication_origins f3_origin
    JOIN sources f3_source ON f3_source.id=f3_origin.source_id
    WHERE f3_origin.publication_id=${id} AND lower(f3_source.code) IN ('dou','doe-sp')
  ))`;
}
