import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { douLimitsSchema, readAdminDouLimits, saveAdminDouLimits } from '../../modules/collection/dou-download-limits.js';

import {
  changePlatformAdministrator,
  isPlatformAdmin,
  listPlatformAdministrators,
  platformAdminErrorCode,
} from '../../modules/auth/platform-role.js';

const emailBody = z.object({
  email: z.string().trim().email().max(320),
});

export async function platformAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const requirePlatformAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
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
    '/api/v1/admin/platform/administrators',
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const items = await listPlatformAdministrators(
        app.db,
        request.auth!.userId,
      );
      return reply.send({
        items,
        lastAdminProtection: true,
      });
    },
  );

  typed.post(
    '/api/v1/admin/platform/administrators/grant',
    {
      preHandler: requirePlatformAdmin,
      schema: { body: emailBody },
    },
    async (request, reply) => {
      try {
        const result = await changePlatformAdministrator(
          app.db,
          request.auth!.userId,
          request.body.email,
          'grant',
        );
        return reply.send(result);
      } catch (error) {
        const code = platformAdminErrorCode(error);
        if (code) {
          const status =
            code === 'platform_admin_required'
              ? 403
              : code === 'platform_admin_user_not_found'
                ? 404
                : 409;
          return reply.status(status).send({ error: code });
        }
        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/admin/platform/administrators/revoke',
    {
      preHandler: requirePlatformAdmin,
      schema: { body: emailBody },
    },
    async (request, reply) => {
      try {
        const result = await changePlatformAdministrator(
          app.db,
          request.auth!.userId,
          request.body.email,
          'revoke',
        );
        return reply.send(result);
      } catch (error) {
        const code = platformAdminErrorCode(error);
        if (code) {
          const status =
            code === 'platform_admin_required'
              ? 403
              : code === 'platform_admin_user_not_found'
                ? 404
                : 409;
          return reply.status(status).send({ error: code });
        }
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/admin/platform/dou-download-limits',
    { preHandler: requirePlatformAdmin },
    async (_request, reply) => reply.send(await readAdminDouLimits(app.db)),
  );

  typed.put(
    '/api/v1/admin/platform/dou-download-limits',
    {
      preHandler: requirePlatformAdmin,
      schema: { body: douLimitsSchema },
    },
    async (request, reply) => {
      try {
        return reply.send(await saveAdminDouLimits(app.db, request.auth!.userId, request.body));
      } catch (error) {
        // No privileged source UPDATE and no silent in-memory-only settings.
        // The DB write gate intentionally requires a separately reviewed SQL change.
        if (error instanceof Error && 'code' in error && error.code === '42883') {
          return reply.status(503).send({ error: 'dou_limits_store_not_ready' });
        }
        if (error instanceof Error && error.message === 'DOU_SOURCE_NOT_FOUND') {
          return reply.status(409).send({ error: 'dou_source_not_found' });
        }
        throw error;
      }
    },
  );
}
