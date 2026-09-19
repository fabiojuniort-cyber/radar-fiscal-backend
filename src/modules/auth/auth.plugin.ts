import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { validateSession } from './auth.service.js';

const accessTokenSchema = z.object({
  sub: z.string().uuid(),
  sid: z.string().uuid(),
  typ: z.literal('access'),
});

export async function registerAuthSupport(
  app: FastifyInstance,
): Promise<void> {
  await app.register(cookie);

  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  });

  app.decorateRequest('auth', null);

  app.decorate(
    'authenticate',
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      try {
        await request.jwtVerify();

        const parsed = accessTokenSchema.safeParse(
          request.user,
        );

        if (!parsed.success) {
          await reply.status(401).send({
            error: 'unauthorized',
          });
          return;
        }

        const sessionIsValid = await validateSession(
          app.db,
          parsed.data.sub,
          parsed.data.sid,
        );

        if (!sessionIsValid) {
          await reply.status(401).send({
            error: 'unauthorized',
          });
          return;
        }

        request.auth = {
          userId: parsed.data.sub,
          sessionId: parsed.data.sid,
        };
      } catch {
        await reply.status(401).send({
          error: 'unauthorized',
        });
      }
    },
  );
}
