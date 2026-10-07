import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

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
}
