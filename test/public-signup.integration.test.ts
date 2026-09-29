import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import {
  verifyPassword,
} from '../src/modules/auth/auth.service.js';

const PASSWORD = 'Cadastro-Seguro-2026!';
const CSRF_HEADERS = {
  'x-csrf-protection': '1',
};

function signupPayload(
  email: string,
  cnpj = '',
) {
  return {
    name: 'Pessoa Cadastro',
    email,
    company: 'Empresa Cadastro',
    cnpj,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    acceptedTerms: true,
  };
}

async function register(
  app: FastifyInstance,
  email: string,
  cnpj = '',
) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: signupPayload(email, cnpj),
  });
}

async function login(
  app: FastifyInstance,
  email: string,
) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email,
      password: PASSWORD,
    },
  });
}

function normalizedRateHash(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

test(
  'public signup creates an isolated OWNER account and preserves the existing auth flow',
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
    const app = await buildApp();
    const tenantIds: string[] = [];
    const userIds: string[] = [];
    const rateHashes: string[] = [];

    try {
      await app.ready();

      await t.test(
        'creates tenant, user, Argon2id credential, OWNER membership and onboarding profile atomically',
        async () => {
          const unique = randomUUID();
          const email =
            `  Owner.${unique}@Example.Test  `;

          rateHashes.push(
            normalizedRateHash(email),
          );

          const response = await register(
            app,
            email,
            '12.345.678/0001-95',
          );

          assert.equal(
            response.statusCode,
            201,
          );

          const body = response.json<{
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
              role: string;
            };
            next: string;
          }>();

          tenantIds.push(body.tenant.id);
          userIds.push(body.user.id);

          assert.equal(
            body.user.email,
            email.trim().toLowerCase(),
          );
          assert.equal(
            body.user.name,
            'Pessoa Cadastro',
          );
          assert.equal(
            body.tenant.name,
            'Empresa Cadastro',
          );
          assert.equal(
            body.membership.role,
            'OWNER',
          );
          assert.equal(body.next, 'LOGIN');

          const serialized =
            JSON.stringify(body);

          assert.ok(
            !serialized.includes(PASSWORD),
          );
          assert.ok(
            !('accessToken' in body),
          );
          assert.equal(
            response.headers['set-cookie'],
            undefined,
          );

          const persisted =
            await admin.query<{
              email: string;
              password_hash: string;
              role: string;
              tenant_name: string;
              cnpj: string | null;
              terms_accepted_at: Date;
              privacy_policy_accepted_at: Date;
              consent_version: string;
            }>(
              `
                SELECT
                  u.email,
                  c.password_hash,
                  m.role,
                  t.name AS tenant_name,
                  p.cnpj,
                  p.terms_accepted_at,
                  p.privacy_policy_accepted_at,
                  p.consent_version
                FROM app_users u
                JOIN user_credentials c
                  ON c.user_id = u.id
                JOIN tenant_memberships m
                  ON m.user_id = u.id
                JOIN tenants t
                  ON t.id = m.tenant_id
                JOIN tenant_onboarding_profiles p
                  ON p.tenant_id = t.id
                WHERE u.id = $1
              `,
              [body.user.id],
            );

          assert.equal(
            persisted.rowCount,
            1,
          );

          const row = persisted.rows[0];
          assert.ok(row);
          assert.equal(
            row.email,
            body.user.email,
          );
          assert.equal(row.role, 'OWNER');
          assert.equal(
            row.tenant_name,
            'Empresa Cadastro',
          );
          assert.equal(
            row.cnpj,
            '12345678000195',
          );
          assert.ok(
            row.terms_accepted_at,
          );
          assert.ok(
            row.privacy_policy_accepted_at,
          );
          assert.equal(
            row.consent_version,
            '2026-09-29-v1',
          );
          assert.match(
            row.password_hash,
            /^\$argon2id\$/,
          );
          assert.ok(
            !row.password_hash.includes(
              PASSWORD,
            ),
          );
          assert.equal(
            await verifyPassword(
              row.password_hash,
              PASSWORD,
            ),
            true,
          );

          const session = await login(
            app,
            body.user.email,
          );

          assert.equal(
            session.statusCode,
            200,
          );

          const loginBody =
            session.json<{
              accessToken: string;
            }>();

          const me = await app.inject({
            method: 'GET',
            url: '/auth/me',
            headers: {
              authorization:
                `Bearer ${loginBody.accessToken}`,
            },
          });

          assert.equal(me.statusCode, 200);

          const identity = me.json<{
            user: {
              id: string;
              email: string;
            };
            memberships: Array<{
              tenantId: string;
              role: string;
            }>;
          }>();

          assert.equal(
            identity.user.id,
            body.user.id,
          );
          assert.deepEqual(
            identity.memberships,
            [
              {
                tenantId:
                  body.tenant.id,
                role: 'OWNER',
                tenantName:
                  'Empresa Cadastro',
                tenantSlug:
                  body.tenant.slug,
              },
            ],
          );

          const setCookie =
            session.headers['set-cookie'];

          assert.ok(setCookie);

          const cookie = (
            Array.isArray(setCookie)
              ? setCookie[0]
              : setCookie
          )!.split(';', 1)[0]!;

          const logout =
            await app.inject({
              method: 'POST',
              url: '/auth/logout',
              headers: {
                ...CSRF_HEADERS,
                authorization:
                  `Bearer ${loginBody.accessToken}`,
                cookie,
              },
            });

          assert.equal(
            logout.statusCode,
            204,
          );

          const afterLogout =
            await app.inject({
              method: 'GET',
              url: '/auth/me',
              headers: {
                authorization:
                  `Bearer ${loginBody.accessToken}`,
              },
            });

          assert.equal(
            afterLogout.statusCode,
            401,
          );

          const laterLogin = await login(
            app,
            body.user.email,
          );

          assert.equal(
            laterLogin.statusCode,
            200,
          );

          const duplicate =
            await register(
              app,
              body.user.email.toUpperCase(),
            );

          assert.equal(
            duplicate.statusCode,
            409,
          );
          assert.deepEqual(
            duplicate.json(),
            {
              error:
                'email_already_registered',
            },
          );

          const counts =
            await admin.query<{
              users: string;
              memberships: string;
            }>(
              `
                SELECT
                  (
                    SELECT count(*)
                    FROM app_users
                    WHERE lower(email) = $1
                  )::text AS users,
                  (
                    SELECT count(*)
                    FROM tenant_memberships m
                    JOIN app_users u
                      ON u.id = m.user_id
                    WHERE lower(u.email) = $1
                  )::text AS memberships
              `,
              [body.user.email],
            );

          assert.equal(
            counts.rows[0]?.users,
            '1',
          );
          assert.equal(
            counts.rows[0]?.memberships,
            '1',
          );
        },
      );

      await t.test(
        'invalid password, consent and CNPJ create nothing',
        async () => {
          const cases = [
            {
              email:
                `weak-${randomUUID()}@example.test`,
              patch: {
                password: 'weak',
                confirmPassword: 'weak',
              },
              expected:
                'invalid_password',
            },
            {
              email:
                `terms-${randomUUID()}@example.test`,
              patch: {
                acceptedTerms: false,
              },
              expected:
                'invalid_signup_data',
            },
            {
              email:
                `cnpj-${randomUUID()}@example.test`,
              patch: {
                cnpj: 'ABC-123',
              },
              expected:
                'invalid_signup_data',
            },
          ];

          for (const current of cases) {
            const response =
              await app.inject({
                method: 'POST',
                url: '/auth/register',
                payload: {
                  ...signupPayload(
                    current.email,
                  ),
                  ...current.patch,
                },
              });

            assert.equal(
              response.statusCode,
              400,
            );
            assert.deepEqual(
              response.json(),
              { error: current.expected },
            );

            const stored =
              await admin.query(
                `
                  SELECT 1
                  FROM app_users
                  WHERE lower(email) = $1
                `,
                [
                  current.email
                    .trim()
                    .toLowerCase(),
                ],
              );

            assert.equal(
              stored.rowCount,
              0,
            );
          }
        },
      );

      await t.test(
        'concurrent duplicate registration creates exactly one account',
        async () => {
          const email =
            `race-${randomUUID()}@example.test`;

          rateHashes.push(
            normalizedRateHash(email),
          );

          const responses =
            await Promise.all([
              register(app, email),
              register(
                app,
                email.toUpperCase(),
              ),
            ]);

          const statuses =
            responses
              .map(
                (response) =>
                  response.statusCode,
              )
              .sort();

          assert.deepEqual(
            statuses,
            [201, 409],
          );

          const winner =
            responses.find(
              (response) =>
                response.statusCode === 201,
            );

          assert.ok(winner);

          const body =
            winner.json<{
              user: { id: string };
              tenant: { id: string };
            }>();

          userIds.push(body.user.id);
          tenantIds.push(body.tenant.id);

          const result =
            await admin.query<{
              users: string;
              tenants: string;
              memberships: string;
            }>(
              `
                SELECT
                  (
                    SELECT count(*)
                    FROM app_users
                    WHERE lower(email) = $1
                  )::text AS users,
                  (
                    SELECT count(DISTINCT m.tenant_id)
                    FROM tenant_memberships m
                    JOIN app_users u
                      ON u.id = m.user_id
                    WHERE lower(u.email) = $1
                  )::text AS tenants,
                  (
                    SELECT count(*)
                    FROM tenant_memberships m
                    JOIN app_users u
                      ON u.id = m.user_id
                    WHERE lower(u.email) = $1
                  )::text AS memberships
              `,
              [email.toLowerCase()],
            );

          assert.deepEqual(
            result.rows[0],
            {
              users: '1',
              tenants: '1',
              memberships: '1',
            },
          );
        },
      );

      await t.test(
        'duplicate company CNPJ cannot create a second tenant OWNER account',
        async () => {
          const firstEmail =
            `company-a-${randomUUID()}@example.test`;
          const secondEmail =
            `company-b-${randomUUID()}@example.test`;

          rateHashes.push(
            normalizedRateHash(firstEmail),
            normalizedRateHash(secondEmail),
          );

          const first =
            await register(
              app,
              firstEmail,
              '11.222.333/0001-81',
            );

          assert.equal(first.statusCode, 201);

          const firstBody =
            first.json<{
              user: { id: string };
              tenant: { id: string };
            }>();

          userIds.push(firstBody.user.id);
          tenantIds.push(firstBody.tenant.id);

          const second =
            await register(
              app,
              secondEmail,
              '11.222.333/0001-81',
            );

          assert.equal(second.statusCode, 409);
          assert.deepEqual(second.json(), {
            error: 'company_already_registered',
          });

          const secondUser =
            await admin.query(
              `
                SELECT 1
                FROM app_users
                WHERE lower(email) = $1
              `,
              [secondEmail.toLowerCase()],
            );

          assert.equal(secondUser.rowCount, 0);

          const tenantsForCnpj =
            await admin.query<{
              total: string;
            }>(
              `
                SELECT count(*)::text AS total
                FROM tenant_onboarding_profiles
                WHERE cnpj = '11222333000181'
              `,
            );

          assert.equal(
            tenantsForCnpj.rows[0]?.total,
            '1',
          );
        },
      );

      await t.test(
        'persistent antiabuse limit blocks the sixth attempt for the same normalized email',
        async () => {
          const email =
            `limit-${randomUUID()}@example.test`;

          rateHashes.push(
            normalizedRateHash(email),
          );

          const first =
            await register(app, email);

          assert.equal(
            first.statusCode,
            201,
          );

          const body =
            first.json<{
              user: { id: string };
              tenant: { id: string };
            }>();

          userIds.push(body.user.id);
          tenantIds.push(body.tenant.id);

          for (let attempt = 2;
            attempt <= 5;
            attempt += 1) {
            const duplicate =
              await register(app, email);

            assert.equal(
              duplicate.statusCode,
              409,
            );
          }

          const limited =
            await register(app, email);

          assert.equal(
            limited.statusCode,
            429,
          );
          assert.deepEqual(
            limited.json(),
            {
              error:
                'too_many_requests',
            },
          );
          assert.ok(
            Number(
              limited.headers[
                'retry-after'
              ],
            ) >= 1,
          );
        },
      );
    } finally {
      await app.close();

      if (userIds.length > 0) {
        await admin.query(
          `
            DELETE FROM app_users
            WHERE id = ANY($1::uuid[])
          `,
          [userIds],
        );
      }

      if (tenantIds.length > 0) {
        await admin.query(
          `
            DELETE FROM tenants
            WHERE id = ANY($1::uuid[])
          `,
          [tenantIds],
        );
      }

      if (rateHashes.length > 0) {
        await admin.query(
          `
            DELETE
            FROM public_signup_rate_limits
            WHERE key_hash = ANY($1::text[])
          `,
          [rateHashes],
        );
      }

      await admin.end();
    }
  },
);
