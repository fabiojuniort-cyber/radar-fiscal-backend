import type { FastifyServerOptions } from 'fastify';

import { env } from '../../config/env.js';

export const loggerOptions: NonNullable<
  FastifyServerOptions['logger']
> = {
  level: env.LOG_LEVEL,

  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',

      'password',
      'confirmPassword',
      'accessToken',
      'refreshToken',

      '*.password',
      '*.confirmPassword',
      '*.accessToken',
      '*.refreshToken',

      'req.body.password',
      'req.body.confirmPassword',
    ],

    censor: '[REDACTED]',
  },
};