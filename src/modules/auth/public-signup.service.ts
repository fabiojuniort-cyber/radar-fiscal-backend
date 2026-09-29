import {
  createHash,
  randomUUID,
} from 'node:crypto';

import {
  sql,
  type Kysely,
} from 'kysely';
import { z } from 'zod';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  hashPassword,
  normalizeEmail,
} from './auth.service.js';

export const PUBLIC_SIGNUP_CONSENT_VERSION =
  '2026-09-29-v1';

const PUBLIC_SIGNUP_RATE_WINDOW_SECONDS = 15 * 60;
const PUBLIC_SIGNUP_RATE_MAX_ATTEMPTS = 5;

export function isValidCnpj(
  value: string,
): boolean {
  if (
    !/^\d{14}$/.test(value) ||
    /^(\d)\1{13}$/.test(value)
  ) {
    return false;
  }

  const calculateDigit = (
    digits: string,
    weights: number[],
  ): number => {
    const sum = weights.reduce(
      (total, weight, index) =>
        total +
        Number(digits[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2
      ? 0
      : 11 - remainder;
  };

  const first = calculateDigit(
    value.slice(0, 12),
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );

  if (first !== Number(value[12])) {
    return false;
  }

  const second = calculateDigit(
    value.slice(0, 13),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );

  return second === Number(value[13]);
}

const optionalCnpjSchema = z
  .string()
  .trim()
  .max(32)
  .optional()
  .refine(
    (value) =>
      !value ||
      /^[0-9./\-\s]+$/.test(value),
    'invalid_cnpj',
  )
  .transform((value) => {
    if (!value) return null;
    return value.replace(/\D/g, '');
  })
  .refine(
    (value) =>
      value === null ||
      isValidCnpj(value),
    'invalid_cnpj',
  );

export const publicSignupBodySchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(320),
    company: z.string().trim().min(2).max(200),
    cnpj: optionalCnpjSchema,
    password: z
      .string()
      .min(8)
      .max(1024)
      .regex(/[a-z]/)
      .regex(/[A-Z]/)
      .regex(/[0-9]/)
      .regex(/[^a-zA-Z0-9]/),
    confirmPassword: z.string().min(1).max(1024),
    acceptedTerms: z.literal(true),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: 'passwords_do_not_match',
      });
    }
  });

export type PublicSignupInput =
  z.infer<typeof publicSignupBodySchema>;

export interface PublicSignupResult {
  user: {
    id: string;
    email: string;
    name: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
  membership: {
    role: 'OWNER';
  };
}

export class PublicSignupCompanyExistsError
  extends Error {
  constructor() {
    super('company_already_registered');
    this.name = 'PublicSignupCompanyExistsError';
  }
}

export class PublicSignupEmailExistsError
  extends Error {
  constructor() {
    super('email_already_registered');
    this.name = 'PublicSignupEmailExistsError';
  }
}

export class PublicSignupRateLimitedError
  extends Error {
  constructor(
    readonly retryAfterSeconds: number,
  ) {
    super('too_many_requests');
    this.name = 'PublicSignupRateLimitedError';
  }
}

function signupRateKey(email: string): string {
  return createHash('sha256')
    .update(normalizeEmail(email), 'utf8')
    .digest('hex');
}

function tenantSlug(companyName: string): string {
  const base = companyName
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  const prefix = base || 'tenant';
  const suffix = randomUUID()
    .replaceAll('-', '')
    .slice(0, 12);

  return `${prefix}-${suffix}`;
}

function databaseErrorInfo(
  error: unknown,
): {
  code: string | undefined;
  constraint: string | undefined;
} {
  if (
    typeof error !== 'object' ||
    error === null
  ) {
    return {
      code: undefined,
      constraint: undefined,
    };
  }

  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
  };

  return {
    code:
      typeof candidate.code === 'string'
        ? candidate.code
        : undefined,
    constraint:
      typeof candidate.constraint === 'string'
        ? candidate.constraint
        : undefined,
  };
}

export function publicSignupErrorMetadata(
  error: unknown,
): {
  errorName: string;
  dbCode: string | undefined;
} {
  const db = databaseErrorInfo(error);

  return {
    errorName:
      error instanceof Error
        ? error.name
        : 'UnknownError',
    dbCode: db.code,
  };
}

export async function registerPublicAccount(
  db: Kysely<DB>,
  input: PublicSignupInput,
): Promise<PublicSignupResult> {
  const email = normalizeEmail(input.email);
  const rate = await sql<{
    allowed: boolean;
    retry_after_seconds: number;
  }>`
    select
      allowed,
      retry_after_seconds
    from public.auth_public_signup_rate_limit(
      ${signupRateKey(email)},
      ${PUBLIC_SIGNUP_RATE_WINDOW_SECONDS},
      ${PUBLIC_SIGNUP_RATE_MAX_ATTEMPTS}
    )
  `.execute(db);

  const rateResult = rate.rows[0];

  if (!rateResult?.allowed) {
    throw new PublicSignupRateLimitedError(
      rateResult?.retry_after_seconds ?? 60,
    );
  }

  const passwordHash = await hashPassword(
    input.password,
  );

  try {
    const created = await db
      .transaction()
      .execute(async (trx) => {
        const result = await sql<{
          user_id: string;
          tenant_id: string;
          tenant_slug: string;
        }>`
          select
            user_id,
            tenant_id,
            tenant_slug
          from public.auth_public_signup_create_account(
            ${input.name},
            ${email},
            ${input.company},
            ${input.cnpj},
            ${passwordHash},
            ${input.acceptedTerms},
            ${tenantSlug(input.company)},
            ${PUBLIC_SIGNUP_CONSENT_VERSION}
          )
        `.execute(trx);

        const row = result.rows[0];

        if (!row) {
          throw new Error(
            'public_signup_insert_failed',
          );
        }

        return row;
      });

    return {
      user: {
        id: created.user_id,
        email,
        name: input.name,
      },
      tenant: {
        id: created.tenant_id,
        name: input.company,
        slug: created.tenant_slug,
      },
      membership: {
        role: 'OWNER',
      },
    };
  } catch (error) {
    const dbError = databaseErrorInfo(error);

    if (
      dbError.code === '23505' &&
      dbError.constraint ===
        'uq_app_users_email_lower'
    ) {
      throw new PublicSignupEmailExistsError();
    }

    if (
      dbError.code === '23505' &&
      dbError.constraint ===
        'uq_tenant_onboarding_profiles_cnpj'
    ) {
      throw new PublicSignupCompanyExistsError();
    }

    throw error;
  }
}
