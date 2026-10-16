import type {PoolClient} from 'pg';
import {CURATED_RELEASE_KIND} from '../../modules/taxonomy/curation/curation.read.js';

export interface OpenF2CuratedDraft {
  id:string;
  version:string;
  status:string;
}
/**
 * Never silently pick LIMIT 1 when more than one curated draft is open.
 * Mirrors findOpenDraft statuses + manifest discriminator.
 * Must run inside the caller's explicit read-only or curator transaction.
 */
export async function requireExactlyOneOpenF2Draft(
  client:Pick<PoolClient,'query'>,
):Promise<OpenF2CuratedDraft> {
  const result=await client.query<OpenF2CuratedDraft>(
    `SELECT id::text,version,status FROM taxonomy_releases
     WHERE status IN ('DRAFT','IN_REVIEW','APPROVED')
       AND manifest->>'kind'=$1
     ORDER BY version_major DESC,version_minor DESC,version_patch DESC`,
    [CURATED_RELEASE_KIND],
  );
  if(result.rows.length!==1)throw Error(
    result.rows.length===0?'F2_OPEN_DRAFT_NOT_FOUND':'F2_OPEN_DRAFT_AMBIGUOUS',
  );
  const only=result.rows[0]!;
  if(only.status!=='DRAFT')throw Error('F2_OPEN_DRAFT_NOT_EDITABLE');
  return only;
}
