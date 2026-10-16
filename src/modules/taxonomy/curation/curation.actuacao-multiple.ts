import type { PoolClient } from 'pg';
import { CurationError, requireOpenDraft, type CuratorActor } from './curation.draft.js';

/** Explicit release membership override, never rewrite the immutable XLSX source. */
export async function updateDraftCnaeActuacoes(
  client: PoolClient,
  actor: CuratorActor,
  cnaeCode: string,
  actuacaoCodes: readonly string[],
): Promise<{draftId:string;cnaeCode:string;actuacaoCodes:string[];published:false}> {
  if (!actor.justification.trim()) throw new CurationError('JUSTIFICATION_REQUIRED');
  const draft = await requireOpenDraft(client);
  if (draft.version !== 'v1.8.0') throw new CurationError('F2_TAB03_DRAFT_VERSION_MISMATCH',409);
  if (!/^\d{7}$/.test(cnaeCode)) throw new CurationError('F2_TAB03_CNAE_INVALID');
  const codes=[...new Set(actuacaoCodes)];
  if (codes.length === 0) throw new CurationError('F2_TAB03_LAST_ACTUACAO_REQUIRED',400);
  if (codes.length !== actuacaoCodes.length || codes.length>12 ||
      codes.some(code=>!/^actuacao\.[a-z0-9_]+$/.test(code)))
    throw new CurationError('F2_TAB03_ACTUACOES_INVALID');

  const linkedCnae=await client.query<{count:number}>(`
    SELECT count(*)::int AS count
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    JOIN taxonomy_dimensions d ON d.id=c.dimension_id
    WHERE rc.release_id=$1::uuid AND d.code='sector'
      AND rc.membership_status='INCLUDED'
      AND $2=ANY(rc.official_codes)
  `,[draft.id,cnaeCode]);
  if(linkedCnae.rows[0]?.count!==1)
    throw new CurationError('F2_TAB03_CNAE_NOT_IN_DRAFT',404);

  const references=await client.query<{id:string;code:string}>(`
    SELECT rc.id,c.code
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    JOIN taxonomy_dimensions d ON d.id=c.dimension_id
    JOIN taxonomy_release_dimensions rd ON rd.release_id=rc.release_id
      AND rd.dimension_id=d.id
    WHERE rc.release_id=$1::uuid
      AND d.code='actuacao'
      AND rd.membership_status='INCLUDED'
      AND rc.membership_status='INCLUDED'
      AND c.code=ANY($2::text[])
    ORDER BY c.code
  `,[draft.id,codes]);
  if(references.rows.length!==codes.length)
    throw new CurationError('F2_TAB03_ACTUACAO_NOT_REGISTERED',400);

  // Idempotent per-CNAE replacement under the shared curator lock and transaction.
  // No origin/source, published release, tenant or historical tag is touched.
  await client.query(`
    DELETE FROM taxonomy_release_cnae_actuacoes
    WHERE release_id=$1::uuid AND cnae_code=$2
  `,[draft.id,cnaeCode]);
  for(const row of references.rows){
    await client.query(`
      INSERT INTO taxonomy_release_cnae_actuacoes
       (release_id,cnae_code,release_actuacao_concept_id)
      VALUES($1::uuid,$2,$3::uuid)
    `,[draft.id,cnaeCode,row.id]);
  }
  const readback=await client.query<{code:string}>(`
    SELECT c.code
    FROM taxonomy_release_cnae_actuacoes a
    JOIN taxonomy_release_concepts rc ON rc.id=a.release_actuacao_concept_id
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    WHERE a.release_id=$1::uuid AND a.cnae_code=$2
    ORDER BY c.code
  `,[draft.id,cnaeCode]);
  const actual=readback.rows.map(row=>row.code);
  if(JSON.stringify(actual)!==JSON.stringify([...codes].sort()))
    throw new CurationError('F2_TAB03_READBACK_MISMATCH',409);

  await client.query(`
    INSERT INTO audit_log
      (tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id)
    VALUES(NULL,'ADMIN',$1,'F2_TAB03_CNAE_ACTUACOES_UPDATED',
      'taxonomy_curation',$2::uuid,$3::jsonb,gen_random_uuid())
  `,[actor.userId,draft.id,JSON.stringify({
    cnaeCode,actuacaoCodes:actual,justification:actor.justification,
  })]);
  return {draftId:draft.id,cnaeCode,actuacaoCodes:actual,published:false};
}
