import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { sql, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs } from 'kysely';
import type { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  classifySinglePublication,
  processPublicationTaxonomyBatch,
  resetClassificationConceptCache,
} from '../src/modules/taxonomy/classification/classification.worker.js';
import { processPublicationNcmEnrichmentBatch } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';
import { seedTestLegalScopeAttestation } from './legal-scope-attestation.fixture.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('worker barrier timed out')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Stage = 'ncm' | 'taxonomy';

/** Test-only barrier AFTER the real SELECT, before either worker can persist.
 * No production hooks, sleeps, fake rows, or database/pool behavior changes.
 * Faults occur after a real read inside the worker's normal error boundary.
 */
class WorkerProbe implements KyselyPlugin {
  private readonly queries = new WeakMap<object, string>();
  readonly selected = signal();
  readonly proceed = signal();
  selectedIds: unknown[] = [];
  workReads = 0;
  fail = false;
  stage: Stage | null = null;

  transformQuery(args: PluginTransformQueryArgs) {
    const query = args.node.kind === 'RawNode' ? args.node.sqlFragments.join(' ') : '';
    this.queries.set(args.queryId, query);
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs) {
    const query = this.queries.get(args.queryId) ?? '';
    const selection = this.stage === 'ncm'
      ? query.includes('LEFT JOIN publication_ncm_scans pns')
      : this.stage === 'taxonomy' && query.includes('LEFT JOIN publication_taxonomy_scans s');
    if (selection) {
      this.selectedIds = args.result.rows.map((row) => row.publication_version_id);
      this.selected.resolve();
      await bounded(this.proceed.promise);
    }
    const work = this.stage === 'ncm'
      ? query.includes('FROM official_catalog_entries oce')
      : this.stage === 'taxonomy' && query.includes('SELECT DISTINCT ncm_code');
    if (work) {
      this.workReads += 1;
      if (this.fail) throw new Error(`controlled ${this.stage} worker failure`);
    }
    return args.result;
  }
}

/** Runs inside the dedicated TAX-11 CI gate, reusing its published rice/NCM
 * fixture and runtime role. Fixture versions are retired after each check so
 * global batch selection cannot pick up another concurrency check's work.
 */
export async function checkWorkerConcurrency(
  t: TestContext,
  admin: Pool,
  connectionString: string,
  releaseId: string,
): Promise<void> {
  async function scenario(
    stage: Stage,
    order: 'both-success' | 'success-first' | 'failure-first',
  ) {
    const fixture = await admin.query<{ id: string }>(
      `INSERT INTO publications (identity_hash, identity_strength, identity_basis,
         jurisdiction_level, title, published_on)
       VALUES ($1, 'STRONG', '{}', 'FEDERAL', 'Worker concurrency fixture', '9999-12-31') RETURNING id`,
      [createHash('sha256').update(randomUUID()).digest('hex')],
    );
    // No lexical rice label: the resulting product.rice tag must come from NCM.
    const content = 'Operação com NCM 1006.30.11. Repete 1006.30.11.';
    const version = await admin.query<{ id: string }>(
      `INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text, source_metadata, is_current)
       VALUES ($1, 1, $2, $3, $4::jsonb, true) RETURNING id`,
      [fixture.rows[0]!.id, createHash('sha256').update(content).digest('hex'), content,
       JSON.stringify({presentation: {format: 'SANITIZED_HTML', html: '<p data-legal-status="current">' + content + '</p>'}})],
    );
    const versionId = version.rows[0]!.id;
    await seedTestLegalScopeAttestation(admin, versionId);
    const probes = [new WorkerProbe(), new WorkerProbe()];
    const workers = probes.map((probe) => createStandaloneDatabase({
      connectionString, poolMax: 1, idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000,
    }).withPlugin(probe));
    const pending: Promise<unknown>[] = [];

    const ncmSeal = async () => (await admin.query(
      `SELECT status, source_field, candidate_count, match_count, error_message, scanned_at
       FROM publication_ncm_scans WHERE publication_version_id = $1`, [versionId],
    )).rows;
    const taxonomySeal = async () => (await admin.query(
      `SELECT status, run_id, assertion_count, attempt_count, error_message, scanned_at
       FROM publication_taxonomy_scans WHERE publication_version_id = $1 AND taxonomy_release_id = $2`,
      [versionId, releaseId],
    )).rows;
    const batch = (index: number) => stage === 'ncm'
      ? processPublicationNcmEnrichmentBatch(workers[index]!, { limit: 1 })
      : processPublicationTaxonomyBatch(workers[index]!, { limit: 1 });

    try {
      const identities = await Promise.all(workers.map((worker) => sql<{
        pid: number; role: string;
      }>`SELECT pg_backend_pid() AS pid, current_user AS role`.execute(worker)));
      assert.notEqual(identities[0]!.rows[0]!.pid, identities[1]!.rows[0]!.pid);
      assert.ok(identities.every((result) => result.rows[0]?.role === 'radar_worker_runtime'));
      if (stage === 'taxonomy') {
        const enriched = await processPublicationNcmEnrichmentBatch(workers[0]!, { limit: 1 });
        assert.equal(enriched.succeeded, 1);
      }
      probes.forEach((probe) => { probe.stage = stage; });
      probes[1]!.fail = order !== 'both-success';

      const tasks = [batch(0), batch(1)];
      pending.push(...tasks);
      // Attach rejection handlers while the test waits at the barrier.
      void Promise.allSettled(tasks);
      await bounded(Promise.all(probes.map((probe) => probe.selected.promise)));
      assert.deepEqual(probes.map((probe) => probe.selectedIds), [[versionId], [versionId]],
        'both independent workers selected the SAME version before either persisted');

      if (order === 'both-success') {
        probes.forEach((probe) => probe.proceed.resolve());
      } else {
        const first = order === 'success-first' ? 0 : 1;
        probes[first]!.proceed.resolve();
        const firstResult = await bounded(tasks[first]!);
        assert.equal(firstResult[order === 'success-first' ? 'succeeded' : 'failed'], 1);
        const before = await (stage === 'ncm' ? ncmSeal() : taxonomySeal());
        assert.equal(before[0]?.status, order === 'success-first' ? 'SUCCESS' : 'FAILED');

        if (stage === 'ncm' && order === 'failure-first') {
          const preview = await classifySinglePublication(workers[1]!, {
            publicationId: fixture.rows[0]!.id, releaseId, persist: false,
          });
          assert.equal(preview.ncmScanned, false);
          assert.equal(preview.tags.some((tag) => tag.conceptCode === 'product.rice'), false);
          await assert.rejects(classifySinglePublication(workers[1]!, {
            publicationId: fixture.rows[0]!.id, releaseId, persist: true,
          }), /NCM_SCAN_NOT_SUCCESS/);
          await processPublicationTaxonomyBatch(workers[1]!, { limit: 1 });
          assert.deepEqual(await taxonomySeal(), [], 'no definitive seal while NCM failed');
        }

        probes[1 - first]!.proceed.resolve();
        await bounded(tasks[1 - first]!);
        if (order === 'success-first') {
          assert.deepEqual(await (stage === 'ncm' ? ncmSeal() : taxonomySeal()), before,
            'late failure changes neither SUCCESS metadata, timestamp, nor attempt_count');
        }
      }

      const results = await bounded(Promise.all(tasks));
      assert.deepEqual(results.map((result) => result.selected), [1, 1]);
      assert.equal(results.reduce((sum, result) => sum + result.succeeded, 0), order === 'both-success' ? 2 : 1);
      assert.equal(results.reduce((sum, result) => sum + result.failed, 0), order === 'both-success' ? 0 : 1);
      assert.deepEqual(probes.map((probe) => probe.workReads), [1, 1], 'measure two work attempts for one version');
      probes.forEach((probe) => { probe.stage = null; });

      const mentions = await admin.query(
        `SELECT ncm_code, metadata->>'occurrenceCount' AS occurrences
         FROM publication_ncm_mentions WHERE publication_version_id = $1`, [versionId],
      );
      assert.deepEqual(mentions.rows, [{ ncm_code: '10063011', occurrences: '2' }]);
      const ncm = await ncmSeal();
      assert.equal(ncm.length, 1);
      assert.equal(ncm[0]?.status, 'SUCCESS');
      assert.equal(ncm[0]?.match_count, 1);
      assert.equal(ncm[0]?.candidate_count, 1);
      assert.equal(ncm[0]?.error_message, null);
      if (stage === 'ncm') {
        assert.equal(results.reduce((sum, result) => sum + ('matches' in result ? result.matches : 0), 0), 1,
          'only one physical mention inserted, even with duplicate successful work');
        const classified = await processPublicationTaxonomyBatch(workers[0]!, { limit: 1 });
        assert.equal(classified.succeeded, 1, 'classification resumes after real NCM recovery');
      }
      const seals = await taxonomySeal();
      assert.equal(seals.length, 1);
      assert.equal(seals[0]?.status, 'SUCCESS');
      assert.equal(seals[0]?.error_message, null);
      assert.equal(seals[0]?.attempt_count, stage === 'ncm' || order === 'success-first' ? 1 : 2);
      const artifacts = await admin.query(
        `SELECT r.id, c.code, a.reason_code, count(s.id)::int AS spans
         FROM publication_taxonomy_runs r
         JOIN publication_taxonomy_assertions a ON a.run_id = r.id
         JOIN taxonomy_release_concepts rc ON rc.id = a.release_concept_id
         JOIN taxonomy_concepts c ON c.id = rc.concept_id
         JOIN publication_taxonomy_spans s ON s.assertion_id = a.id
         WHERE r.publication_version_id = $1 AND r.taxonomy_release_id = $2
         GROUP BY r.id, c.code, a.reason_code`, [versionId, releaseId],
      );
      assert.deepEqual(artifacts.rows.map(({ code, reason_code, spans }) => ({ code, reason_code, spans })),
        [{ code: 'product.rice', reason_code: 'OFFICIAL_CODE_NCM', spans: 1 }]);
      assert.equal(artifacts.rows[0]?.id, seals[0]?.run_id);
      const runs = await admin.query(
        `SELECT count(*)::int AS n FROM publication_taxonomy_runs
         WHERE publication_version_id = $1 AND taxonomy_release_id = $2`, [versionId, releaseId],
      );
      assert.equal(runs.rows[0]?.n, 1, 'one fingerprint/run and one assertion despite overlapping workers');
      await Promise.all(workers.map((worker) => processPublicationTaxonomyBatch(worker, { limit: 1 })));
      assert.deepEqual(await taxonomySeal(), seals, 'SUCCESS is not selected again and attempts do not grow');
    } finally {
      probes.forEach((probe) => probe.proceed.resolve());
      await Promise.allSettled(pending);
      await Promise.all(workers.map((worker) => worker.destroy()));
      await admin.query('UPDATE publication_versions SET is_current = false WHERE id = $1', [versionId]);
    }
  }

  resetClassificationConceptCache();
  for (const stage of ['ncm', 'taxonomy'] as const) {
    for (const order of ['both-success', 'success-first', 'failure-first'] as const) {
      await t.test(`WORKER-CONC-01 ${stage}: two pools, ${order}`, { timeout: 30_000 }, () => scenario(stage, order));
    }
  }
}
