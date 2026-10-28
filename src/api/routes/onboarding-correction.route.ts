import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {withTenantContext,TenantAccessDeniedError} from '../../infrastructure/database/tenant-context.js';

const text=(max:number)=>z.string().trim().max(max).nullable();
const fields=z.object({legalName:z.string().trim().min(2).max(200),stateRegistration:text(30).optional(),businessLocationCode:text(80),
  street:text(200),streetNumber:text(30),district:text(160),complement:text(160),
  municipalityName:text(160),municipalityIbgeCode:z.string().regex(/^\d{7}$/).nullable(),
  postalCode:z.string().regex(/^\d{8}$/).nullable(),uf:z.string().regex(/^[A-Z]{2}$/)}).strict();
class CorrectionError extends Error{constructor(public status:number,public code:string){super(code);}}
/** Atomic CAS of displayed registration + optional IE. Never resubmits CNAEs/profile data. */
export async function onboardingCorrectionRoutes(app:FastifyInstance){
 app.withTypeProvider<ZodTypeProvider>().patch('/api/v1/companies/:companyId/establishments/:establishmentId/onboarding-data',{
  preHandler:app.authenticate,schema:{params:z.object({companyId:z.string().uuid(),establishmentId:z.string().uuid()}),body:z.object({expected:fields,values:fields}).strict()}
 },async(request,reply)=>{
  if(!request.auth)return reply.code(401).send({error:'unauthorized'});
  const tenant=z.string().uuid().safeParse(request.headers['x-tenant-id']);
  if(!tenant.success)return reply.code(400).send({error:'tenant_required'});
  try{
   const result=await withTenantContext(app.db,request.auth.userId,tenant.data,async trx=>{
    const member=await trx.selectFrom('tenant_memberships').select('role').where('tenant_id','=',tenant.data).where('user_id','=',request.auth!.userId).executeTakeFirst();
    if(!member||!['OWNER','ADMIN'].includes(member.role))throw new CorrectionError(403,'admin_required');
    const company=await trx.selectFrom('companies').select(['id','legal_name']).where('id','=',request.params.companyId).where('tenant_id','=',tenant.data).where('is_active','=',true).forUpdate().executeTakeFirst();
    if(!company)throw new CorrectionError(404,'company_not_found');
    const unit=await trx.selectFrom('establishments').selectAll().where('id','=',request.params.establishmentId).where('company_id','=',company.id).where('is_active','=',true).forUpdate().executeTakeFirst();
    if(!unit)throw new CorrectionError(404,'establishment_not_found');
    const current={legalName:company.legal_name,businessLocationCode:unit.business_location_code,street:unit.street,streetNumber:unit.street_number,district:unit.district,complement:unit.complement,municipalityName:unit.municipality_name,municipalityIbgeCode:unit.municipality_ibge_code,postalCode:unit.postal_code,uf:unit.uf};
    const ieExpected=request.body.expected.stateRegistration;
    if(ieExpected!==undefined&&ieExpected!==unit.state_registration)throw new CorrectionError(409,'registration_data_conflict');
    if((request.body.values.stateRegistration===undefined)!==(ieExpected===undefined))throw new CorrectionError(400,'invalid_ie_correction');
    if(Object.entries(current).some(([key,value])=>request.body.expected[key as keyof typeof current]!==value))throw new CorrectionError(409,'registration_data_conflict');
    const v=request.body.values;
    await trx.updateTable('companies').set({legal_name:v.legalName}).where('id','=',company.id).execute();
    const registration=v.stateRegistration?.trim()||null;
    const ieChange=ieExpected!==undefined&&(registration!==unit.state_registration||v.uf!==unit.uf)?{state_registration:registration,state_registration_source:registration?'MANUAL':null,state_registration_status:null,state_registration_checked_at:null,state_registration_lookup_status:null}:{};
    await trx.updateTable('establishments').set({...ieChange,business_location_code:v.businessLocationCode,street:v.street,street_number:v.streetNumber,district:v.district,complement:v.complement,municipality_name:v.municipalityName,municipality_ibge_code:v.municipalityIbgeCode,postal_code:v.postalCode,uf:v.uf}).where('id','=',unit.id).execute();
    return {establishmentId:unit.id,...v,stateRegistration:ieExpected===undefined?unit.state_registration:registration,stateRegistrationSource:'state_registration_source'in ieChange?ieChange.state_registration_source:unit.state_registration_source};
   });return reply.send(result);
  }catch(e){
   if(e instanceof CorrectionError)return reply.code(e.status).send({error:e.code});
   if(e instanceof TenantAccessDeniedError)return reply.code(403).send({error:'tenant_access_denied'});
   if(typeof e==='object'&&e&&'constraint'in e&&e.constraint==='uq_establishment_business_location_per_company')return reply.code(409).send({error:'business_location_code_exists'});
   throw e;
  }
 });
}

