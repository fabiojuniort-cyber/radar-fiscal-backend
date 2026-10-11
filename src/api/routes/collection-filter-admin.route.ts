import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { isPlatformAdmin } from '../../modules/auth/platform-role.js';
import {previewDirectFilterRule,confirmDirectFilterRule} from '../../modules/collection/collection-filter.direct.js';
import {editActiveCollectionFilter} from '../../modules/collection/collection-filter.direct-admin.js';
import {
  listCollectionFilterDiscardAlerts,
  listCollectionFilterDiscards,
  listCollectionFilterNewTypes,
  readCollectionFilterAdminState,
} from '../../modules/collection/collection-filter.admin.js';

const mode = z.enum([
  'KEEP_ALWAYS',
  'KEEP_IF_TAX_TERM',
  'EXCLUDE_UNLESS_STRONG',
  'EXCLUDE_ALWAYS',
]);
export async function collectionFilterAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const requirePlatformAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (
      !request.auth ||
      !(await isPlatformAdmin(app.db, request.auth.userId))
    ) {
      await reply.status(403).send({
        error: 'platform_admin_required',
      });
    }
  };

  typed.get(
    '/api/v1/admin/collection-filter/state',
    { preHandler: requirePlatformAdmin },
    async (request, reply) =>
      reply.send(
        await readCollectionFilterAdminState(
          app.db,
          request.auth!.userId,
        ),
      ),
  );

  typed.get(
    '/api/v1/admin/collection-filter/discarded',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        querystring: z.object({
          sourceCode: z.string().trim().min(1).max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) =>
      reply.send({
        items: await listCollectionFilterDiscards(
          app.db,
          request.auth!.userId,
          request.query,
        ),
      }),
  );

  typed.get(
    '/api/v1/admin/collection-filter/discard-alerts',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        querystring: z.object({
          status: z.enum(['OPEN', 'ACKNOWLEDGED']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (request, reply) =>
      reply.send({
        items: await listCollectionFilterDiscardAlerts(
          app.db,
          request.auth!.userId,
          request.query,
        ),
      }),
  );

  typed.get(
    '/api/v1/admin/collection-filter/new-types',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        querystring: z.object({
          status: z.enum(['OPEN', 'RESOLVED', 'MERGED']).default('OPEN'),
        }),
      },
    },
    async (request, reply) =>
      reply.send({
        items: await listCollectionFilterNewTypes(
          app.db,
          request.auth!.userId,
          request.query.status,
        ),
      }),
  );

  // L-11: strict admin-only preview and revision-safe confirm.
  const directBody = z.object({
    sourceCode: z.literal('dou'),
    section: z.string().trim().min(1).max(50),
    canonicalType: z.string().trim().min(1).max(300),
    mode,
    newTypeId: z.string().uuid().optional(),
  });
  typed.post('/api/v1/admin/collection-filter/direct-rule/preview', {
    preHandler: requirePlatformAdmin,
    schema:{body:directBody},
  }, async (request,reply)=>{
    try {
      return reply.send(await previewDirectFilterRule(app.db,request.auth!.userId,request.body));
    } catch (error) {
      if (error instanceof RangeError) return reply.status(400).send({error:error.message});
      throw error;
    }
  });

  typed.post('/api/v1/admin/collection-filter/direct-rule/confirm', {
    preHandler: requirePlatformAdmin,
    schema:{body:directBody.extend({
      expectedCount:z.number().int().nonnegative(),
      previewToken:z.string().regex(/^[a-f0-9]{64}$/),
      resume:z.boolean().optional(),
    })},
  }, async (request,reply)=>{
    const {expectedCount,previewToken,resume,...rule}=request.body;
    try {
      const result=await confirmDirectFilterRule(
        app.db,request.auth!.userId,rule,expectedCount,previewToken,resume===true);
      return reply.send(result);
    } catch (error) {
      if (error instanceof RangeError) return reply.status(400).send({error:error.message});
      throw error;
    }
  });

  // Non-destructive direct edits. Discarding type/mode changes MUST use
  // /direct-rule/preview and /direct-rule/confirm instead.
  typed.post('/api/v1/admin/collection-filter/direct-admin-edit', {
    preHandler: requirePlatformAdmin,
    schema:{body:z.object({
      action:z.enum([
        'RULE_KEEP','RULE_DELETE','TERM_PUT','TERM_DELETE',
        'ALIAS_PUT','ALIAS_DELETE','NEWTYPE_MERGE','NEWTYPE_KEEP',
      ]),
      payload:z.record(z.string(),z.unknown()),
    })},
  },async(request,reply)=>{
    try {
      return reply.send(await editActiveCollectionFilter(
        app.db,request.auth!.userId,request.body.action,request.body.payload
      ));
    } catch(error) {
      const code=(error as {code?:string}).code;
      if(code==='22023')return reply.status(400).send({error:'invalid_direct_admin_edit'});
      if(code==='P0001'||code==='23505')
        return reply.status(409).send({error:'direct_admin_edit_conflict'});
      if(code==='42501')return reply.status(403).send({error:'platform_admin_required'});
      throw error;
    }
  });

}
