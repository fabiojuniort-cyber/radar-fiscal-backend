import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import { kyselyRunner } from '../../modules/taxonomy/curation/curation.read.js';
import { isPlatformAdmin } from '../../modules/auth/platform-role.js';
export async function onboardingPhraseRoutes(app: FastifyInstance) {
  const typed=app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/onboarding/phrases',{preHandler:app.authenticate},async(request,reply)=>{
    if(!request.auth) return reply.code(401).send({error:'unauthorized'});
    return withUserContext(app.db,request.auth.userId,async trx=>({items:await kyselyRunner(trx)<{
      segment:string;phrases:string[];version_no:number}>('SELECT segment,phrases,version_no FROM onboarding_phrases ORDER BY segment')}));
  });
  typed.put('/api/v1/admin/onboarding/phrases/:segment',{preHandler:app.authenticate,schema:{
    params:z.object({segment:z.string().regex(/^[a-z_]+$/).max(40)}),
    body:z.object({expectedVersion:z.number().int().min(1),phrases:z.array(z.string().trim().min(1).max(300)).min(1).max(100)})
  }},async(request,reply)=>{
    if(!request.auth || !await isPlatformAdmin(app.db,request.auth.userId)) return reply.code(403).send({error:'platform_admin_required'});
    const result=await withUserContext(app.db,request.auth.userId,async trx=>kyselyRunner(trx)<{segment:string;phrases:string[];version_no:number}>(
      'UPDATE onboarding_phrases SET phrases=$1::jsonb,version_no=version_no+1 WHERE segment=$2 AND version_no=$3 RETURNING segment,phrases,version_no',
      [JSON.stringify(request.body.phrases),request.params.segment,request.body.expectedVersion]));
    if(!result.length) return reply.code(409).send({error:'phrase_version_conflict'});
    return reply.send({item:result[0]});
  });
}
