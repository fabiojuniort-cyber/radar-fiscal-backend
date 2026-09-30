import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  decideTaxonomyCandidate,
  recordUnmappedOccurrence,
} from '../src/modules/taxonomy/candidates/candidate.service.js';

const sha = (value: string): string =>
  createHash('sha256')
    .update(value)
    .digest('hex');

test('TAX-08 preserves UNMAPPED history, MIT negative case and human terminal gate', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL;

  assert.ok(
    adminUrl,
    'DATABASE_ADMIN_URL is required',
  );

  const pool = new Pool({
    connectionString: adminUrl,
    max: 2,
  });

  try {
    const suffix = randomUUID()
      .replaceAll('-', '')
      .slice(0, 12);

    const publicationId = randomUUID();
    const publicationVersionId =
      randomUUID();
    const releaseId = randomUUID();
    const runId = randomUUID();
    const versionMajor =
      980000 +
      (
        Number.parseInt(
          suffix.slice(0, 5),
          16,
        ) %
        10000
      );

    await pool.query(
      [
        'INSERT INTO publications (',
        'id, identity_hash, identity_strength, identity_basis, jurisdiction_level, title',
        ') VALUES ($1,$2,',
        "'SOURCE_SCOPED','{}'::jsonb,'FEDERAL','TAX-08 MIT fixture')",
      ].join(' '),
      [
        publicationId,
        sha('tax08-pub-' + suffix),
      ],
    );

    await pool.query(
      [
        'INSERT INTO publication_versions (',
        'id, publication_id, version_no, content_hash, content_text',
        ') VALUES ($1,$2,1,$3,$4)',
      ].join(' '),
      [
        publicationVersionId,
        publicationId,
        sha(
          'tax08-content-' + suffix,
        ),
        'O texto oficial menciona MIT sem definição taxonômica aprovada.',
      ],
    );

    await pool.query(
      [
        'INSERT INTO taxonomy_releases (',
        'id, version_major, version_minor, version_patch, status,',
        'approved_at, published_at, artifact_repository, artifact_path,',
        'artifact_git_sha, artifact_sha256, created_by_actor',
        ') VALUES (',
        "$1,$2,0,0,'PUBLISHED',now(),now(),'tax08-test','fixture',$3,$4,'tax08-test'",
        ')',
      ].join(' '),
      [
        releaseId,
        versionMajor,
        'a'.repeat(40),
        'b'.repeat(64),
      ],
    );

    await pool.query(
      [
        'INSERT INTO publication_taxonomy_runs (',
        'id, publication_version_id, taxonomy_release_id, method_type,',
        'engine_key, engine_version, config_snapshot, config_sha256,',
        'input_sha256, run_fingerprint, status, started_at, finished_at',
        ') VALUES (',
        "$1,$2,$3,'EXTRACTOR','tax08-unmapped-test','1','{}'::jsonb,$4,$5,$6,",
        "'SUCCESS',now(),now())",
      ].join(' '),
      [
        runId,
        publicationVersionId,
        releaseId,
        sha('{}'),
        sha('MIT'),
        sha(
          'tax08-run-' + suffix,
        ),
      ],
    );

    const request = {
      runId,
      rawTerm: 'MIT',
      contextExcerpt:
        'O texto oficial menciona MIT sem definição taxonômica aprovada.',
      spanStart: 25,
      spanEnd: 28,
      extractorKey:
        'tax08-test-extractor',
      extractorVersion: '1',
      jurisdictionMetadata: {
        sphere: 'FEDERAL',
      },
      confidence: 0.8,
    } as const;

    const first =
      await recordUnmappedOccurrence(
        pool,
        request,
      );

    assert.equal(
      first.occurrenceDisposition,
      'CREATED',
    );
    assert.equal(
      first.candidateDisposition,
      'CREATED',
    );

    const rerun =
      await recordUnmappedOccurrence(
        pool,
        request,
      );

    assert.equal(
      rerun.occurrenceDisposition,
      'EXISTING',
    );
    assert.equal(
      rerun.candidateDisposition,
      'EXISTING',
    );
    assert.equal(
      rerun.occurrenceId,
      first.occurrenceId,
    );
    assert.equal(
      rerun.candidateId,
      first.candidateId,
    );

    const candidate =
      await pool.query<{
        normalized_key: string;
        status: string;
        decision_actor_id: string | null;
      }>(
        [
          'SELECT normalized_key, status, decision_actor_id',
          'FROM taxonomy_candidates',
          'WHERE id = $1',
        ].join(' '),
        [first.candidateId],
      );

    assert.deepEqual(
      candidate.rows[0],
      {
        normalized_key: 'mit',
        status: 'NEW',
        decision_actor_id: null,
      },
    );

    const links =
      await pool.query<{
        n: number;
      }>(
        [
          'SELECT count(*)::int AS n',
          'FROM taxonomy_candidate_occurrence_links',
          'WHERE occurrence_id = $1',
          "AND link_status = 'ACTIVE'",
        ].join(' '),
        [first.occurrenceId],
      );

    assert.equal(
      links.rows[0]?.n,
      1,
    );

    const forbiddenMitConcepts =
      await pool.query<{
        n: number;
      }>(
        [
          'SELECT count(*)::int AS n',
          'FROM taxonomy_concepts',
          'WHERE code IN (',
          "'platform.mit','obligation.mit','bookkeeping.mit'",
          ") OR code ~ '\\.mit$'",
        ].join(' '),
      );

    assert.equal(
      forbiddenMitConcepts.rows[0]?.n,
      0,
    );

    const worker = await pool.connect();

    try {
      await worker.query('BEGIN');
      await worker.query(
        'SET LOCAL ROLE radar_worker',
      );

      await assert.rejects(
        worker.query(
          [
            'UPDATE taxonomy_candidates',
            "SET status = 'REJECTED',",
            "decision_actor_id = 'worker-test',",
            'decision_at = now(),',
            "decision_reason = 'worker must not decide'",
            'WHERE id = $1',
          ].join(' '),
          [first.candidateId],
        ),
        /permission denied/,
      );

      await worker.query('ROLLBACK');
    } finally {
      worker.release();
    }

    await decideTaxonomyCandidate(
      pool,
      {
        candidateId:
          first.candidateId,
        status: 'REJECTED',
        actorId:
          'tax08-human-curator',
        reason:
          'MIT remains unmapped until formal taxonomy governance decides otherwise.',
      },
    );

    const decided =
      await pool.query<{
        status: string;
        decision_actor_id: string;
      }>(
        [
          'SELECT status, decision_actor_id',
          'FROM taxonomy_candidates',
          'WHERE id = $1',
        ].join(' '),
        [first.candidateId],
      );

    assert.equal(
      decided.rows[0]?.status,
      'REJECTED',
    );
    assert.equal(
      decided.rows[0]
        ?.decision_actor_id,
      'tax08-human-curator',
    );

    await assert.rejects(
      decideTaxonomyCandidate(
        pool,
        {
          candidateId:
            first.candidateId,
          status:
            'APPROVED_NEW_CONCEPT',
          actorId:
            'tax08-human-curator',
          reason:
            'terminal state must remain immutable',
        },
      ),
      /terminal taxonomy candidate is immutable/,
    );

    const secondRunId = randomUUID();
    await pool.query(
      [
        'INSERT INTO publication_taxonomy_runs (',
        'id, publication_version_id, taxonomy_release_id, method_type,',
        'engine_key, engine_version, config_snapshot, config_sha256,',
        'input_sha256, run_fingerprint, status, started_at, finished_at',
        ') VALUES (',
        "$1,$2,$3,'EXTRACTOR','tax08-unmapped-test','1','{}'::jsonb,$4,$5,$6,",
        "'SUCCESS',now(),now())",
      ].join(' '),
      [
        secondRunId,
        publicationVersionId,
        releaseId,
        sha('{}'),
        sha('MIT-second-observation'),
        sha(
          'tax08-run-second-' + suffix,
        ),
      ],
    );

    const afterTerminal =
      await recordUnmappedOccurrence(
        pool,
        {
          ...request,
          runId: secondRunId,
        },
      );

    assert.equal(
      afterTerminal.occurrenceDisposition,
      'CREATED',
    );
    assert.equal(
      afterTerminal.candidateDisposition,
      'EXISTING',
    );
    assert.equal(
      afterTerminal.candidateId,
      first.candidateId,
    );
    assert.notEqual(
      afterTerminal.occurrenceId,
      first.occurrenceId,
    );

    const terminalAfterObservation =
      await pool.query<{
        status: string;
        decision_actor_id: string;
        decision_reason: string;
        decision_at: Date;
      }>(
        [
          'SELECT status, decision_actor_id, decision_reason, decision_at',
          'FROM taxonomy_candidates',
          'WHERE id = $1',
        ].join(' '),
        [first.candidateId],
      );

    assert.equal(
      terminalAfterObservation.rows[0]?.status,
      'REJECTED',
    );
    assert.equal(
      terminalAfterObservation.rows[0]
        ?.decision_actor_id,
      'tax08-human-curator',
    );
    assert.equal(
      terminalAfterObservation.rows[0]
        ?.decision_reason,
      'MIT remains unmapped until formal taxonomy governance decides otherwise.',
    );
    assert.ok(
      terminalAfterObservation.rows[0]
        ?.decision_at,
    );

    const secondActiveLink =
      await pool.query<{
        n: number;
      }>(
        [
          'SELECT count(*)::int AS n',
          'FROM taxonomy_candidate_occurrence_links',
          'WHERE occurrence_id = $1',
          "AND link_status = 'ACTIVE'",
        ].join(' '),
        [afterTerminal.occurrenceId],
      );

    assert.equal(
      secondActiveLink.rows[0]?.n,
      1,
    );
  } finally {
    await pool.end();
  }
});
