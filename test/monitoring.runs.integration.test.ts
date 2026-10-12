import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Monitoramento-Teste-2026!Safe';

test('MON-01: run counts distinguish filtered, retained, failed and newly imported items', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const sourceId = randomUUID();
  const runId = randomUUID();
  const code = 'mon01-' + randomUUID().slice(0, 12);
  try {
    await app.ready();

    const registration = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Monitoramento Teste',
        email: code + '@example.test',
        company: 'Empresa Monitoramento',
        password: PASSWORD,
        confirmPassword: PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const tenantId = registration.json<{ tenant: { id: string } }>().tenant.id;
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: code + '@example.test', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const accessToken = login.json<{ accessToken: string }>().accessToken;

    await admin.query(
      `INSERT INTO sources (id,code,name,jurisdiction_level,base_url,connector_key)
       VALUES ($1,$2,'MON-01','FEDERAL','https://example.test', $3)`,
      [sourceId, code, 'connector-' + code],
    );
    await admin.query(
      `INSERT INTO collection_runs (id,source_id,scheduled_for,trigger_type,status,started_at,finished_at)
       VALUES ($1,$2,now(),'MANUAL','PARTIAL_SUCCESS',now()-interval '3 seconds',now())`,
      [runId, sourceId],
    );
    await admin.query(
      `INSERT INTO collection_items (collection_run_id,source_item_key,status)
       VALUES
       ($1,'new','PROCESSED_NEW'),
       ($1,'existing','PROCESSED_EXISTING'),
       ($1,'version','NEW_VERSION'),
       ($1,'discard','FILTERED_OUT'),
       ($1,'failed','FAILED')`,
      [runId],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/monitoring/runs',
      headers: {
        authorization: 'Bearer ' + accessToken,
        'x-tenant-id': tenantId,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const run = response.json<{ items: Array<{
      id: string;
      foundItems: number;
      discardedItems: number;
      retainedItems: number;
      processedItems: number;
      importedDocuments: number;
    }> }>().items.find(item => item.id === runId);
    assert.ok(run, 'new test run must appear in 24h monitoring');
    assert.equal(run.foundItems, 5);
    assert.equal(run.discardedItems, 1);
    assert.equal(run.retainedItems, 3);
    assert.equal(run.processedItems, 4, 'FAILED must not count as processed');
    assert.equal(run.importedDocuments, 0, 'no NEW_PUBLICATION/NEW_VERSION receipts persisted');
  } finally {
    await admin.query('DELETE FROM collection_runs WHERE id=$1', [runId]);
    await admin.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await app.close();
    await admin.end();
  }
});
