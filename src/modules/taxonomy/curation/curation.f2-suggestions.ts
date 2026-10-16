import type {PoolClient} from 'pg';
import {CurationError,requireOpenDraft,type CuratorActor} from './curation.draft.js';

export type F2SuggestionEdit={suggestedProducts:string[];suggestedNcms:string[]};

export function validateF2Suggestions(input:F2SuggestionEdit):F2SuggestionEdit {
  const clean=(values:string[],type:'PRODUCT'|'NCM')=>{
    if(values.length>100)throw new CurationError('F2_SUGGESTIONS_LIMIT',400);
    const result:string[]=[];
    const seen=new Set<string>();
    for(const raw of values){
      const value=raw.trim();
      if(!value||value.length>150)throw new CurationError('F2_SUGGESTIONS_INVALID_'+type,400);
      if(type==='NCM'&&!/^\d{2,8}$/.test(value.replace(/[./\s-]/g,'')))
        throw new CurationError('F2_SUGGESTIONS_INVALID_NCM',400);
      const normalized=type==='NCM'?value.replace(/[./\s-]/g,''):value;
      const key=type==='NCM'?normalized:normalized.toLocaleLowerCase('pt-BR');
      if(seen.has(key))continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  };
  return {suggestedProducts:clean(input.suggestedProducts,'PRODUCT'),
    suggestedNcms:clean(input.suggestedNcms,'NCM')};
}

/** Writes only to the currently open DRAFT; migration 071 stores by release concept.
 * No staging writes, no NCM catalog changes, and no runtime classification.
 */
export async function updateF2DraftSuggestions(
 client:PoolClient,actor:CuratorActor,conceptCode:string,input:F2SuggestionEdit,
):Promise<F2SuggestionEdit> {
 if(!actor.justification.trim())throw new CurationError('JUSTIFICATION_REQUIRED',400);
 const draft=await requireOpenDraft(client);
 const values=validateF2Suggestions(input);
 const rows=await client.query<{id:string;codes:string[];membership:string}>(`
  SELECT rc.id,rc.official_codes AS codes,rc.membership_status AS membership
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c ON c.id=rc.concept_id
    JOIN taxonomy_dimensions d ON d.id=c.dimension_id
   WHERE rc.release_id=$1::uuid AND c.code=$2 AND d.code='sector'
  `,[draft.id,conceptCode]);
 const row=rows.rows[0];
 if(!row||row.membership!=='INCLUDED'||row.codes?.length!==1||
    !/^\d{7}$/.test(row.codes[0]??''))throw new CurationError('F2_SUGGESTIONS_CNAE_REQUIRED',400);
 await client.query(`
  UPDATE taxonomy_release_concepts
     SET f2_suggested_products=$2::text[],f2_suggested_ncms=$3::text[]
   WHERE id=$1::uuid AND release_id=$4::uuid
 `,[row.id,values.suggestedProducts,values.suggestedNcms,draft.id]);
 await client.query(`
  INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id)
  VALUES (NULL,'ADMIN',$1,'TAXONOMY_F2_SUGGESTIONS_CHANGED','taxonomy_curation',$2::uuid,$3::jsonb,gen_random_uuid())
 `,[actor.userId,draft.id,JSON.stringify({
   conceptCode,productsCount:values.suggestedProducts.length,ncmsCount:values.suggestedNcms.length,
   justification:actor.justification,
 })]);
 return values;
}
