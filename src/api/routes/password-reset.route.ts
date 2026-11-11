import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  completePasswordReset,
  PasswordResetRateLimitedError,
  requestPasswordReset,
} from '../../modules/auth/password-reset.service.js';

const requestBody = z.object({
  email: z.string().trim().email().max(320),
}).strict();

const resetBody = z.object({
  token: z.string().max(256),
  password: z.string().min(8).max(1024)
    .regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
  confirmPassword: z.string().min(1).max(1024),
}).strict().refine(
  (body) => body.password === body.confirmPassword,
  { path: ['confirmPassword'], message: 'passwords_do_not_match' },
);

export interface PasswordResetRoutesOptions {
  enabled: boolean;
  publicUrl?: string | undefined;
  tokenKey?: string | undefined;
}

export async function passwordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRoutesOptions,
): Promise<void> {
  app.post('/auth/password/forgot', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');

    if (!options.enabled || !options.publicUrl || !options.tokenKey) {
      return reply.status(503).send({ error: 'password_reset_unavailable' });
    }
    const body = requestBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    const started = Date.now();
    try {
      await requestPasswordReset(app.db, {
        email: body.data.email,
        ip: request.ip,
        publicUrl: options.publicUrl,
        tokenKey: options.tokenKey,
      });
    } catch (error) {
      if (error instanceof PasswordResetRateLimitedError) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
        return reply.status(429).send({ error: 'too_many_requests' });
      }
      throw error;
    } finally {
      // Reduz diferenciais basicos de tempo entre enderecos existentes e ausentes.
      // A API nao deve depender disso como unica protecao anti-enumeracao.
      if (process.env.NODE_ENV !== 'test') {
        const remaining = Math.max(0, 1200 - (Date.now() - started));
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }
    }

    return reply.status(202).send({ status: 'if_account_exists' });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');

    if (!options.enabled) {
      return reply.status(503).send({ error: 'password_reset_unavailable' });
    }
    const body = resetBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_password_reset_data' });
    }

    try {
      const result = await completePasswordReset(app.db, {
        token: body.data.token,
        password: body.data.password,
        ip: request.ip,
      });
      if (result === 'invalid') {
        return reply.status(400).send({ error: 'invalid_or_expired_reset_token' });
      }
      // Cliente descarta toda sessao anterior e volta ao login.
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof PasswordResetRateLimitedError) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
        return reply.status(429).send({ error: 'too_many_requests' });
      }
      throw error;
    }
  });
}
