import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool, type PoolClient } from 'pg';

const TRANSITION_SIGNATURE =
  'public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)';

async function setRole(
  client: PoolClient,
  role: 'radar_app_runtime' | 'radar_worker_runtime',
): Promise<void> {
  await client.query(`SET LOCAL ROLE ${role}`);
}

async function resetRole(client: PoolClient): Promise<void> {
  await client.query('RESET ROLE');
}

async function canonicalFingerprints(
  client: PoolClient,
  publicationId: string,
): Promise<{ publication: string; origin: string; version: string }> {
  const result = await client.query<{
    publication: string;
    origin: string;
    version: string;
  }>(
    `
      SELECT
        md5(to_jsonb(p)::text) AS publication,
        (
          SELECT md5(to_jsonb(po)::text)
          FROM publication_origins po
          WHERE po.publication_id = p.id
          ORDER BY po.id
          LIMIT 1
        ) AS origin,
        (
          SELECT md5(to_jsonb(pv)::text)
          FROM publication_versions pv
          WHERE pv.publication_id = p.id
          ORDER BY pv.version_no
          LIMIT 1
        ) AS version
      FROM publications p
      WHERE p.id = $1::uuid
    `,
    [publicationId],
  );

  const row = result.rows[0];
  assert.ok(row);
  return row;
}

test('publication scope SUPPRESS/RESTORE is reversible, audited and fail-closed', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const client = await pool.connect();

  const publicationId = randomUUID();
  const originId = randomUUID();
  const versionId = randomUUID();
  const sourceId = randomUUID();
  const runId = randomUUID();
  const sourceCode = `scope-${randomUUID().slice(0, 8)}`;
  const identityHash = '1'.repeat(64);
  const contentHash = '2'.repeat(64);
  const evidenceHash = 'a'.repeat(64);
  const manifestHash = 'b'.repeat(64);

  try {
    await client.query('BEGIN');

    await client.query(
      `
        INSERT INTO sources (
          id, code, name, jurisdiction_level, base_url, connector_key
        ) VALUES ($1,$2,$3,'FEDERAL',$4,$5)
      `,
      [
        sourceId,
        sourceCode,
        'Scope integration source',
        'https://example.invalid/scope',
        sourceCode,
      ],
    );

    await client.query(
      `
        INSERT INTO publications (
          id, identity_hash, identity_strength, identity_basis,
          jurisdiction_level, title, published_on, primary_official_url
        ) VALUES (
          $1,$2,'STRONG','{"test":"scope"}'::jsonb,
          'FEDERAL','LEI TESTE DE ESCOPO','2026-10-05',
          'https://example.invalid/scope/publication'
        )
      `,
      [publicationId, identityHash],
    );

    await client.query(
      `
        INSERT INTO publication_origins (
          id, publication_id, source_id, external_id, official_url, metadata
        ) VALUES (
          $1,$2,$3,'scope-ext-1',
          'https://example.invalid/scope/origin',
          '{"sourceRole":"PRIMARY"}'::jsonb
        )
      `,
      [originId, publicationId, sourceId],
    );

    await client.query(
      `
        INSERT INTO publication_versions (
          id, publication_id, version_no, content_hash,
          content_text, source_metadata, is_current
        ) VALUES (
          $1,$2,1,$3,'conteudo original',
          '{"sourceRole":"PRIMARY"}'::jsonb,true
        )
      `,
      [versionId, publicationId, contentHash],
    );

    await client.query(
      `
        INSERT INTO collection_runs (
          id, source_id, scheduled_for, trigger_type, status
        ) VALUES ($1,$2,'2026-10-05T12:00:00Z','MANUAL','SUCCESS')
      `,
      [runId, sourceId],
    );

    await client.query(
      `
        INSERT INTO collection_run_publications (
          collection_run_id, publication_id, publication_version_id,
          disposition
        ) VALUES ($1,$2,$3,'NEW_PUBLICATION')
      `,
      [runId, publicationId, versionId],
    );

    const before = await canonicalFingerprints(client, publicationId);

    const feedBefore = await client.query(
      `SELECT 1 FROM publication_source_feed
       WHERE publication_id = $1::uuid`,
      [publicationId],
    );
    assert.equal(feedBefore.rowCount, 1);

    const privileges = await client.query<{
      app_events_read: boolean;
      worker_state_read: boolean;
      app_transition: boolean;
      worker_transition: boolean;
    }>(
      `
        SELECT
          has_table_privilege(
            'radar_app', 'public.publication_scope_events', 'SELECT'
          ) AS app_events_read,
          has_table_privilege(
            'radar_worker', 'public.publication_scope_state', 'SELECT'
          ) AS worker_state_read,
          has_function_privilege(
            'radar_app', $1, 'EXECUTE'
          ) AS app_transition,
          has_function_privilege(
            'radar_worker', $1, 'EXECUTE'
          ) AS worker_transition
      `,
      [TRANSITION_SIGNATURE],
    );
    assert.deepEqual(privileges.rows[0], {
      app_events_read: false,
      worker_state_read: false,
      app_transition: false,
      worker_transition: false,
    });

    await setRole(client, 'radar_app_runtime');
    const appBefore = await client.query(
      `
        SELECT
          (SELECT count(*)::int FROM publications WHERE id = $1::uuid) AS publications,
          (SELECT count(*)::int FROM publication_origins WHERE publication_id = $1::uuid) AS origins,
          (SELECT count(*)::int FROM publication_versions WHERE publication_id = $1::uuid) AS versions,
          (SELECT count(*)::int FROM collection_run_publications WHERE publication_id = $1::uuid) AS run_links
      `,
      [publicationId],
    );
    assert.deepEqual(appBefore.rows[0], {
      publications: 1,
      origins: 1,
      versions: 1,
      run_links: 1,
    });
    await resetRole(client);

    const suppressOperation = randomUUID();
    const suppressed = await client.query<{
      event_id: string;
      resulting_scope: string;
      applied: boolean;
    }>(
      `
        SELECT *
        FROM public.apply_publication_scope_transition(
          $1::uuid,
          'SUPPRESS',
          $2::uuid,
          NULL::uuid,
          'dou-clean-02',
          'EXCLUDED_BY_REVIEWED_POLICY',
          'scope-policy-v1',
          $3,
          $4,
          'integration-test'
        )
      `,
      [publicationId, suppressOperation, evidenceHash, manifestHash],
    );
    assert.deepEqual(
      {
        scope: suppressed.rows[0]?.resulting_scope,
        applied: suppressed.rows[0]?.applied,
      },
      { scope: 'OUT_OF_SCOPE', applied: true },
    );
    const suppressEventId = suppressed.rows[0]!.event_id;

    const retry = await client.query<{
      event_id: string;
      resulting_scope: string;
      applied: boolean;
    }>(
      `
        SELECT *
        FROM public.apply_publication_scope_transition(
          $1::uuid,
          'SUPPRESS',
          $2::uuid,
          NULL::uuid,
          'dou-clean-02',
          'EXCLUDED_BY_REVIEWED_POLICY',
          'scope-policy-v1',
          $3,
          $4,
          'integration-test'
        )
      `,
      [publicationId, suppressOperation, evidenceHash, manifestHash],
    );
    assert.equal(retry.rows[0]?.event_id, suppressEventId);
    assert.equal(retry.rows[0]?.resulting_scope, 'OUT_OF_SCOPE');
    assert.equal(retry.rows[0]?.applied, false);

    const feedSuppressed = await client.query(
      `SELECT 1 FROM publication_source_feed
       WHERE publication_id = $1::uuid`,
      [publicationId],
    );
    assert.equal(feedSuppressed.rowCount, 0);

    await setRole(client, 'radar_app_runtime');
    const appSuppressed = await client.query(
      `
        SELECT
          (SELECT count(*)::int FROM publications WHERE id = $1::uuid) AS publications,
          (SELECT count(*)::int FROM publication_origins WHERE publication_id = $1::uuid) AS origins,
          (SELECT count(*)::int FROM publication_versions WHERE publication_id = $1::uuid) AS versions,
          (SELECT count(*)::int FROM collection_run_publications WHERE publication_id = $1::uuid) AS run_links,
          public.publication_scope_is_in_scope($1::uuid) AS in_scope
      `,
      [publicationId],
    );
    assert.deepEqual(appSuppressed.rows[0], {
      publications: 0,
      origins: 0,
      versions: 0,
      run_links: 0,
      in_scope: false,
    });
    await resetRole(client);

    await setRole(client, 'radar_worker_runtime');
    const workerSuppressed = await client.query(
      `
        SELECT
          (SELECT count(*)::int FROM publications WHERE id = $1::uuid) AS publications,
          (SELECT count(*)::int FROM publication_origins WHERE publication_id = $1::uuid) AS origins,
          (SELECT count(*)::int FROM publication_versions WHERE publication_id = $1::uuid) AS versions,
          public.publication_scope_is_in_scope($1::uuid) AS in_scope
      `,
      [publicationId],
    );
    assert.deepEqual(workerSuppressed.rows[0], {
      publications: 1,
      origins: 1,
      versions: 1,
      in_scope: false,
    });
    await resetRole(client);

    assert.deepEqual(
      await canonicalFingerprints(client, publicationId),
      before,
      'suppression must not mutate canonical/origin/version evidence',
    );

    await client.query('SAVEPOINT scope_event_guard');
    await assert.rejects(
      client.query(
        `UPDATE publication_scope_events
         SET reason_code = 'MUTATED'
         WHERE id = $1::uuid`,
        [suppressEventId],
      ),
      /PUBLICATION_SCOPE_EVENT_APPEND_ONLY/,
    );
    await client.query('ROLLBACK TO SAVEPOINT scope_event_guard');
    await client.query('RELEASE SAVEPOINT scope_event_guard');

    // The expected-current-event token is mandatory for a valid RESTORE.
    await client.query('SAVEPOINT stale_restore');
    await assert.rejects(
      client.query(
        `
          SELECT *
          FROM public.apply_publication_scope_transition(
            $1::uuid,'RESTORE',$2::uuid,NULL::uuid,
            'dou-clean-02','MANUAL_RESTORE','scope-policy-v1',
            $3,$4,'integration-test'
          )
        `,
        [publicationId, randomUUID(), evidenceHash, manifestHash],
      ),
      /PUBLICATION_SCOPE_STALE_EXPECTATION/,
    );
    await client.query('ROLLBACK TO SAVEPOINT stale_restore');
    await client.query('RELEASE SAVEPOINT stale_restore');

    const restoreOperation = randomUUID();
    const restored = await client.query<{
      event_id: string;
      resulting_scope: string;
      applied: boolean;
    }>(
      `
        SELECT *
        FROM public.apply_publication_scope_transition(
          $1::uuid,'RESTORE',$2::uuid,$3::uuid,
          'dou-clean-02','MANUAL_RESTORE','scope-policy-v1',
          $4,$5,'integration-test'
        )
      `,
      [
        publicationId,
        restoreOperation,
        suppressEventId,
        evidenceHash,
        manifestHash,
      ],
    );
    assert.equal(restored.rows[0]?.resulting_scope, 'IN_SCOPE');
    assert.equal(restored.rows[0]?.applied, true);

    const feedRestored = await client.query(
      `SELECT 1 FROM publication_source_feed
       WHERE publication_id = $1::uuid`,
      [publicationId],
    );
    assert.equal(feedRestored.rowCount, 1);

    await setRole(client, 'radar_app_runtime');
    const appRestored = await client.query(
      'SELECT count(*)::int AS n FROM publications WHERE id = $1::uuid',
      [publicationId],
    );
    assert.equal(appRestored.rows[0]?.n, 1);
    await resetRole(client);

    // Suppress once more, then prove a material canonical mutation produces a
    // compensating RESTORE event instead of inheriting stale suppression.
    const resuppress = await client.query<{ event_id: string }>(
      `
        SELECT event_id
        FROM public.apply_publication_scope_transition(
          $1::uuid,'SUPPRESS',$2::uuid,$3::uuid,
          'dou-clean-02','EXCLUDED_BY_REVIEWED_POLICY','scope-policy-v1',
          $4,$5,'integration-test'
        )
      `,
      [
        publicationId,
        randomUUID(),
        restored.rows[0]!.event_id,
        evidenceHash,
        manifestHash,
      ],
    );
    assert.ok(resuppress.rows[0]?.event_id);

    await client.query(
      `UPDATE publications
       SET title = title || ' ALTERADA', updated_at = now()
       WHERE id = $1::uuid`,
      [publicationId],
    );

    const autoRestore = await client.query<{
      scope: string;
      actor_ref: string;
      action: string;
      reason_code: string;
    }>(
      `
        SELECT s.scope, e.actor_ref, e.action, e.reason_code
        FROM publication_scope_state s
        JOIN publication_scope_events e ON e.id = s.current_event_id
        WHERE s.publication_id = $1::uuid
      `,
      [publicationId],
    );
    assert.deepEqual(autoRestore.rows[0], {
      scope: 'IN_SCOPE',
      actor_ref: 'SYSTEM_MATERIAL_CHANGE',
      action: 'RESTORE',
      reason_code: 'PUBLICATION_MATERIAL_CHANGED',
    });

    const eventCount = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM publication_scope_events
       WHERE publication_id = $1::uuid`,
      [publicationId],
    );
    assert.equal(eventCount.rows[0]?.n, 4);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
