import 'dotenv/config';
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

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  HOST: z.string().min(1).default('0.0.0.0'),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3000),

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

  DATABASE_URL: databaseUrlSchema,

  DATABASE_ADMIN_URL: databaseUrlSchema.optional(),

  JWT_ACCESS_SECRET: z.string().min(32),

  AUTH_REFRESH_COOKIE_NAME: z
    .string()
    .min(1)
    .default('radar_refresh_token'),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10),

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
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errors = parsedEnv.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'environment',
    message: issue.message,
  }));

  console.error('Invalid environment configuration.', errors);
  process.exit(1);
}

export const env = parsedEnv.data;

export type AppEnv = typeof env;
