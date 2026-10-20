import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import { insertFixtureSource } from './fixtures/taxonomy-v1-1-source.js';
import {
  createTaxonomyV11DraftInTransaction,
  dryRunTaxonomyV11Successor,
  publishTaxonomyV11InTransaction,
} from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.database.js';
import { RETIRED_DIMENSION_CODES } from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL is required for taxonomy v1.1 integration test.');
}


test('TAX-10 creates, validates and publishes v1.1 without retired dimensions', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      TRUNCATE TABLE
        taxonomy_releases,
        taxonomy_dimensions,
        taxonomy_concepts,
        taxonomy_aliases,
        taxonomy_relation_types,
        taxonomy_evidence,
        official_catalogs
      CASCADE
    `);
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');

    const fixture = await insertFixtureSource(client);

    const dryRun = await dryRunTaxonomyV11Successor(client);
    assert.equal(dryRun.action, 'CREATE_DRAFT');
    assert.deepEqual(dryRun.blockers, []);
    assert.equal(dryRun.sourceReleaseId, fixture.releaseId);
    assert.equal(dryRun.plan?.sourceDimensions, 20);
    assert.equal(dryRun.plan?.sourceConcepts, 628);
    assert.equal(dryRun.plan?.retainedDimensions, 15);
    assert.equal(dryRun.plan?.retainedConcepts, 590);
    assert.equal(dryRun.copyable?.aliasBindings, 1);
    assert.equal(dryRun.copyable?.relationRules, 1);
    assert.equal(dryRun.copyable?.relations, 1);
    assert.equal(dryRun.copyable?.officialMappings, 1);
    assert.equal(dryRun.copyable?.aliasEvidence, 1);
    assert.equal(dryRun.copyable?.relationEvidence, 1);
    assert.equal(dryRun.copyable?.mappingEvidence, 1);

    const created = await createTaxonomyV11DraftInTransaction(client);
    assert.equal(created.disposition, 'CREATED_DRAFT');
    assert.equal(created.snapshot.status, 'DRAFT');
    assert.equal(created.snapshot.dimensions, 15);
    assert.equal(created.snapshot.concepts, 590);
    assert.equal(created.snapshot.retiredDimensionsPresent, 0);
    assert.equal(created.snapshot.retiredConceptsPresent, 0);
    assert.deepEqual(
      [...created.snapshot.preservedDimensionCodes].sort(),
      ['subject', 'theme', 'treatment'],
    );
    assert.equal(created.snapshot.aliasBindings, 1);
    assert.equal(created.snapshot.relationRules, 1);
    assert.equal(created.snapshot.relations, 1);
    assert.equal(created.snapshot.officialMappings, 1);
    assert.equal(created.snapshot.aliasEvidence, 1);
    assert.equal(created.snapshot.relationEvidence, 1);
    assert.equal(created.snapshot.mappingEvidence, 1);

    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    const replay = await createTaxonomyV11DraftInTransaction(client);
    assert.equal(replay.disposition, 'IDEMPOTENT_DRAFT');
    assert.equal(replay.releaseId, created.releaseId);

    const sourceBeforePublish = await client.query<{
      status: string;
      dimensions: number;
      concepts: number;
    }>(
      `SELECT
         r.status,
         (SELECT count(*)::int FROM taxonomy_release_dimensions WHERE release_id = r.id) AS dimensions,
         (SELECT count(*)::int FROM taxonomy_release_concepts WHERE release_id = r.id) AS concepts
       FROM taxonomy_releases r
       WHERE r.id = $1::uuid`,
      [fixture.releaseId],
    );
    assert.equal(sourceBeforePublish.rows[0]?.status, 'PUBLISHED');
    assert.equal(sourceBeforePublish.rows[0]?.dimensions, 20);
    assert.equal(sourceBeforePublish.rows[0]?.concepts, 628);

    // R7.2: free options.actor used to bypass every JSON allowlist. The database
    // must reject it and the caller can roll back the entire publication attempt.
    await client.query('SAVEPOINT invalid_audit_actor');
    await assert.rejects(publishTaxonomyV11InTransaction(client, {
      artifactRepository: 'fabiojuniort-cyber/radar-fiscal-backend',
      artifactPath: 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json',
      artifactGitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      actor: 'synthetic@example.test',
    }), (error: unknown) => (error as { code: string; message: string }).code === '23514'
      && (error as { message: string }).message === 'audit_invalid_actor');
    await client.query('ROLLBACK TO SAVEPOINT invalid_audit_actor');
    assert.equal((await client.query('SELECT status FROM taxonomy_releases WHERE id=$1',
      [created.releaseId])).rows[0]?.status, 'DRAFT');

    const published = await publishTaxonomyV11InTransaction(client, {
      artifactRepository: 'fabiojuniort-cyber/radar-fiscal-backend',
      artifactPath: 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json',
      artifactGitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      actor: 'system:taxonomy-v1.1-publisher',
    });
    assert.equal(published.disposition, 'PUBLISHED');
    assert.equal(published.snapshot.status, 'PUBLISHED');

    const publishReplay = await publishTaxonomyV11InTransaction(client, {
      artifactRepository: 'fabiojuniort-cyber/radar-fiscal-backend',
      artifactPath: 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json',
      artifactGitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      actor: 'system:taxonomy-v1.1-publisher',
    });
    assert.equal(publishReplay.disposition, 'ALREADY_PUBLISHED');

    const retiredTarget = await client.query<{ code: string }>(
      `SELECT d.code
       FROM taxonomy_release_dimensions rd
       JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
       WHERE rd.release_id = $1::uuid
         AND d.code = ANY($2::text[])`,
      [created.releaseId, [...RETIRED_DIMENSION_CODES]],
    );
    assert.deepEqual(retiredTarget.rows, []);

    const sourceAfterPublish = await client.query<{ status: string }>(
      `SELECT status FROM taxonomy_releases WHERE id = $1::uuid`,
      [fixture.releaseId],
    );
    assert.equal(sourceAfterPublish.rows[0]?.status, 'PUBLISHED');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
