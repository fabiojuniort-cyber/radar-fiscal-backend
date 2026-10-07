import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { isPlatformAdmin } from '../../modules/auth/platform-role.js';
import {
  approveCollectionFilterDraft,
  collectionFilterAdminErrorCode,
  listCollectionFilterNewTypes,
  listCollectionFilterSimulationItems,
  readCollectionFilterAdminState,
  requestCollectionFilterSimulation,
  resolveCollectionFilterNewType,
  saveCollectionFilterDraft,
  saveCollectionFilterSimulationFeedback,
} from '../../modules/collection/collection-filter.admin.js';

const mode = z.enum([
  'KEEP_ALWAYS',
  'KEEP_IF_TAX_TERM',
  'EXCLUDE_UNLESS_STRONG',
  'EXCLUDE_ALWAYS',
]);
const strength = z.enum(['STRONG', 'WEAK', 'NEGATIVE']);
const locationScope = z.enum(['ANY', 'TITLE', 'SUMMARY', 'BODY']);

const draftBody = z.object({
  contextWindowWords: z.number().int().min(0).max(100),
  weakScoreThreshold: z.number().int().min(1).max(100),
  locationWeights: z.object({
    title: z.number().int().min(1).max(20),
    summary: z.number().int().min(1).max(20),
    body: z.number().int().min(1).max(20),
  }),
  changeNotes: z.string().trim().max(2000).nullable().optional(),
  rules: z.array(
    z.object({
      sourceCode: z.string().trim().min(1).max(100),
      section: z.string().trim().max(50).optional(),
      canonicalType: z.string().trim().min(1).max(300),
      mode,
      helpText: z.string().trim().max(1000).nullable().optional(),
    }),
  ).max(5000),
  aliases: z.array(
    z.object({
      sourceCode: z.string().trim().min(1).max(100),
      section: z.string().trim().max(50).optional(),
      alias: z.string().trim().min(1).max(300),
      canonicalType: z.string().trim().min(1).max(300),
    }),
  ).max(10000),
  terms: z.array(
    z.object({
      text: z.string().trim().min(1).max(300),
      strength,
      sourceCode: z.string().trim().max(100).optional(),
      section: z.string().trim().max(50).optional(),
      canonicalType: z.string().trim().max(300).optional(),
      locationScope: locationScope.optional(),
    }),
  ).max(10000),
});

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

  typed.put(
    '/api/v1/admin/collection-filter/draft',
    {
      preHandler: requirePlatformAdmin,
      schema: { body: draftBody },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await saveCollectionFilterDraft(
            app.db,
            request.auth!.userId,
            request.body,
          ),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (
            error instanceof RangeError ||
            /duplicate|conflicting|cannot preserve|must not be blank/.test(
              error.message,
            )
          )
        ) {
          return reply.status(400).send({
            error: 'invalid_collection_filter_draft',
            detail: error.message,
          });
        }
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/admin/collection-filter/new-types',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        querystring: z.object({
          status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).default('OPEN'),
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

  typed.post(
    '/api/v1/admin/collection-filter/new-types/:id/resolve',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          status: z.enum(['RESOLVED', 'IGNORED']),
        }),
      },
    },
    async (request, reply) =>
      reply.send(
        await resolveCollectionFilterNewType(
          app.db,
          request.auth!.userId,
          request.params.id,
          request.body.status,
        ),
      ),
  );
  typed.post(
    '/api/v1/admin/collection-filter/drafts/:policyId/simulations',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        params: z.object({ policyId: z.string().uuid() }),
        body: z.object({
          scope: z.enum(['FULL_ARCHIVE', 'RECENT']).default('FULL_ARCHIVE'),
          reviewMode: z.enum(['ALL', 'SAMPLE', 'NONE']).default('SAMPLE'),
        }),
      },
    },
    async (request, reply) => {
      try {
        const result = await requestCollectionFilterSimulation(
          app.db,
          request.auth!.userId,
          request.params.policyId,
          request.body.scope,
          request.body.reviewMode,
        );
        return reply.status(result.action === 'CREATED' ? 202 : 200).send(result);
      } catch (error) {
        const code = collectionFilterAdminErrorCode(error);
        if (code) {
          return reply.status(code === 'platform_admin_required' ? 403 : 409).send({
            error: code,
          });
        }
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/admin/collection-filter/simulations/:simulationId/items',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        params: z.object({ simulationId: z.string().uuid() }),
        querystring: z.object({
          decision: z.enum(['KEEP', 'DISCARD']).optional(),
          sampleOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) =>
      reply.send({
        items: await listCollectionFilterSimulationItems(
          app.db,
          request.auth!.userId,
          request.params.simulationId,
          request.query,
        ),
      }),
  );

  typed.put(
    '/api/v1/admin/collection-filter/simulations/:simulationId/items/:publicationId/feedback',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        params: z.object({
          simulationId: z.string().uuid(),
          publicationId: z.string().uuid(),
        }),
        body: z.object({
          markedError: z.boolean().default(true),
          expectedDecision: z.enum(['KEEP', 'DISCARD']).nullable().optional(),
          note: z.string().trim().max(2000).nullable().optional(),
        }),
      },
    },
    async (request, reply) =>
      reply.send(
        await saveCollectionFilterSimulationFeedback(
          app.db,
          request.auth!.userId,
          {
            simulationId: request.params.simulationId,
            publicationId: request.params.publicationId,
            ...request.body,
          },
        ),
      ),
  );

  typed.post(
    '/api/v1/admin/collection-filter/drafts/:policyId/approve',
    {
      preHandler: requirePlatformAdmin,
      schema: {
        params: z.object({ policyId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await approveCollectionFilterDraft(
            app.db,
            request.auth!.userId,
            request.params.policyId,
          ),
        );
      } catch (error) {
        const code = collectionFilterAdminErrorCode(error);
        if (code) {
          return reply.status(code === 'platform_admin_required' ? 403 : 409).send({
            error: code,
          });
        }
        throw error;
      }
    },
  );

}
