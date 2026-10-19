import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

// Only run in CI's isolated PostgreSQL 18 service. NEVER point this at production.
test('ONB-02 R5: EXPLAIN ANALYZE audit mask on 50,000 synthetic records, rollback', async () => {
  assert.equal(process.env.CI, 'true', 'CI isolated environment is required');
  assert.ok(process.env.DATABASE_ADMIN_URL?.includes('localhost:5432/radar_fiscal_test'),
    'must use disposable local test PostgreSQL, never production');
  const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
  const client = await pool.connect();
  try {
    const version = (await client.query<{version:string}>('SHOW server_version')).rows[0]!.version;
    assert.match(version,/^18\./,'PostgreSQL 18 required');
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='30000ms'");
    const tenant = (await client.query<{id:string}>(
      'INSERT INTO tenants(name,slug) VALUES($1,$2) RETURNING id',
      ['ONB02 R5 isolated benchmark', 'onb02-r5-'+randomUUID().slice(0,8)],
    )).rows[0]!.id;
    await client.query(`
      INSERT INTO audit_log(tenant_id,actor_type,action,entity_type,before_data)
      SELECT $1::uuid,'SYSTEM','ONB02_R5_BENCH','company',
        jsonb_build_object('name',CASE WHEN n%1000=0
          THEN 'Empresa Sintética Benchmark' ELSE 'Outro histórico sem vínculo' END)
      FROM generate_series(1,50000) n
    `,[tenant]);
    const rows=(await client.query<{count:string}>(
      "SELECT count(*)::text AS count FROM audit_log WHERE tenant_id=$1 AND action='ONB02_R5_BENCH'",
      [tenant])).rows[0]!.count;
    assert.equal(Number(rows),50000);
    const idx=(await client.query<{count:string}>(`
      SELECT count(*)::text AS count FROM pg_indexes
      WHERE schemaname='public' AND indexname='ix_audit_r5_tenant_entity'
    `)).rows[0]!.count;
    assert.equal(Number(idx),1,'required tenant/entity audit index absent');
    await client.query('ANALYZE audit_log');
    const plan=(await client.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; Plan: unknown }> }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      UPDATE audit_log a
      SET before_data=public.onb02_redact_audit_json(
        a.before_data,$2::text[],$3::text[],$4::text[])
      WHERE a.tenant_id=$1::uuid
        AND (
          public.onb02_redact_audit_json(
            a.before_data,ARRAY[]::text[],ARRAY[]::text[],$4::text[])
              IS DISTINCT FROM a.before_data
        )
    `,[tenant,[],[],['Empresa Sintética Benchmark']])).rows[0]!['QUERY PLAN'][0]!;
    assert.ok(plan['Execution Time']>0);
    const changed=(await client.query<{total:string}>(`
      SELECT count(*)::text AS total FROM audit_log
      WHERE tenant_id=$1 AND before_data->>'name'='[NOME_EMPRESA_MASCARADO]'
    `,[tenant])).rows[0]!.total;
    assert.equal(Number(changed),50,'exact 1/1000 matching name rows must be masked');
    console.log(`ONB02_R5_PG18_EXPLAIN_ANALYZE rows=50000 changed=${changed} execution_ms=${plan['Execution Time'].toFixed(3)} index=ix_audit_r5_tenant_entity`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
