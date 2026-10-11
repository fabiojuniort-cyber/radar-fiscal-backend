import {
  createHash,
  randomBytes,
} from 'node:crypto';

import { Pool } from 'pg';
import { z } from 'zod';

const smokeEnvSchema = z.object({
  LAUNCH01_SMOKE_BASE_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('https://'),
      'LAUNCH01_SMOKE_BASE_URL must use HTTPS.',
    ),
  LAUNCH01_API_BASE_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('https://'),
      'LAUNCH01_API_BASE_URL must use HTTPS.',
    ),
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') ||
        value.startsWith('postgresql://'),
      'DATABASE_ADMIN_URL must be a PostgreSQL URL.',
    ),
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

const parsed = smokeEnvSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(
    'LAUNCH-01 smoke configuration is invalid.',
  );
}

const env = parsed.data;
const baseUrl =
  env.LAUNCH01_SMOKE_BASE_URL.replace(/\/$/, '');
const apiBaseUrl =
  env.LAUNCH01_API_BASE_URL.replace(/\/$/, '');

const SMOKE_COMPANY =
  'LAUNCH01 Smoke Test';
const SMOKE_EMAIL_SUFFIX =
  '@example.invalid';

interface SmokeSummary {
  home?: number;
  register?: number;
  login?: number;
  me?: number;
  accountBefore?: number;
  company?: number;
  establishment?: number;
  profileWrite?: number;
  profileRead?: number;
  accountAfter?: number;
  stats?: number;
  sources?: number;
  archive?: number;
  logout?: number;
  cleanup?:
    | 'PASS'
    | 'NOTHING_TO_REMOVE';
  result?: 'PASS';
}

function executeRequested(): boolean {
  return process.argv.includes('--execute');
}

function cookiesFrom(
  response: Response,
): string {
  const headers =
    response.headers as Headers & {
      getSetCookie?: () => string[];
    };

  const values =
    typeof headers.getSetCookie ===
    'function'
      ? headers.getSetCookie()
      : [
          response.headers.get(
            'set-cookie',
          ),
        ].filter(
          (value): value is string =>
            Boolean(value),
        );

  return values
    .map((value) =>
      value.split(';', 1)[0],
    )
    .filter(Boolean)
    .join('; ');
}

async function expectStatus(
  summary: SmokeSummary,
  label: Exclude<
    keyof SmokeSummary,
    'cleanup' | 'result'
  >,
  response: Response,
  expected: number,
): Promise<void> {
  summary[label] = response.status;

  if (response.status === expected) {
    return;
  }

  let errorCode = 'unreadable';

  try {
    const payload =
      (await response
        .clone()
        .json()) as {
        error?: unknown;
      };

    if (
      typeof payload.error === 'string'
    ) {
      errorCode = payload.error;
    }
  } catch {
    // Do not log response bodies.
  }

  throw new Error(
    String(label) +
      '_expected_' +
      String(expected) +
      '_got_' +
      String(response.status) +
      '_' +
      errorCode,
  );
}

function rateKey(email: string): string {
  return createHash('sha256')
    .update(
      email.trim().toLowerCase(),
      'utf8',
    )
    .digest('hex');
}

function validCnpj(
  seed: string,
): string {
  const digits = seed
    .replace(/\D/g, '')
    .padEnd(12, '7')
    .slice(0, 12);

  const calculate = (
    value: string,
    weights: number[],
  ): number => {
    const sum = weights.reduce(
      (total, weight, index) =>
        total +
        Number(value[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2
      ? 0
      : 11 - remainder;
  };

  const first = calculate(
    digits,
    [
      5, 4, 3, 2, 9, 8,
      7, 6, 5, 4, 3, 2,
    ],
  );

  const second = calculate(
    digits + String(first),
    [
      6, 5, 4, 3, 2, 9, 8,
      7, 6, 5, 4, 3, 2,
    ],
  );

  return (
    digits +
    String(first) +
    String(second)
  );
}

async function cleanup(
  pool: Pool,
  email: string,
): Promise<
  'PASS' | 'NOTHING_TO_REMOVE'
> {
  const found =
    await pool.query<{
      user_id: string;
      tenant_id: string;
    }>(
      [
        'SELECT',
        '  u.id AS user_id,',
        '  t.id AS tenant_id',
        'FROM app_users u',
        'JOIN tenant_memberships m',
        '  ON m.user_id = u.id',
        'JOIN tenants t',
        '  ON t.id = m.tenant_id',
        'JOIN tenant_onboarding_profiles p',
        '  ON p.tenant_id = t.id',
        'WHERE lower(u.email) = lower($1)',
        '  AND p.company_name = $2',
        "  AND m.role = 'OWNER'",
      ].join('\n'),
      [email, SMOKE_COMPANY],
    );

  if (found.rows.length > 1) {
    throw new Error(
      'launch01_cleanup_guard_multiple_accounts',
    );
  }

  const row = found.rows[0];

  if (!row) {
    return 'NOTHING_TO_REMOVE';
  }

  const client =
    await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM app_users WHERE id = $1',
      [row.user_id],
    );

    await client.query(
      'DELETE FROM tenants WHERE id = $1',
      [row.tenant_id],
    );

    await client.query(
      [
        'DELETE FROM public_signup_rate_limits',
        'WHERE key_hash = $1',
      ].join('\n'),
      [rateKey(email)],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return 'PASS';
}

async function run(): Promise<void> {
  if (!executeRequested()) {
    throw new Error(
      'LAUNCH-01 production smoke requires --execute.',
    );
  }

  const email =
    'launch01-smoke-' +
    Date.now().toString(36) +
    '-' +
    randomBytes(4).toString('hex') +
    SMOKE_EMAIL_SUFFIX;

  const password =
    'Smoke-' +
    randomBytes(12).toString('hex') +
    '-Aa1!';

  const cnpj = validCnpj(
    String(Date.now()).slice(-12),
  );

  const summary: SmokeSummary = {};

  const pool = new Pool({
    connectionString:
      env.DATABASE_ADMIN_URL,
    max: 1,
    idleTimeoutMillis:
      env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      env.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    const home = await fetch(
      baseUrl + '/',
    );
    await expectStatus(
      summary,
      'home',
      home,
      200,
    );

    const register = await fetch(
      baseUrl + '/auth/register',
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          name:
            'LAUNCH01 Smoke User',
          email,
          company: SMOKE_COMPANY,
          password,
          confirmPassword: password,
          acceptedTerms: true,
        }),
      },
    );

    await expectStatus(
      summary,
      'register',
      register,
      201,
    );

    const login = await fetch(
      baseUrl + '/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
        }),
      },
    );

    await expectStatus(
      summary,
      'login',
      login,
      200,
    );

    const cookie = cookiesFrom(login);
    const loginBody =
      (await login.json()) as {
        accessToken?: unknown;
      };

    if (
      typeof loginBody.accessToken !==
        'string' ||
      !loginBody.accessToken ||
      !cookie
    ) {
      throw new Error(
        'login_contract_invalid',
      );
    }

    const authHeaders = {
      authorization:
        'Bearer ' +
        loginBody.accessToken,
      cookie,
      accept: 'application/json',
    };

    const me = await fetch(
      baseUrl + '/auth/me',
      {
        headers: authHeaders,
      },
    );

    await expectStatus(
      summary,
      'me',
      me,
      200,
    );

    const meBody =
      (await me.json()) as {
        user?: {
          email?: unknown;
        };
        memberships?: Array<{
          tenantId?: unknown;
          role?: unknown;
        }>;
      };

    const membership =
      meBody.memberships?.[0];

    if (
      String(
        meBody.user?.email ?? '',
      ).toLowerCase() !==
        email.toLowerCase() ||
      membership?.role !== 'OWNER' ||
      typeof membership.tenantId !==
        'string'
    ) {
      throw new Error(
        'me_contract_invalid',
      );
    }

    const tenantId =
      membership.tenantId;

    const tenantHeaders = {
      ...authHeaders,
      'x-tenant-id': tenantId,
    };

    const accountBefore = await fetch(
      baseUrl + '/api/v1/account',
      {
        headers: tenantHeaders,
      },
    );

    await expectStatus(
      summary,
      'accountBefore',
      accountBefore,
      200,
    );

    const company = await fetch(
      baseUrl + '/api/v1/companies',
      {
        method: 'POST',
        headers: {
          ...tenantHeaders,
          'content-type':
            'application/json',
        },
        body: JSON.stringify({
          legalName:
            'LAUNCH01 Smoke Company Ltda',
          tradeName:
            'LAUNCH01 Smoke',
          cnpj,
        }),
      },
    );

    await expectStatus(
      summary,
      'company',
      company,
      201,
    );

    const companyBody =
      (await company.json()) as {
        company?: {
          id?: unknown;
        };
      };

    if (
      typeof companyBody.company?.id !==
        'string'
    ) {
      throw new Error(
        'company_contract_invalid',
      );
    }

    const companyId =
      companyBody.company.id;

    const establishment =
      await fetch(
        baseUrl +
          '/api/v1/establishments',
        {
          method: 'POST',
          headers: {
            ...tenantHeaders,
            'content-type':
              'application/json',
          },
          body: JSON.stringify({
            companyId,
            cnpj,
            name:
              'Matriz Smoke Goiânia',
            typeCode:
              'HEAD_OFFICE',
            isHeadOffice: true,
            uf: 'GO',
            municipalityName:
              'Goiânia',
          }),
        },
      );

    await expectStatus(
      summary,
      'establishment',
      establishment,
      201,
    );

    const profileWrite =
      await fetch(
        baseUrl +
          '/api/v1/companies/' +
          companyId +
          '/tax-profile',
        {
          method: 'PUT',
          headers: {
            ...tenantHeaders,
            'content-type':
              'application/json',
          },
          body: JSON.stringify({
            taxRegime:
              'LUCRO_REAL',
            segments: [
              'Agronegócio',
            ],
            activities: [
              'Venda de insumos',
            ],
            personalization: {
              taxes: [
                'ICMS',
                'IBS',
                'CBS',
              ],
              products: [
                'Fertilizantes',
              ],
              operations: [
                'Venda interestadual',
              ],
              documents: ['NF-e'],
              obligations: ['EFD'],
              keywords: [
                'crédito presumido',
              ],
            },
          }),
        },
      );

    await expectStatus(
      summary,
      'profileWrite',
      profileWrite,
      200,
    );

    const profileRead =
      await fetch(
        baseUrl +
          '/api/v1/companies/' +
          companyId +
          '/tax-profile',
        {
          headers: tenantHeaders,
        },
      );

    await expectStatus(
      summary,
      'profileRead',
      profileRead,
      200,
    );

    const accountAfter = await fetch(
      baseUrl + '/api/v1/account',
      {
        headers: tenantHeaders,
      },
    );

    await expectStatus(
      summary,
      'accountAfter',
      accountAfter,
      200,
    );

    const stats = await fetch(
      apiBaseUrl + '/public/v1/stats',
    );
    await expectStatus(
      summary,
      'stats',
      stats,
      200,
    );

    const sources = await fetch(
      apiBaseUrl + '/public/v1/sources',
    );
    await expectStatus(
      summary,
      'sources',
      sources,
      200,
    );

    const archive = await fetch(
      baseUrl +
        '/api/v1/archive?page=1&limit=5',
      {
        headers: authHeaders,
      },
    );

    await expectStatus(
      summary,
      'archive',
      archive,
      200,
    );

    const logout = await fetch(
      baseUrl + '/auth/logout',
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-csrf-protection': '1',
        },
      },
    );

    await expectStatus(
      summary,
      'logout',
      logout,
      204,
    );

    summary.result = 'PASS';
  } finally {
    try {
      summary.cleanup =
        await cleanup(
          pool,
          email,
        );
    } finally {
      await pool.end();
    }
  }

  console.log(
    'LAUNCH01_SMOKE_SUMMARY=' +
      JSON.stringify(summary),
  );
}

run().catch((error: unknown) => {
  console.error(
    'LAUNCH-01 production smoke failed.',
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
        }
      : {
          name: 'UnknownError',
        },
  );
  process.exit(1);
});
