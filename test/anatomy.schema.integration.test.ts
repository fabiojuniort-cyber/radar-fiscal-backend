import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

// A separate variable and a byte-exact URL: never fall back to DATABASE_URL.
const disposableUrl = 'postgresql://postgres:postgres@localhost:5432/anat04_ci';
function assertDisposableEnvironment(env: NodeJS.ProcessEnv): string {
  assert.equal(env.CI, 'true', 'CI=true required');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions only');
  assert.equal(env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.equal(env.ANAT04_CI_DATABASE_URL, disposableUrl, 'Only the dedicated disposable database is allowed');
  assert.equal(env.DATABASE_URL, undefined, 'Generic runtime database URL must be absent');
  assert.equal(env.DATABASE_ADMIN_URL, undefined, 'Generic admin database URL must be absent');
  return disposableUrl;
}

test('disposable CI guard rejects absent, partial and external configuration before connection', () => {
  const safe = { CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test', ANAT04_CI_DATABASE_URL: disposableUrl };
  assert.equal(assertDisposableEnvironment(safe), disposableUrl);
  for (const key of Object.keys(safe)) {
    const missing: NodeJS.ProcessEnv = { ...safe }; delete missing[key];
    assert.throws(() => assertDisposableEnvironment(missing));
  }
  for (const url of ['postgresql://postgres:postgres@remote:5432/anat04_ci',
    'postgresql://postgres:postgres@localhost:5432/postgres', `${disposableUrl}?host=remote`,
    'postgresql://postgres:postgres@localhost:5433/anat04_ci']) {
    assert.throws(() => assertDisposableEnvironment({ ...safe, ANAT04_CI_DATABASE_URL: url }));
  }
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_URL: disposableUrl }));
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_ADMIN_URL: disposableUrl }));
});

test('eight-table disposable CI schema: atomicity and incompatible references',
  { skip: process.env.ANAT04_CI_DATABASE_URL === undefined ? 'CI-only DDL; offline guards still run' : false }, async (t) => {
    const connectionString = assertDisposableEnvironment(process.env); // Must precede construction/connect.
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    const hash = (character: string) => character.repeat(64);
    const a = hash('a'); const b = hash('b'); const input = hash('c'); const ruleHash = hash('d');
    try {
      await client.query('BEGIN');
      const ddl = await readFile(new URL('./support/anatomy-ci-schema.sql', import.meta.url), 'utf8');
      await t.test('SQL independently refuses preparation without its disposable marker', async () => {
        await client.query('SAVEPOINT sql_guard');
        await assert.rejects(client.query(ddl), /ANAT04_DISPOSABLE_CI_ONLY/);
        await client.query('ROLLBACK TO SAVEPOINT sql_guard');
        await client.query('RELEASE SAVEPOINT sql_guard');
      });
      await client.query("SET LOCAL anatomy.ci_disposable = 'true'");
      await client.query(ddl);
      await t.test('exactly eight isolated tables; no application migrations', async () => {
        const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        assert.deepEqual(tables.rows.map((row) => row.tablename), ['anatomy_dependencies', 'anatomy_entities',
          'anatomy_evidence', 'anatomy_parts', 'anatomy_rule_sets', 'anatomy_run_items', 'anatomy_runs', 'publication_anatomies']);
      });
      await client.query("INSERT INTO anatomy_rule_sets VALUES ('rules','1','reviewed',$1,'ANAT-TAX/1.0.0','{}','fixture','fixture')", [ruleHash]);
      for (const [id, version, engine] of [[a, 'version-a', 'engine-1'], [b, 'version-b', 'engine-2']]) {
        await client.query(`INSERT INTO publication_anatomies
          (id,publication_version_id,representation_id,source,input_text_hash,input_presentation_hash,attachment_manifest_hash,
          engine_version,engine_hash,rule_set_id,rule_set_hash,contract_version,status,text_length,coverage,output_hash)
          VALUES ($1,$2,'snapshot','CONFAZ',$3,NULL,$3,$4,$6,'rules',$5,'ANAT-TAX/1.0.0','complete',100,'{}',$3)`,
        [id, version, input, engine, ruleHash, hash('f')]);
        await client.query(`INSERT INTO anatomy_parts
          (anatomy_id,id,parent_id,sibling_order,type,label,start_utf16,end_utf16,source_pointers,confidence,coverage,context)
          VALUES ($1,'root',NULL,0,'document','document',0,100,'[]',1,'complete','unknown')`, [id]);
      }
      await client.query(`INSERT INTO anatomy_parts
        (anatomy_id,id,parent_id,sibling_order,type,label,start_utf16,end_utf16,source_pointers,confidence,coverage,context)
        VALUES ($1,'a-only','root',0,'clause','one',0,50,'[]',1,'complete','unknown')`, [a]);
      await client.query(`INSERT INTO anatomy_evidence VALUES
        ($1,'proof-a','a-only','controlled_fixture',0,50,'fixture','{}','2026-10-16','2026-01-01','2026-12-31','current','fixture',now())`, [a]);
      await client.query(`INSERT INTO anatomy_runs VALUES
        ('run',$1,'{}','engine-1','rules',$2,'fixture',now(),NULL,NULL,'{}',NULL)`, [input, ruleHash]);

      async function rejected(sql: string, params: unknown[], expected: RegExp): Promise<void> {
        await client.query('SAVEPOINT invalid_reference');
        await assert.rejects(client.query(sql, params), expected);
        await client.query('ROLLBACK TO SAVEPOINT invalid_reference');
        await client.query('RELEASE SAVEPOINT invalid_reference');
      }
      await t.test('child cannot refer to a parent in another analysis', async () => {
        await rejected(`INSERT INTO anatomy_parts
          (anatomy_id,id,parent_id,sibling_order,type,label,start_utf16,end_utf16,source_pointers,confidence,coverage,context)
          VALUES ($1,'invalid-child','a-only',0,'clause','x',0,10,'[]',1,'complete','unknown')`, [b], /Parent missing/);
      });
      await t.test('entity and evidence cannot refer to another analysis part', async () => {
        await rejected(`INSERT INTO anatomy_entities VALUES ($1,'entity','a-only','NCM','1234','1234',0,4,'fixture',1,'{}',NULL)`, [b], /Occurrence outside/);
        await rejected(`INSERT INTO anatomy_evidence VALUES
          ($1,'proof','a-only','controlled_fixture',0,4,'fixture','{}','2026-10-16','2026-01-01','2026-12-31','current','fixture',now())`, [b], /Occurrence outside/);
      });
      await t.test('dependency cannot refer to evidence in another analysis', async () => {
        await rejected(`INSERT INTO anatomy_dependencies VALUES ($1,'dependency','proof-a','root','fixture',$2,$2,'fixture','pending')`,
          [b, input], /foreign key constraint/);
      });
      await t.test('run output must match version, input hash, engine and rules', async () => {
        const sql = `INSERT INTO anatomy_run_items VALUES ('run','item',$1,$2,$3,'rules',$4,'complete',1,0,NULL,$5,$6)`;
        for (const values of [['version-a', input, 'engine-1', ruleHash, b],
          ['wrong-version', input, 'engine-1', ruleHash, a], ['version-a', hash('e'), 'engine-1', ruleHash, a],
          ['version-a', input, 'engine-2', ruleHash, b], ['version-a', input, 'engine-1', hash('f'), a]]) {
          await rejected(sql, [...values, a], /foreign key constraint|check constraint/);
        }
        await client.query(sql, ['version-a', input, 'engine-1', ruleHash, a, a]);
      });
      await t.test('same text/version with another presentation cannot replace the expected analysis', async () => {
        const other = hash('e');
        await client.query(`INSERT INTO publication_anatomies
          (id,publication_version_id,representation_id,source,input_text_hash,input_presentation_hash,attachment_manifest_hash,
          engine_version,engine_hash,rule_set_id,rule_set_hash,contract_version,status,text_length,coverage,output_hash)
          SELECT $1,publication_version_id,'other-presentation',source,input_text_hash,$1,attachment_manifest_hash,
          engine_version,engine_hash,rule_set_id,rule_set_hash,contract_version,'partial',text_length,coverage,output_hash
          FROM publication_anatomies WHERE id=$2`, [other, a]);
        await rejected(`INSERT INTO anatomy_run_items VALUES
          ('run','wrong-presentation','version-a',$1,'engine-1','rules',$2,'partial',1,0,NULL,$3,$4)`,
          [input, ruleHash, other, a], /check constraint/);
        await rejected(`INSERT INTO anatomy_run_items VALUES
          ('run','wrong-status','version-a',$1,'engine-1','rules',$2,'complete',1,0,NULL,$3,$3)`,
          [input, ruleHash, other], /foreign key constraint/);
      });
      await t.test('invalid batch rolls back valid earlier writes atomically', async () => {
        await client.query('SAVEPOINT atomic_batch');
        await client.query(`INSERT INTO anatomy_entities VALUES ($1,'atomic','a-only','NCM','1234','1234',0,4,'fixture',1,'{}',NULL)`, [a]);
        await assert.rejects(client.query(`INSERT INTO anatomy_entities VALUES ($1,'bad','a-only','NCM','1234','1234',0,4,'fixture',1,'{}',NULL)`, [b]), /Occurrence outside/);
        await client.query('ROLLBACK TO SAVEPOINT atomic_batch');
        assert.equal((await client.query("SELECT count(*)::int AS count FROM anatomy_entities WHERE id='atomic'")).rows[0].count, 0);
        await client.query('RELEASE SAVEPOINT atomic_batch');
      });
      await t.test('part geometry cannot escape its parent or be changed into a cycle', async () => {
        await rejected("UPDATE anatomy_parts SET parent_id='a-only' WHERE anatomy_id=$1 AND id='root'", [a], /immutable/);
        await rejected(`INSERT INTO anatomy_parts
          (anatomy_id,id,parent_id,sibling_order,type,label,start_utf16,end_utf16,source_pointers,confidence,coverage,context)
          VALUES ($1,'outside','a-only',0,'item','x',49,60,'[]',1,'complete','unknown')`, [a], /outside span/);
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
