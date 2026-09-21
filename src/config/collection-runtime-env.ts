import 'dotenv/config';
import { hostname } from 'node:os';

import { z } from 'zod';

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('postgres://') ||
      value.startsWith('postgresql://'),
    'Database URL must start with postgres:// or postgresql://',
  );

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: databaseUrlSchema,

  LOG_LEVEL: z
    .enum([
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'silent',
    ])
    .default('info'),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5),

  DB_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(10_000),

  DB_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .default(5_000),

  COLLECTION_WORKER_ID: z.string().min(1).optional(),

  COLLECTION_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(1_000),

  COLLECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(30_000),

  COLLECTION_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(15_000),

  COLLECTION_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .default(120_000),

  SCHEDULER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(30_000),

  CONFAZ_PROXY_URL: z.string().url().optional(),

  CONFAZ_RELAY_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('https://'),
      'CONFAZ relay URL must use https://',
    )
    .optional(),

  CONFAZ_RELAY_TOKEN: z
    .string()
    .min(24)
    .optional(),

  COLLECTION_ENABLE_SIMULATED_CONNECTORS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
}).superRefine((value, ctx) => {
  const hasRelayUrl = value.CONFAZ_RELAY_URL !== undefined;
  const hasRelayToken =
    value.CONFAZ_RELAY_TOKEN !== undefined;

  if (hasRelayUrl !== hasRelayToken) {
    ctx.addIssue({
      code: 'custom',
      path: ['CONFAZ_RELAY_URL'],
      message:
        'CONFAZ_RELAY_URL and CONFAZ_RELAY_TOKEN must be configured together',
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid collection runtime configuration.',
    parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'environment',
      message: issue.message,
    })),
  );
  process.exit(1);
}

export const collectionRuntimeEnv = {
  ...parsed.data,
  COLLECTION_WORKER_ID:
    parsed.data.COLLECTION_WORKER_ID ??
    `${hostname()}-${process.pid}`,
};
