import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import {
  TenantAccessDeniedError,
  withTenantContext,
} from '../src/infrastructure/database/tenant-context.js';
import {
  hashPassword,
} from '../src/modules/auth/auth.service.js';
import {
  withRequestTenantContext,
} from '../src/modules/auth/tenant-request.js';

const PASSWORD = 'Radar-Fiscal-Test-Password-2026!';
const CSRF_HEADERS = {
  'x-csrf-protection': '1',
};

interface LoginResult {
  accessToken: string;
  refreshCookie: string;
}

interface AccessPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

function cookiePair(
  setCookieHeader: string | string[] | undefined,
): string {
  const raw = Array.isArray(setCookieHeader)
    ? setCookieHeader[0]
    : setCookieHeader;

  assert.ok(raw, 'Expected Set-Cookie response header.');

  return raw.split(';', 1)[0]!;
}

function accessPayload(
  app: FastifyInstance,
  accessToken: string,
): AccessPayload {
  const decoded = app.jwt.decode(accessToken);

  assert.ok(
    decoded &&
      typeof decoded === 'object' &&
      'sub' in decoded &&
      'sid' in decoded,
    'Expected decodable access token.',
  );

  const payload = decoded as Record<string, unknown>;

  assert.equal(typeof payload.sub, 'string');
  assert.equal(typeof payload.sid, 'string');
  assert.equal(payload.typ, 'access');

  return {
    sub: payload.sub,
    sid: payload.sid,
    typ: 'access',
  };
}

async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<LoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email,
      password,
    },
  });

  assert.equal(response.statusCode, 200);

  const body = response.json<{
    accessToken: string;
  }>();

  assert.equal(typeof body.accessToken, 'string');

  return {
    accessToken: body.accessToken,
    refreshCookie: cookiePair(
      response.headers['set-cookie'],
    ),
  };
}

async function getMe(
  app: FastifyInstance,
  accessToken: string,
) {
  return app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
}

test(
  'authentication, session rotation, tenant isolation and RLS',
  async (t) => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for integration tests.',
    );

    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });

    const tenantAId = randomUUID();
    const tenantBId = randomUUID();
    const userAId = randomUUID();
    const userBId = randomUUID();
    const companyAId = randomUUID();
    const companyBId = randomUUID();

    const app = await buildApp();

    try {
      const passwordHash = await hashPassword(PASSWORD);

      await admin.query(
        `
          INSERT INTO tenants (id, name, slug, status)
          VALUES
            ($1, 'Tenant A Test', $2, 'ACTIVE'),
            ($3, 'Tenant B Test', $4, 'ACTIVE')
        `,
        [
          tenantAId,
          `tenant-a-test-${tenantAId}`,
          tenantBId,
          `tenant-b-test-${tenantBId}`,
        ],
      );

      await admin.query(
        `
          INSERT INTO app_users (id, email, name, status)
          VALUES
            ($1, 'User.A@Example.Test', 'User A', 'ACTIVE'),
            ($2, 'user.b@example.test', 'User B', 'ACTIVE')
        `,
        [userAId, userBId],
      );

      await admin.query(
        `
          INSERT INTO user_credentials (
            user_id,
            password_hash,
            password_algorithm
          )
          VALUES
            ($1, $3, 'argon2id'),
            ($2, $3, 'argon2id')
        `,
        [userAId, userBId, passwordHash],
      );

      await admin.query(
        `
          INSERT INTO tenant_memberships (
            tenant_id,
            user_id,
            role
          )
          VALUES
            ($1, $2, 'OWNER'),
            ($3, $4, 'OWNER')
        `,
        [tenantAId, userAId, tenantBId, userBId],
      );

      await admin.query(
        `
          INSERT INTO companies (
            id,
            tenant_id,
            legal_name,
            head_office_cnpj
          )
          VALUES
            ($1, $2, 'Company A Test', '10000000000001'),
            ($3, $4, 'Company B Test', '20000000000002')
        `,
        [companyAId, tenantAId, companyBId, tenantBId],
      );

      await app.ready();

      await t.test(
        'correct password authenticates and email lookup is case-insensitive',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          assert.ok(session.accessToken);
          assert.ok(session.refreshCookie);
        },
      );

      await t.test(
        'wrong password is rejected',
        async () => {
          const response = await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: {
              email: 'user.a@example.test',
              password: 'wrong-password',
            },
          });

          assert.equal(response.statusCode, 401);
          assert.deepEqual(response.json(), {
            error: 'invalid_credentials',
          });
        },
      );

      await t.test(
        'valid access token works and lists only authorized active tenants',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const me = await getMe(
            app,
            session.accessToken,
          );

          assert.equal(me.statusCode, 200);

          const tenants = await app.inject({
            method: 'GET',
            url: '/auth/tenants',
            headers: {
              authorization:
                `Bearer ${session.accessToken}`,
            },
          });

          assert.equal(tenants.statusCode, 200);

          const body = tenants.json<{
            tenants: Array<{
              tenantId: string;
            }>;
          }>();

          assert.deepEqual(
            body.tenants.map(
              (tenant) => tenant.tenantId,
            ),
            [tenantAId],
          );
        },
      );

      await t.test(
        'expired access token is rejected',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const payload = accessPayload(
            app,
            session.accessToken,
          );

          const expiredToken = app.jwt.sign(
            {
              sub: payload.sub,
              sid: payload.sid,
              typ: 'access',
            },
            {
              expiresIn: -1,
            },
          );

          const response = await getMe(
            app,
            expiredToken,
          );

          assert.equal(response.statusCode, 401);
        },
      );

      await t.test(
        'refresh requires CSRF header, renews access, rotates token and detects reuse',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const csrfRejected = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            headers: {
              cookie: session.refreshCookie,
            },
          });

          assert.equal(csrfRejected.statusCode, 403);

          const refreshed = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            headers: {
              ...CSRF_HEADERS,
              cookie: session.refreshCookie,
            },
          });

          assert.equal(refreshed.statusCode, 200);

          const refreshedBody = refreshed.json<{
            accessToken: string;
          }>();

          const rotatedCookie = cookiePair(
            refreshed.headers['set-cookie'],
          );

          assert.notEqual(
            rotatedCookie,
            session.refreshCookie,
          );

          const me = await getMe(
            app,
            refreshedBody.accessToken,
          );

          assert.equal(me.statusCode, 200);

          const reused = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            headers: {
              ...CSRF_HEADERS,
              cookie: session.refreshCookie,
            },
          });

          assert.equal(reused.statusCode, 401);

          const afterReuse = await getMe(
            app,
            refreshedBody.accessToken,
          );

          assert.equal(afterReuse.statusCode, 401);

          const payload = accessPayload(
            app,
            refreshedBody.accessToken,
          );

          const reuseResult = await admin.query<{
            reuse_detected_at: Date | null;
          }>(
            `
              SELECT reuse_detected_at
              FROM auth_refresh_tokens
              WHERE session_id = $1
                AND reuse_detected_at IS NOT NULL
            `,
            [payload.sid],
          );

          assert.equal(reuseResult.rowCount, 1);
          assert.ok(
            reuseResult.rows[0]?.reuse_detected_at,
          );
        },
      );

      await t.test(
        'logout requires CSRF header and invalidates the server session',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const rejected = await app.inject({
            method: 'POST',
            url: '/auth/logout',
            headers: {
              authorization:
                `Bearer ${session.accessToken}`,
            },
          });

          assert.equal(rejected.statusCode, 403);

          const stillValid = await getMe(
            app,
            session.accessToken,
          );

          assert.equal(stillValid.statusCode, 200);

          const logout = await app.inject({
            method: 'POST',
            url: '/auth/logout',
            headers: {
              ...CSRF_HEADERS,
              authorization:
                `Bearer ${session.accessToken}`,
            },
          });

          assert.equal(logout.statusCode, 204);

          const afterLogout = await getMe(
            app,
            session.accessToken,
          );

          assert.equal(afterLogout.statusCode, 401);
        },
      );

      await t.test(
        'idle session expiry is enforced',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const payload = accessPayload(
            app,
            session.accessToken,
          );

          await admin.query(
            `
              UPDATE auth_sessions
              SET idle_expires_at = now() - interval '1 second'
              WHERE id = $1
            `,
            [payload.sid],
          );

          const response = await getMe(
            app,
            session.accessToken,
          );

          assert.equal(response.statusCode, 401);

          const refresh = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            headers: {
              ...CSRF_HEADERS,
              cookie: session.refreshCookie,
            },
          });

          assert.equal(refresh.statusCode, 401);
        },
      );

      await t.test(
        'absolute session lifetime is enforced',
        async () => {
          const session = await login(
            app,
            'user.a@example.test',
          );

          const payload = accessPayload(
            app,
            session.accessToken,
          );

          await admin.query(
            `
              UPDATE auth_sessions
              SET
                idle_expires_at =
                  now() - interval '2 seconds',
                absolute_expires_at =
                  now() - interval '1 second'
              WHERE id = $1
            `,
            [payload.sid],
          );

          const response = await getMe(
            app,
            session.accessToken,
          );

          assert.equal(response.statusCode, 401);

          const refresh = await app.inject({
            method: 'POST',
            url: '/auth/refresh',
            headers: {
              ...CSRF_HEADERS,
              cookie: session.refreshCookie,
            },
          });

          assert.equal(refresh.statusCode, 401);
        },
      );

      await t.test(
        'user without membership cannot select another tenant',
        async () => {
          await assert.rejects(
            () =>
              withTenantContext(
                app.db,
                userAId,
                tenantBId,
                async () => true,
              ),
            TenantAccessDeniedError,
          );
        },
      );

      await t.test(
        'changing X-Tenant-Id manually grants nothing',
        async () => {
          const request = {
            auth: {
              userId: userAId,
              sessionId: randomUUID(),
            },
            headers: {
              'x-tenant-id': tenantBId,
            },
          } as FastifyRequest;

          await assert.rejects(
            () =>
              withRequestTenantContext(
                app.db,
                request,
                async () => true,
              ),
            TenantAccessDeniedError,
          );
        },
      );

      await t.test(
        'Tenant A context cannot read Tenant B data',
        async () => {
          const companies = await withTenantContext(
            app.db,
            userAId,
            tenantAId,
            async (trx) =>
              trx
                .selectFrom('companies')
                .select([
                  'id',
                  'tenant_id',
                ])
                .orderBy('id')
                .execute(),
          );

          assert.deepEqual(
            companies.map(
              (company) => company.id,
            ),
            [companyAId],
          );

          assert.equal(
            companies[0]?.tenant_id,
            tenantAId,
          );
        },
      );

      await t.test(
        'RLS blocks cross-tenant data even if application membership validation is bypassed',
        async () => {
          const rows = await app.db
            .transaction()
            .execute(async (trx) => {
              await sql`
                select set_config(
                  'app.user_id',
                  ${userAId},
                  true
                )
              `.execute(trx);

              await sql`
                select set_config(
                  'app.tenant_id',
                  ${tenantBId},
                  true
                )
              `.execute(trx);

              return trx
                .selectFrom('companies')
                .select([
                  'id',
                  'tenant_id',
                ])
                .execute();
            });

          assert.deepEqual(rows, []);
        },
      );

      await t.test(
        'transaction-local tenant context does not leak through the pool',
        async () => {
          await withTenantContext(
            app.db,
            userAId,
            tenantAId,
            async (trx) => {
              const rows = await trx
                .selectFrom('companies')
                .select('id')
                .execute();

              assert.deepEqual(
                rows.map((row) => row.id),
                [companyAId],
              );
            },
          );

          await app.db
            .transaction()
            .execute(async (trx) => {
              const settings = await sql<{
                user_id: string | null;
                tenant_id: string | null;
              }>`
                select
                  current_setting(
                    'app.user_id',
                    true
                  ) as user_id,
                  current_setting(
                    'app.tenant_id',
                    true
                  ) as tenant_id
              `.execute(trx);

              const current = settings.rows[0];

              assert.ok(
                current?.user_id === null ||
                  current?.user_id === '',
              );

              assert.ok(
                current?.tenant_id === null ||
                  current?.tenant_id === '',
              );

              const rows = await trx
                .selectFrom('companies')
                .select('id')
                .execute();

              assert.deepEqual(rows, []);
            });
        },
      );
    } finally {
      await app.close();

      await admin.query(
        `
          DELETE FROM app_users
          WHERE id = ANY($1::uuid[])
        `,
        [[userAId, userBId]],
      );

      await admin.query(
        `
          DELETE FROM tenants
          WHERE id = ANY($1::uuid[])
        `,
        [[tenantAId, tenantBId]],
      );

      await admin.end();
    }
  },
);
