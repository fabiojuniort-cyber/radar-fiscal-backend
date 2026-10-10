import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { classifySinglePublication } from '../src/modules/taxonomy/classification/classification.worker.js';
import { seedTestLegalScopeAttestation } from './legal-scope-attestation.fixture.js';
import { classifyPublicationVersionLexically } from '../src/modules/taxonomy/classification/classification.repository.js';
import { matchPublicationByTaxonomy } from '../src/modules/taxonomy/matching/taxonomy-matching.service.js';
import { persistSuccessfulScan, PUBLICATION_NCM_DETECTOR_KEY, PUBLICATION_NCM_DETECTOR_VERSION } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const transition = `SELECT * FROM public.apply_publication_scope_transition(
  $1::uuid,$2,$3::uuid,$4::uuid,'CONCURRENCY_TEST','CONTROLLED_RACE','test-v1',$5,NULL,'CI')`;

async function waitBlocked(admin: Pool, name: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await admin.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid)) > 0`, [name]);
    if (r.rowCount) return;
    await setTimeout(25);
  }
  assert.fail(`Expected a real database lock wait: ${name}`);
}

test('SUPPRESS races real NCM, classification, matching and curator commit paths', async () => {
  // Multi-session visibility requires committed fixtures. This test is only
  // for the disposable CI database; ledger events are deliberately retained.
  assert.equal(process.env.NODE_ENV, 'test');
  const url = process.env.DATABASE_ADMIN_URL;
  assert.ok(url);
  const admin = new Pool({ connectionString: url, max: 3 });
  const pub = randomUUID(), ver = randomUUID(), tenant = randomUUID();
  const company = randomUUID(), profile = randomUUID(), release = randomUUID();
  const suffix = randomUUID();
  const names = ['ncm', 'classification', 'legacy', 'matching', 'curator'].map(x => `${x}-${suffix}`);
  const pools = names.map(application_name => new Pool({ connectionString: url, max: 1, application_name, options: '-c role=radar_worker' }));
  const ncmDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pools[0]! }) });
  const classifyDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pools[1]! }) });
  let suppressor: PoolClient | undefined;
  let pending: Promise<unknown>[] = [];
  let releaseWriter = () => {};
  const row = { publication_version_id: ver, content_text: 'controlled race', relevant_excerpt: null, presentation_html: null };
  try {
    await admin.query(`INSERT INTO publications(id,identity_hash,identity_strength,identity_basis,jurisdiction_level,title)
      VALUES($1,$2,'SOURCE_SCOPED','{}','FEDERAL','scope concurrency fixture')`, [pub, hash(suffix)]);
    await admin.query(`INSERT INTO publication_versions(id,publication_id,version_no,content_hash,content_text,source_metadata)
      VALUES($1,$2,1,$3,'controlled race', $4::jsonb)`, [ver, pub, hash(ver), JSON.stringify({presentation: {format: 'SANITIZED_HTML', html: '<p class="TextoAcordo">controlled race</p>'}})]);
    // Publication scope races do not require a legally admitted CURRENT proof.
    // R8-02 rejects synthetic positive proofs even from CI administrators;
    // retain only the append-only scope ledger for concurrent locking tests.
    await seedTestLegalScopeAttestation(admin, ver, 'COMPLETE', false);
    await admin.query(`INSERT INTO publication_ncm_scans(publication_version_id,detector_key,detector_version,status,source_field)
      VALUES($1,$2,$3,'SUCCESS','CONTENT_TEXT')`, [ver, PUBLICATION_NCM_DETECTOR_KEY, PUBLICATION_NCM_DETECTOR_VERSION]);
    await admin.query(`INSERT INTO taxonomy_releases(id,version_major,version_minor,version_patch,status,
      approved_at,published_at,withdrawn_at,withdrawn_by_actor,withdrawal_reason,
      artifact_repository,artifact_path,artifact_git_sha,artifact_sha256,created_by_actor)
      VALUES($1,0,$2,0,'WITHDRAWN',now(),now(),now(),'CI','isolated fixture',
      'fixture','fixture',$3,$4,'CI')`, [release, parseInt(hash(release).slice(0, 7), 16), 'a'.repeat(40), hash(release)]);
    const grants = await admin.query(`SELECT
      has_function_privilege('radar_app','public.publication_scope_lock_curator_version(uuid)','EXECUTE') app,
      has_function_privilege('radar_worker','public.publication_scope_lock_curator_version(uuid)','EXECUTE') worker,
      has_function_privilege('radar_taxonomy_curator','public.publication_scope_lock_curator_version(uuid)','EXECUTE') curator`);
    assert.deepEqual(grants.rows[0], { app: false, worker: false, curator: true });
    await admin.query(`INSERT INTO tenants(id,name,slug) VALUES($1,'scope race',$2)`, [tenant, suffix]);
    await admin.query(`INSERT INTO companies(id,tenant_id,legal_name,head_office_cnpj)
      VALUES($1,$2,'scope race','12345678901234')`, [company, tenant]);
    await admin.query(`INSERT INTO monitoring_profiles(id,company_id,name,criteria,criteria_schema_version,profile_version)
      VALUES($1,$2,'scope race',$3,2,1)`, [profile, company, JSON.stringify({ taxonomy: { releasePolicy: 'CURRENT_PUBLISHED', anyOf: ['scope.fixture'], allOf: [], noneOf: [], includeDescendants: true } })]);
    suppressor = await admin.connect();
    await suppressor.query('BEGIN');
    const suppressed = await suppressor.query(transition, [pub, 'SUPPRESS', randomUUID(), null, hash(pub)]);
    // All five callers start with a snapshot that still sees IN_SCOPE and
    // then actually wait behind the uncommitted transition's publication lock.
    pending = [
      ncmDb.transaction().execute(trx => persistSuccessfulScan(trx, row, 'CONTENT_TEXT', [])),
      classifySinglePublication(classifyDb, { publicationId: pub, releaseId: release, persist: true }),
      classifyPublicationVersionLexically(pools[2]!, { publicationVersionId: ver, taxonomyReleaseId: release }),
      matchPublicationByTaxonomy(pools[3]!, { tenantId: tenant, monitoringProfileId: profile, publicationVersionId: ver }),
      (async () => {
        const c = await pools[4]!.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL ROLE radar_taxonomy_curator');
          await c.query('SELECT public.publication_scope_lock_curator_version($1)', [ver]);
          assert.fail('curation must not proceed after SUPPRESS');
        } finally { await c.query('ROLLBACK'); c.release(); }
      })(),
    ].map(p => p.then(value => ({ value }), error => ({ error })));
    await Promise.all(names.map(name => waitBlocked(admin, name)));
    await suppressor.query('COMMIT');
    const outcomes = await Promise.all(pending) as Array<{value?: unknown; error?: Error}>;
    for (const index of [0, 1, 2, 4]) assert.equal(outcomes[index]!.error?.message, 'PUBLICATION_OUT_OF_SCOPE');
    assert.equal((outcomes[3]!.value as { disposition: string }).disposition, 'SKIPPED_PUBLICATION_OUT_OF_SCOPE');
    const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM publication_ncm_scans WHERE publication_version_id=$1) ncm,
      (SELECT count(*)::int FROM publication_taxonomy_runs WHERE publication_version_id=$1) classification,
      (SELECT count(*)::int FROM company_publications WHERE publication_id=$2) matching,
      (SELECT count(*)::int FROM publication_taxonomy_curator_tags WHERE publication_version_id=$1) curator`, [ver, pub]);
    assert.deepEqual(counts.rows[0], { ncm: 1, classification: 0, matching: 0, curator: 0 });
    const restored = await admin.query(transition, [pub, 'RESTORE', randomUUID(), suppressed.rows[0].event_id, hash(pub)]);

    // Opposite ordering: an NCM writer already holding SHARE must finish
    // before SUPPRESS commits; a subsequent scan is rejected.
    let unlock!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    releaseWriter = unlock;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const writer = ncmDb.transaction().execute(async trx => {
      await persistSuccessfulScan(trx, row, 'CONTENT_TEXT', []);
      locked();
      await barrier;
    });
    await Promise.race([ready, writer]);
    await suppressor.query('BEGIN');
    await suppressor.query(`SET LOCAL application_name = 'scope-suppress-${suffix}'`);
    const racing = suppressor.query(transition, [pub, 'SUPPRESS', randomUUID(), restored.rows[0].event_id, hash(pub)]);
    racing.catch(() => undefined);
    try { await waitBlocked(admin, `scope-suppress-${suffix}`); }
    finally { unlock(); }
    await writer;
    const final = await racing;
    await suppressor.query('COMMIT');
    await assert.rejects(ncmDb.transaction().execute(trx => persistSuccessfulScan(trx, row, 'CONTENT_TEXT', [])), /PUBLICATION_OUT_OF_SCOPE/);
    await admin.query(transition, [pub, 'RESTORE', randomUUID(), final.rows[0].event_id, hash(pub)]);
  } finally {
    releaseWriter();
    if (suppressor) { await suppressor.query('ROLLBACK').catch(() => undefined); suppressor.release(); }
    await Promise.allSettled(pending);
    await ncmDb.destroy(); await classifyDb.destroy();
    await Promise.all(pools.slice(2).map(pool => pool.end()));
    await admin.end();
  }
});
