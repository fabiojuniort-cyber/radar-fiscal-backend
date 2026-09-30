import {
  createHash,
  randomBytes,
} from 'node:crypto';

import { Pool } from 'pg';
import { z } from 'zod';

const smokeEnvSchema = z.object({
  AUTH02_SMOKE_BASE_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('https://'),
      'AUTH02_SMOKE_BASE_URL must use HTTPS.',
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

const parsedSmokeEnv =
  smokeEnvSchema.safeParse(process.env);

if (!parsedSmokeEnv.success) {
  throw new Error(
    'AUTH-02 smoke configuration is invalid.',
  );
}

const smokeEnv = parsedSmokeEnv.data;

const baseUrl =
  smokeEnv.AUTH02_SMOKE_BASE_URL
    .replace(/\/$/, '');

const SMOKE_COMPANY = 'AUTH02 Smoke Test';
const SMOKE_EMAIL_SUFFIX = '@example.invalid';

interface SmokeSummary {
  home?: number;
  terms?: number;
  privacy?: number;
  register?: number;
  login1?: number;
  me1?: number;
  role?: 'OWNER';
  refresh?: number;
  logout?: number;
  revokedMe?: number;
  login2?: number;
  cleanup?: 'PASS' | 'NOTHING_TO_REMOVE';
  result?: 'PASS';
}

function executeRequested(): boolean {
  return process.argv.includes('--execute');
}

function cookiesFrom(
  response: Response,
): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  const values =
    typeof headers.getSetCookie === 'function'
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
  label: keyof SmokeSummary,
  response: Response,
  expected: number,
): Promise<void> {
  if (
    label === 'role' ||
    label === 'cleanup' ||
    label === 'result'
  ) {
    throw new Error(
      'invalid_smoke_status_label',
    );
  }

  summary[label] = response.status;

  if (response.status !== expected) {
    let errorCode = 'unreadable';

    try {
      const payload =
        (await response.clone().json()) as {
          error?: unknown;
        };

      if (
        typeof payload.error === 'string'
      ) {
        errorCode = payload.error;
      }
    } catch {
      // Intentionally avoid logging response bodies.
    }

    throw new Error(
      `${String(label)}_expected_${expected}_got_${response.status}_${errorCode}`,
    );
  }
}

function rateKey(email: string): string {
  return createHash('sha256')
    .update(
      email.trim().toLowerCase(),
      'utf8',
    )
    .digest('hex');
}

async function cleanupSmokeAccount(
  pool: Pool,
  email: string,
): Promise<
  'PASS' | 'NOTHING_TO_REMOVE'
> {
  const found = await pool.query<{
    user_id: string;
    tenant_id: string;
  }>(
    `
      SELECT
        u.id AS user_id,
        t.id AS tenant_id
      FROM app_users u
      JOIN tenant_memberships m
        ON m.user_id = u.id
      JOIN tenants t
        ON t.id = m.tenant_id
      JOIN tenant_onboarding_profiles p
        ON p.tenant_id = t.id
      WHERE lower(u.email) = lower($1)
        AND p.company_name = $2
        AND m.role = 'OWNER'
    `,
    [email, SMOKE_COMPANY],
  );

  if (found.rows.length > 1) {
    throw new Error(
      'auth02_smoke_cleanup_guard_multiple_accounts',
    );
  }

  if (found.rows.length === 0) {
    return 'NOTHING_TO_REMOVE';
  }

  const row = found.rows[0];

  if (!row) {
    return 'NOTHING_TO_REMOVE';
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `
        DELETE FROM app_users
        WHERE id = $1
      `,
      [row.user_id],
    );

    await client.query(
      `
        DELETE FROM tenants
        WHERE id = $1
      `,
      [row.tenant_id],
    );

    await client.query(
      `
        DELETE
        FROM public_signup_rate_limits
        WHERE key_hash = $1
      `,
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
      'AUTH-02 production smoke requires --execute.',
    );
  }

  const email =
    `auth02-smoke-${
      Date.now().toString(36)
    }-${
      randomBytes(4).toString('hex')
    }${SMOKE_EMAIL_SUFFIX}`;

  const password =
    `Smoke-${
      randomBytes(12).toString('hex')
    }-Aa1!`;

  const summary: SmokeSummary = {};

  const pool = new Pool({
    connectionString:
      smokeEnv.DATABASE_ADMIN_URL,
    max: 1,
    idleTimeoutMillis:
      smokeEnv.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      smokeEnv.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    const home = await fetch(
      `${baseUrl}/`,
    );
    await expectStatus(
      summary,
      'home',
      home,
      200,
    );

    const terms = await fetch(
      `${baseUrl}/termos-de-uso`,
    );
    await expectStatus(
      summary,
      'terms',
      terms,
      200,
    );

    if (
      !(
        await terms.text()
      )
        .toLowerCase()
        .includes('termos')
    ) {
      throw new Error(
        'terms_content_missing',
      );
    }

    const privacy = await fetch(
      `${baseUrl}/politica-de-privacidade`,
    );
    await expectStatus(
      summary,
      'privacy',
      privacy,
      200,
    );

    if (
      !(
        await privacy.text()
      )
        .toLowerCase()
        .includes('privacidade')
    ) {
      throw new Error(
        'privacy_content_missing',
      );
    }

    const register = await fetch(
      `${baseUrl}/auth/register`,
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          name: 'AUTH02 Smoke User',
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

    const registered =
      (await register.json()) as {
        membership?: {
          role?: unknown;
        };
        next?: unknown;
      };

    if (
      registered.membership?.role !==
        'OWNER' ||
      registered.next !== 'LOGIN'
    ) {
      throw new Error(
        'register_contract_invalid',
      );
    }

    const loginPayload =
      JSON.stringify({
        email,
        password,
      });

    const login1 = await fetch(
      `${baseUrl}/auth/login`,
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
        },
        body: loginPayload,
      },
    );

    await expectStatus(
      summary,
      'login1',
      login1,
      200,
    );

    const cookie1 =
      cookiesFrom(login1);
    const loginBody1 =
      (await login1.json()) as {
        accessToken?: unknown;
      };

    if (
      typeof loginBody1.accessToken !==
        'string' ||
      loginBody1.accessToken.length ===
        0 ||
      !cookie1
    ) {
      throw new Error(
        'login1_contract_invalid',
      );
    }

    const me1 = await fetch(
      `${baseUrl}/auth/me`,
      {
        headers: {
          authorization:
            `Bearer ${
              loginBody1.accessToken
            }`,
          cookie: cookie1,
        },
      },
    );

    await expectStatus(
      summary,
      'me1',
      me1,
      200,
    );

    const identity =
      (await me1.json()) as {
        user?: {
          email?: unknown;
        };
        memberships?: Array<{
          role?: unknown;
        }>;
      };

    if (
      String(
        identity.user?.email ?? '',
      ).toLowerCase() !==
        email.toLowerCase() ||
      identity.memberships?.length !==
        1 ||
      identity.memberships[0]?.role !==
        'OWNER'
    ) {
      throw new Error(
        'me_identity_invalid',
      );
    }

    summary.role = 'OWNER';

    const refresh = await fetch(
      `${baseUrl}/auth/refresh`,
      {
        method: 'POST',
        headers: {
          'x-csrf-protection': '1',
          cookie: cookie1,
        },
      },
    );

    await expectStatus(
      summary,
      'refresh',
      refresh,
      200,
    );

    const cookie2 =
      cookiesFrom(refresh);
    const refreshBody =
      (await refresh.json()) as {
        accessToken?: unknown;
      };

    if (
      typeof refreshBody.accessToken !==
        'string' ||
      refreshBody.accessToken.length ===
        0 ||
      !cookie2
    ) {
      throw new Error(
        'refresh_contract_invalid',
      );
    }

    const logout = await fetch(
      `${baseUrl}/auth/logout`,
      {
        method: 'POST',
        headers: {
          'x-csrf-protection': '1',
          authorization:
            `Bearer ${
              refreshBody.accessToken
            }`,
          cookie: cookie2,
        },
      },
    );

    await expectStatus(
      summary,
      'logout',
      logout,
      204,
    );

    const revokedMe = await fetch(
      `${baseUrl}/auth/me`,
      {
        headers: {
          authorization:
            `Bearer ${
              refreshBody.accessToken
            }`,
          cookie: cookie2,
        },
      },
    );

    await expectStatus(
      summary,
      'revokedMe',
      revokedMe,
      401,
    );

    const login2 = await fetch(
      `${baseUrl}/auth/login`,
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
        },
        body: loginPayload,
      },
    );

    await expectStatus(
      summary,
      'login2',
      login2,
      200,
    );

    summary.result = 'PASS';
  } finally {
    try {
      summary.cleanup =
        await cleanupSmokeAccount(
          pool,
          email,
        );
    } finally {
      await pool.end();
    }
  }

  console.log(
    `AUTH02_SMOKE_SUMMARY=${
      JSON.stringify(summary)
    }`,
  );
}

run().catch((error: unknown) => {
  console.error(
    'AUTH-02 production smoke failed.',
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
