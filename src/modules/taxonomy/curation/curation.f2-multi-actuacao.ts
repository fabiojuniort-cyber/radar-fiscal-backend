import type {PoolClient} from 'pg';
import {CurationError,requireOpenDraft,type CuratorActor} from './curation.draft.js';

export const MULTI_ACTUACAO_DRAFT_VERSION='v1.8.0';

/** One CNAE has one or more DISTINCT, approved Atuação concepts.
 * This is curated release data, separate from immutable XLSX provenance. */
export async function updateCnaeActuacoes(
 client:PoolClient,actor:CuratorActor,conceptCode:string,atuacaoCodes:readonly string[],
):Promise<{cnaeCode:string;atuacaoCodes:string[];reusedExisting:boolean;published:false}> {
 if(actor.justification.trim().length<3)throw new CurationError('JUSTIFICATION_REQUIRED',400);
 const draft=await requireOpenDraft(client);
 if(draft.version!==MULTI_ACTUACAO_DRAFT_VERSION)
   throw new CurationError('F2_TAB03_V18_DRAFT_REQUIRED',409);
 if(atuacaoCodes.length<1)throw new CurationError('F2_TAB03_LAST_ACTUACAO_REQUIRED',422);
 if(atuacaoCodes.length>12||new Set(atuacaoCodes).size!==atuacaoCodes.length||
    atuacaoCodes.some(x=>!/^actuacao\.[a-z0-9_]+$/.test(x)))
   throw new CurationError('F2_TAB03_INVALID_ACTUACAO',422);

 const cnae=await client.query<{id:string;official_codes:string[]}>(`
   SELECT rc.id,rc.official_codes
   FROM taxonomy_release_concepts rc
   JOIN taxonomy_concepts c ON c.id=rc.concept_id
   JOIN taxonomy_dimensions d ON d.id=c.dimension_id
   WHERE rc.release_id=$1::uuid AND rc.membership_status='INCLUDED'
     AND c.code=$2 AND d.code='sector'`,[draft.id,conceptCode]);
 const row=cnae.rows[0];
 if(!row||row.official_codes.length!==1||!/^\d{7}$/.test(row.official_codes[0]??''))
   throw new CurationError('F2_TAB03_CNAE_NOT_FOUND',404);
 const cnaeCode=row.official_codes[0]!;
 const validated=await client.query<{code:string;id:string}>(`
   SELECT c.code,rc.id
   FROM taxonomy_release_concepts rc
   JOIN taxonomy_concepts c ON c.id=rc.concept_id
   JOIN taxonomy_dimensions d ON d.id=c.dimension_id
   JOIN taxonomy_release_dimensions rd ON rd.release_id=rc.release_id AND rd.dimension_id=c.dimension_id
   WHERE rc.release_id=$1::uuid AND d.code='actuacao'
     AND rd.membership_status='INCLUDED' AND rc.membership_status='INCLUDED'
     AND c.code=ANY($2::text[])`,[draft.id,atuacaoCodes]);
 if(validated.rows.length!==atuacaoCodes.length)
   throw new CurationError('F2_TAB03_ACTUACAO_NOT_IN_DRAFT',422);

 const old=await client.query<{code:string}>(`
   SELECT c.code FROM taxonomy_release_cnae_actuacao x
   JOIN taxonomy_release_concepts rc ON rc.id=x.release_concept_id
   JOIN taxonomy_concepts c ON c.id=rc.concept_id
   WHERE x.release_id=$1::uuid AND x.cnae_code=$2 ORDER BY c.code`,[draft.id,cnaeCode]);
 // If the migration/copy has not seeded this CNAE, prohibit the edit rather
 // than silently inventing replacement values or dropping F2 history.
 if(old.rows.length<1)throw new CurationError('F2_TAB03_ORIGIN_NOT_MATERIALIZED',409);
 const before=old.rows.map(x=>x.code).sort();
 const after=[...atuacaoCodes].sort();
 const reusedExisting=JSON.stringify(before)===JSON.stringify(after);
 if(!reusedExisting){
   // Insert BEFORE removals: never transiently leave CNAE with zero memberships.
   await client.query(`
     INSERT INTO taxonomy_release_cnae_actuacao(release_id,cnae_code,release_concept_id)
     SELECT $1::uuid,$2,unnest($3::uuid[])
     ON CONFLICT DO NOTHING`,[draft.id,cnaeCode,validated.rows.map(x=>x.id)]);
   await client.query(`
     DELETE FROM taxonomy_release_cnae_actuacao x
     WHERE x.release_id=$1::uuid AND x.cnae_code=$2
       AND NOT (x.release_concept_id=ANY($3::uuid[]))`,
       [draft.id,cnaeCode,validated.rows.map(x=>x.id)]);
 }
 const checked=await client.query<{code:string}>(`
   SELECT c.code FROM taxonomy_release_cnae_actuacao x
   JOIN taxonomy_release_concepts rc ON rc.id=x.release_concept_id
   JOIN taxonomy_concepts c ON c.id=rc.concept_id
   WHERE x.release_id=$1::uuid AND x.cnae_code=$2 ORDER BY c.code`,[draft.id,cnaeCode]);
 if(JSON.stringify(checked.rows.map(x=>x.code))!==JSON.stringify(after))
   throw new CurationError('F2_TAB03_READBACK_MISMATCH',409);
 if(!reusedExisting){
   await client.query(`INSERT INTO audit_log
      (tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id)
      VALUES(NULL,'ADMIN',$1,'F2_TAB03_CNAE_ACTUACOES_CHANGED','taxonomy_curation',$2::uuid,$3::jsonb,gen_random_uuid())`,
    [actor.userId,draft.id,JSON.stringify({conceptCode,cnaeCode,before,after,
      justification:actor.justification,published:false})]);
 }
 return {cnaeCode,atuacaoCodes:after,reusedExisting,published:false};
}
