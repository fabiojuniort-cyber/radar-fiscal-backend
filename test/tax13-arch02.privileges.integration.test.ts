import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

// This test uses a disposable migrated PostgreSQL only. Do not run in prod.
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('TAX13_ARCH02_TEST_ADMIN_DATABASE_REQUIRED');

test('TAX13 V2 proof authority: RLS FORCE, distinct issuer/sealer, zero runtime elevation', async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const roles = await pool.query<{
      rolname: string; rolcanlogin: boolean; rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
      WHERE rolname IN ('radar_legal_issuer','radar_scan_sealer')
      ORDER BY rolname
    `);
    assert.deepEqual(roles.rows.map((r) => r.rolname),
      ['radar_legal_issuer', 'radar_scan_sealer']);
    assert.ok(roles.rows.every((r) => !r.rolcanlogin && !r.rolbypassrls));
    const policies = await pool.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      WHERE c.relname IN ('tax13_legal_proofs_v2',
        'tax13_legal_proof_revocations_v2','tax13_ncm_seals_v2')
      ORDER BY c.relname
    `);
    assert.equal(policies.rows.length,3);
    assert.ok(policies.rows.every((p) => p.relrowsecurity && p.relforcerowsecurity));
    const priv = await pool.query<{
      worker_write: boolean; app_read: boolean; curator_write: boolean;
      issuer_write: boolean; sealer_write: boolean;
      app_details: boolean; worker_v2_projection: boolean;
    }>(`
      SELECT
       has_table_privilege('radar_worker','public.tax13_legal_proofs_v2','INSERT') AS worker_write,
       has_table_privilege('radar_app','public.tax13_legal_proofs_v2','SELECT') AS app_read,
       has_table_privilege('radar_taxonomy_curator','public.tax13_legal_proofs_v2','INSERT') AS curator_write,
       has_table_privilege('radar_legal_issuer','public.tax13_legal_proofs_v2','INSERT') AS issuer_write,
       has_table_privilege('radar_scan_sealer','public.tax13_ncm_seals_v2','INSERT') AS sealer_write,
       has_function_privilege('radar_app','public.tax13_public_current_ncm_details(uuid)','EXECUTE') AS app_details,
       has_function_privilege('radar_worker','public.tax13_v2_admitted_current_fragments(uuid)','EXECUTE') AS worker_v2_projection
    `);
    assert.deepEqual(priv.rows[0], {
      worker_write: false, app_read: false, curator_write: false,
      issuer_write: true, sealer_write: true,
      app_details: true, worker_v2_projection: false,
    });
    const membership = await pool.query<{x: boolean}>(`
      SELECT pg_has_role('radar_worker_runtime','radar_legal_issuer','MEMBER') OR
             pg_has_role('radar_app_runtime','radar_legal_issuer','MEMBER') OR
             pg_has_role('radar_worker_runtime','radar_scan_sealer','MEMBER') OR
             pg_has_role('radar_app_runtime','radar_scan_sealer','MEMBER') AS x
    `);
    assert.equal(membership.rows[0]?.x,false);

    for (const [user, passwordEnv, group, allowedFn, deniedTable] of [
      ['radar_legal_issuer_runtime','DB_LEGAL_ISSUER_RUNTIME_PASSWORD','radar_legal_issuer',
       'tax13_v2_issuer_input', 'tax13_ncm_seals_v2'],
      ['radar_scan_sealer_runtime','DB_NCM_SEALER_RUNTIME_PASSWORD','radar_scan_sealer',
       'tax13_v2_sealer_bundle','tax13_legal_proofs_v2'],
    ] as const) {
      const password = process.env[passwordEnv];
      if (!password) throw new Error('TAX13_CI_ISOLATED_LOGIN_PASSWORD_MISSING');
      const connection = new URL(url);
      connection.username=user;
      connection.password=password;
      const separate = new Pool({connectionString:connection.toString(),max:1});
      try {
        const identity=await separate.query<{who:string;member:boolean;isadmin:boolean}>(`
          SELECT current_user AS who, pg_has_role(current_user,$1,'MEMBER') AS member,
            (r.rolsuper OR r.rolbypassrls) AS isadmin
          FROM pg_roles r WHERE r.rolname=current_user
        `,[group]);
        assert.deepEqual(identity.rows[0],{who:user,member:true,isadmin:false});
        const dummy = await separate.query(
          `SELECT public.${allowedFn}($1::uuid)`,[randomUUID()]);
        assert.ok(Array.isArray(dummy.rows)); // SETOF issuer_input can return zero rows
        await assert.rejects(separate.query(
          `INSERT INTO public.${deniedTable} DEFAULT VALUES`),
          /permission denied/);
      } finally {
        await separate.end();
      }
    }

    const noProof = await pool.query<{value: unknown}>(
      'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS value', [randomUUID()]);
    assert.equal(noProof.rows[0]?.value,null);
  } finally {
    await pool.end();
  }
});
