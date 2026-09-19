import type {
  FastifyInstance,
  FastifyReply,
} from 'fastify';
import {
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_INACTIVITY_DAYS,
} from '../../modules/auth/auth.constants.js';
import {
  loginWithPassword,
  revokeSession,
  rotateRefreshToken,
} from '../../modules/auth/auth.service.js';

const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const REFRESH_COOKIE_MAX_AGE_SECONDS =
  REFRESH_INACTIVITY_DAYS * 24 * 60 * 60;

function setRefreshCookie(
  reply: FastifyReply,
  refreshToken: string,
): void {
  reply.setCookie(
    env.AUTH_REFRESH_COOKIE_NAME,
    refreshToken,
    {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
    },
  );
}

function clearRefreshCookie(
  reply: FastifyReply,
): void {
  reply.clearCookie(
    env.AUTH_REFRESH_COOKIE_NAME,
    {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/auth',
    },
  );
}

export async function authRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/auth/login',
    {
      schema: {
        body: loginBodySchema,
      },
    },
    async (request, reply) => {
      const userAgentHeader =
        request.headers['user-agent'];

      const session = await loginWithPassword(
        app.db,
        request.body.email,
        request.body.password,
        {
          ipAddress: request.ip,
          userAgent:
            typeof userAgentHeader === 'string'
              ? userAgentHeader
              : undefined,
        },
      );

      if (!session) {
        return reply.status(401).send({
          error: 'invalid_credentials',
        });
      }

      const accessToken = app.jwt.sign({
        sub: session.user.id,
        sid: session.sessionId,
        typ: 'access',
      });

      setRefreshCookie(
        reply,
        session.refreshToken,
      );

      return reply.status(200).send({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: session.user,
      });
    },
  );

  typed.post(
    '/auth/refresh',
    async (request, reply) => {
      const refreshToken =
        request.cookies[
          env.AUTH_REFRESH_COOKIE_NAME
        ];

      if (!refreshToken) {
        clearRefreshCookie(reply);

        return reply.status(401).send({
          error: 'invalid_refresh_token',
        });
      }

      const refreshed = await rotateRefreshToken(
        app.db,
        refreshToken,
      );

      if (!refreshed) {
        clearRefreshCookie(reply);

        return reply.status(401).send({
          error: 'invalid_refresh_token',
        });
      }

      const accessToken = app.jwt.sign({
        sub: refreshed.userId,
        sid: refreshed.sessionId,
        typ: 'access',
      });

      setRefreshCookie(
        reply,
        refreshed.refreshToken,
      );

      return reply.status(200).send({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      });
    },
  );

  typed.post(
    '/auth/logout',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.auth) {
        clearRefreshCookie(reply);
        return reply.status(401).send({
          error: 'unauthorized',
        });
      }

      await revokeSession(
        app.db,
        request.auth.sessionId,
      );

      clearRefreshCookie(reply);

      return reply.status(204).send();
    },
  );

  typed.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({
          error: 'unauthorized',
        });
      }

      const result = await withUserContext(
        app.db,
        request.auth.userId,
        async (trx) => {
          const user = await trx
            .selectFrom('app_users')
            .select([
              'id',
              'email',
              'name',
              'status',
            ])
            .where(
              'id',
              '=',
              request.auth!.userId,
            )
            .executeTakeFirst();

          if (!user || user.status !== 'ACTIVE') {
            return null;
          }

          const memberships = await trx
            .selectFrom('tenant_memberships')
            .innerJoin(
              'tenants',
              'tenants.id',
              'tenant_memberships.tenant_id',
            )
            .select([
              'tenant_memberships.tenant_id',
              'tenant_memberships.role',
              'tenants.name as tenant_name',
              'tenants.slug as tenant_slug',
            ])
            .where(
              'tenant_memberships.user_id',
              '=',
              user.id,
            )
            .where(
              'tenants.status',
              '=',
              'ACTIVE',
            )
            .orderBy('tenants.name')
            .execute();

          return {
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
            },
            memberships: memberships.map(
              (membership) => ({
                tenantId:
                  membership.tenant_id,
                tenantName:
                  membership.tenant_name,
                tenantSlug:
                  membership.tenant_slug,
                role: membership.role,
              }),
            ),
          };
        },
      );

      if (!result) {
        return reply.status(401).send({
          error: 'unauthorized',
        });
      }

      return reply.status(200).send(result);
    },
  );
}
