import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');

const PASSWORD = 'Platform-Admin-Seguro-2026!';

async function registerAndLogin(
  app: FastifyInstance,
  label: string,
) {
  const email =
    `platform-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: `Platform ${label}`,
      email,
      company: `Platform ${label}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      acceptedTerms: true,
    },
  });
  assert.equal(register.statusCode, 201, register.body);
  const registered = register.json<{
    tenant: { id: string };
    user: { id: string };
  }>();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const { accessToken } =
    login.json<{ accessToken: string }>();

  return {
    userId: registered.user.id,
    tenantId: registered.tenant.id,
    email,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-tenant-id': registered.tenant.id,
    },
  };
}

test(
  'ACT-SCOPE-02 PLATFORM_ADMIN: exclusive access, audited grant/revoke and last-admin guard',
  async () => {
    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });
    const app = await buildApp();

    const createdUserIds: string[] = [];
    let originalDouConfig: unknown;
    let sourceFound = false;
    let seededDouSource = false;
    try {
      // db:prepare provisions schema/roles but does not seed the source catalog.
      // The integration fixture creates only the missing DOU source in CI.
      const existing = await admin.query<{ connector_config: unknown }>(
        "SELECT connector_config FROM public.sources WHERE code='dou' AND connector_key='dou'",
      );
      if (existing.rows.length === 0) {
        await admin.query(
          `INSERT INTO public.sources
             (code, name, jurisdiction_level, base_url, connector_key, connector_config)
           VALUES ('dou', 'DOU fixture', 'FEDERAL', 'https://inlabs.in.gov.br',
                   'dou', '{}'::jsonb)`,
        );
        seededDouSource = true;
      }
      const source = await admin.query<{ connector_config: unknown }>(
        "SELECT connector_config FROM public.sources WHERE code='dou' AND connector_key='dou'",
      );
      assert.equal(source.rows.length, 1, 'DOU source required');
      originalDouConfig = source.rows[0]!.connector_config;
      sourceFound = true;
      const first = await registerAndLogin(app, 'first');
      const second = await registerAndLogin(app, 'second');
      const curatorOnly = await registerAndLogin(
        app,
        'curator-only',
      );
      const customer = await registerAndLogin(
        app,
        'customer',
      );
      createdUserIds.push(
        first.userId,
        second.userId,
        curatorOnly.userId,
        customer.userId,
      );

      await admin.query(
        `INSERT INTO platform_user_roles (
           user_id, role, granted_by
         ) VALUES
           ($1, 'PLATFORM_ADMIN', 'act-scope-02-test'),
           ($2, 'TAXONOMY_CURATOR', 'act-scope-02-test')`,
        [first.userId, curatorOnly.userId],
      );

      const firstMe = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/me',
        headers: first.headers,
      });
      assert.equal(firstMe.statusCode, 200, firstMe.body);
      assert.equal(firstMe.json().platformAdmin, true);
      assert.equal(firstMe.json().licenseBypass, true);

      // OPS-DL-01: the production-style admin API must actually persist in SQL,
      // log the actor, reject tenant users and never grant direct table UPDATE.
      const limitsPath = '/api/v1/admin/platform/dou-download-limits';
      const initialLimits = await app.inject({
        method: 'GET', url: limitsPath, headers: first.headers,
      });
      assert.equal(initialLimits.statusCode, 200, initialLimits.body);
      assert.equal(initialLimits.json().editable, true,
        'SQL write gateway must exist and be executable by the app role');

      for (const method of ['GET', 'PUT'] as const) {
        const rejected = await app.inject({
          method, url: limitsPath, headers: customer.headers,
          ...(method === 'PUT' ? { payload: {
            pdfMiB: 20, zipMiB: 32, expandedZipMiB: 64, xmlEntryMiB: 8,
          } } : {}),
        });
        assert.equal(rejected.statusCode, 403, rejected.body);
      }

      const modified = { pdfMiB: 20, zipMiB: 32, expandedZipMiB: 64, xmlEntryMiB: 8 };
      const savedLimits = await app.inject({
        method: 'PUT', url: limitsPath, headers: first.headers, payload: modified,
      });
      assert.equal(savedLimits.statusCode, 200, savedLimits.body);
      assert.deepEqual(savedLimits.json().limits, modified);
      assert.equal(savedLimits.json().configured, true);
      const persistedLimits = await app.inject({
        method: 'GET', url: limitsPath, headers: first.headers,
      });
      assert.deepEqual(persistedLimits.json().limits, modified,
        'GET must re-read persisted source config instead of volatile memory');

      const priorAudit = await admin.query<{ id: string }>(
        `SELECT id FROM public.audit_log
         WHERE action='DOU_DOWNLOAD_LIMITS_UPDATED' AND actor_id=$1`,
        [first.userId],
      );
      assert.equal(priorAudit.rows.length, 1);
      const duplicate = await app.inject({
        method: 'PUT', url: limitsPath, headers: first.headers, payload: modified,
      });
      assert.equal(duplicate.statusCode, 200, duplicate.body);
      const noOpAudit = await admin.query<{ id: string }>(
        `SELECT id FROM public.audit_log
         WHERE action='DOU_DOWNLOAD_LIMITS_UPDATED' AND actor_id=$1`,
        [first.userId],
      );
      assert.equal(noOpAudit.rows.length, 1,
        'no-op must not emit a misleading modification event');

      const invalidLimits = await app.inject({
        method: 'PUT', url: limitsPath, headers: first.headers,
        payload: { ...modified, zipMiB: 65 },
      });
      assert.equal(invalidLimits.statusCode, 400, invalidLimits.body);

      const runtime = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      });
      try {
        await assert.rejects(
          runtime.query("UPDATE public.sources SET updated_at = now() WHERE code='dou'"),
          (err: unknown) => (err as { code?: string }).code === '42501',
          'app role must never update sources directly',
        );
      } finally { await runtime.end(); }

      const authMe = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: first.headers,
      });
      assert.equal(authMe.statusCode, 200, authMe.body);
      assert.deepEqual(authMe.json().platformAccess, {
        platformAdmin: true,
        taxonomyCurator: false,
        licenseBypass: true,
      });

      const customerDenied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/platform/administrators',
        headers: customer.headers,
      });
      assert.equal(customerDenied.statusCode, 403);

      const curatorTaxonomyDenied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/taxonomy/state',
        headers: curatorOnly.headers,
      });
      assert.equal(
        curatorTaxonomyDenied.statusCode,
        403,
        curatorTaxonomyDenied.body,
      );
      assert.equal(
        curatorTaxonomyDenied.json().error,
        'platform_admin_required',
      );

      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/platform/administrators',
        headers: first.headers,
      });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(listed.json().lastAdminProtection, true);
      assert.ok(
        listed
          .json()
          .items.some(
            (item: { userId: string }) =>
              item.userId === first.userId,
          ),
      );

      const granted = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/platform/administrators/grant',
        headers: first.headers,
        payload: { email: second.email },
      });
      assert.equal(granted.statusCode, 200, granted.body);
      assert.equal(granted.json().action, 'GRANTED');
      assert.equal(
        granted.json().targetUserId,
        second.userId,
      );

      const secondMe = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/me',
        headers: second.headers,
      });
      assert.equal(secondMe.statusCode, 200, secondMe.body);
      assert.equal(secondMe.json().platformAdmin, true);

      const revokedFirst = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/platform/administrators/revoke',
        headers: second.headers,
        payload: { email: first.email },
      });
      assert.equal(
        revokedFirst.statusCode,
        200,
        revokedFirst.body,
      );
      assert.equal(revokedFirst.json().action, 'REVOKED');

      const oldAdminDenied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/platform/administrators',
        headers: first.headers,
      });
      assert.equal(oldAdminDenied.statusCode, 403);
      const revokedCannotWriteLimits = await app.inject({
        method: 'PUT', url: limitsPath, headers: first.headers,
        payload: { pdfMiB: 20, zipMiB: 16, expandedZipMiB: 64, xmlEntryMiB: 8 },
      });
      assert.equal(revokedCannotWriteLimits.statusCode, 403,
        'revocation must remove settings permission immediately');

      const lastAdmin = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/platform/administrators/revoke',
        headers: second.headers,
        payload: { email: second.email },
      });
      assert.equal(lastAdmin.statusCode, 409, lastAdmin.body);
      assert.equal(
        lastAdmin.json().error,
        'last_platform_admin',
      );

      const audit = await admin.query<{
        action: string;
        entity_id: string | null;
      }>(
        `SELECT action, entity_id
         FROM audit_log
         WHERE entity_type = 'platform_user_role'
           AND entity_id = ANY($1::text[])
           AND action IN (
             'PLATFORM_ROLE_GRANTED',
             'PLATFORM_ROLE_REVOKED'
           )`,
        [[first.userId, second.userId]],
      );
      assert.ok(
        audit.rows.some(
          (row) =>
            row.action === 'PLATFORM_ROLE_GRANTED' &&
            row.entity_id === second.userId,
        ),
      );
      assert.ok(
        audit.rows.some(
          (row) =>
            row.action === 'PLATFORM_ROLE_REVOKED' &&
            row.entity_id === first.userId,
        ),
      );
    } finally {
      // Isolated CI database cleanup: do not leave a modified DOU default that
      // changes behavior of unrelated integration tests running in parallel.
      if (sourceFound) {
        await admin.query(
          "UPDATE public.sources SET connector_config=$1::jsonb WHERE code='dou' AND connector_key='dou'",
          [JSON.stringify(originalDouConfig)],
        );
      }
      if (seededDouSource) {
        await admin.query(
          "DELETE FROM public.sources WHERE code='dou' AND connector_key='dou'",
        );
      }
      if (createdUserIds.length > 0) {
        await admin.query(
          `UPDATE platform_user_roles
           SET revoked_at = COALESCE(revoked_at, now()),
               revoked_by = COALESCE(
                 revoked_by,
                 'act-scope-02-test-cleanup'
               )
           WHERE user_id = ANY($1::uuid[])
             AND revoked_at IS NULL`,
          [createdUserIds],
        );
      }
      await app.close();
      await admin.end();
    }
  },
);
