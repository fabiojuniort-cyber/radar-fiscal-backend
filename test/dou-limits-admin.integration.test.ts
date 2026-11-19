import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { readWorkerDouLimits } from '../src/modules/collection/dou-download-limits.js';

const route = '/api/v1/admin/platform/dou-download-limits';
const limits = { pdfMiB: 20, zipMiB: 32, expandedZipMiB: 64, xmlEntryMiB: 8 };

async function session(app: Awaited<ReturnType<typeof buildApp>>) {
  const email = `dou-ci-${randomUUID()}@example.invalid`;
  const password = 'Test-DOU-Settings-2026!';
  const register = await app.inject({ method: 'POST', url: '/auth/register', payload: {
    name: 'DOU Settings Test', email, company: 'DOU test fixture', password,
    confirmPassword: password, acceptedTerms: true,
  } });
  assert.equal(register.statusCode, 201);
  const id = register.json<{ user: { id: string } }>().user.id;
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  assert.equal(login.statusCode, 200);
  return { id, headers: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` } };
}

test('OPS gateway respects admin access, projects the audit entry, and rolls back limits and nonce on audit failure', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl);
  const url = new URL(adminUrl);
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/radar_fiscal_test');
  assert.equal(process.env.NODE_ENV, 'test');
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  t.after(() => admin.end());
  const workerUrl = process.env.OPS_TEST_WORKER_URL;
  assert.ok(workerUrl);
  const workerDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: workerUrl }) }) });
  t.after(() => workerDb.destroy());
  const app = await buildApp();
  t.after(() => app.close());

  const initial = { preserved: 'fixture', douDownloadLimits: { zipMiB: 16, xmlEntryMiB: 'invalid', rejected: 'fixture' } };
  const source = await admin.query<{ id: string }>(`
    INSERT INTO public.sources(code,name,jurisdiction_level,base_url,connector_key,connector_config)
    VALUES('dou','DOU security fixture','FEDERAL','https://example.invalid','dou',$1::jsonb)
    ON CONFLICT (code) DO UPDATE SET connector_config=EXCLUDED.connector_config
    RETURNING id`, [JSON.stringify(initial)]);
  const sourceId = source.rows[0]!.id;
  const operator = await session(app);
  const customer = await session(app);
  await admin.query(`INSERT INTO public.platform_user_roles(user_id,role,granted_by)
    VALUES($1,'PLATFORM_ADMIN','ops-dl-ci')`, [operator.id]);

  const put = (payload: typeof limits, headers = operator.headers) =>
    app.inject({ method: 'PUT', url: route, headers, payload });
  const get = () => app.inject({ method: 'GET', url: route, headers: operator.headers });
  const state = async () => (await admin.query(`SELECT connector_config FROM public.sources WHERE id=$1`, [sourceId])).rows[0]!.connector_config;
  const audit = async () => (await admin.query(`
    SELECT entity_id, before_data, after_data FROM public.audit_log
    WHERE action='DOU_DOWNLOAD_LIMITS_UPDATED' AND actor_id=$1`, [operator.id])).rows;
  const nonces = async () => (await admin.query<{ total: number }>(`
    SELECT count(*)::int AS total FROM public.ops_dou_limits_used_nonces WHERE actor_id=$1`, [operator.id])).rows[0]!.total;

  assert.equal((await put(limits, customer.headers)).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: route, headers: customer.headers })).statusCode, 403);
  assert.equal((await put(limits)).statusCode, 200);
  const read = await get();
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().editable, true);
  assert.deepEqual(read.json().limits, limits);
  assert.deepEqual(await readWorkerDouLimits(workerDb, sourceId), limits);
  const expected = { preserved: 'fixture', douDownloadLimits: limits };
  assert.deepEqual(await state(), expected);
  const originalAudit = [{ entity_id: sourceId, before_data: { zipMiB: 16 }, after_data: limits }];
  assert.deepEqual(await audit(), originalAudit);
  assert.equal(await nonces(), 1);

  await admin.query(`
    CREATE FUNCTION public.ops_test_reject_dou_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'DOU_DOWNLOAD_LIMITS_UPDATED' THEN
        RAISE EXCEPTION 'fixture refuses DOU audit';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ops_test_reject_dou_audit BEFORE INSERT ON public.audit_log
    FOR EACH ROW EXECUTE FUNCTION public.ops_test_reject_dou_audit();
  `);
  const changed = { ...limits, zipMiB: 24 };
  try {
    assert.equal((await put(changed)).statusCode, 500);
    assert.deepEqual(await state(), expected);
    assert.deepEqual(await audit(), originalAudit);
    assert.equal(await nonces(), 1);
  } finally {
    await admin.query(`DROP TRIGGER ops_test_reject_dou_audit ON public.audit_log;
      DROP FUNCTION public.ops_test_reject_dou_audit();`);
  }
  assert.equal((await put(changed)).statusCode, 200);
  assert.equal(await nonces(), 2);
  const afterRecovery = await audit();
  assert.equal(afterRecovery.length, 2);
  assert.deepEqual(afterRecovery.find((entry) => entry.after_data.zipMiB === 24),
    { entity_id: sourceId, before_data: limits, after_data: changed });

  const variants = [{ ...limits, zipMiB: 16 }, { ...limits, zipMiB: 32 }];
  const consecutive = await Promise.all(variants.map((variant) => put(variant)));
  assert.deepEqual(consecutive.map((response) => response.statusCode), [200, 200]);
  const entries = await audit();
  assert.equal(entries.length, 4);
  const first = entries.find((entry) => entry.before_data.zipMiB === 24);
  assert.ok(first);
  // A prior historical fixture can share a before value; the worker must see the last committed transition.
  const lastLimits = await readWorkerDouLimits(workerDb, sourceId);
  assert.ok([16, 32].includes(lastLimits.zipMiB));
  assert.notDeepEqual(lastLimits, first.after_data);
  assert.ok(entries.some((entry) => entry.before_data.zipMiB === first.after_data.zipMiB &&
    entry.after_data.zipMiB === lastLimits.zipMiB));
  assert.deepEqual((await get()).json().limits, lastLimits);
  await admin.query(`UPDATE public.platform_user_roles SET revoked_at=now(),revoked_by='ops-dl-ci'
    WHERE user_id=$1 AND role='PLATFORM_ADMIN' AND revoked_at IS NULL`, [operator.id]);
  assert.equal((await put(limits)).statusCode, 403);
});
