import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { writeBaselineAudit } from './baseline.audit.js';
import { planBaselinePersistence } from './baseline.planner.js';
import {
  createBaselineRelease,
  ensureBaselineIdentities,
  persistAliases,
  persistRelations,
  persistReleaseMemberships,
} from './baseline.repository.js';
import {
  assertBaselineSemanticReadback,
  readBaselineState,
} from './baseline.readback.js';
import type {
  ImportResult,
} from './baseline.types.js';
import {
  loadBaseline,
  type LoadedBaseline,
} from './baseline.source-reader.js';

export interface BaselineImportOptions {
  expectedManifestSha256: string;
  failAfterStep?:
    | 'IDENTITIES'
    | 'RELEASE'
    | 'MEMBERSHIPS'
    | 'ALIASES'
    | 'RELATIONS';
  holdAfterLockMs?: number;
}

function lockKey(targetVersion: string): string {
  const digest = createHash('sha256')
    .update(
      'tribusca:taxonomy-baseline:' + targetVersion,
      'utf8',
    )
    .digest();

  return digest.readBigInt64BE(0).toString();
}

async function acquireLock(
  client: PoolClient,
  targetVersion: string,
): Promise<void> {
  const result = await client.query<{
    acquired: boolean;
  }>(
    'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired',
    [lockKey(targetVersion)],
  );

  if (!result.rows[0]?.acquired) {
    throw new Error('BASELINE_IMPORT_IN_PROGRESS');
  }
}

function assertReadback(
  loaded: LoadedBaseline,
  readback: Awaited<ReturnType<typeof readBaselineState>>,
): void {
  const expected = loaded.manifest.expected;

  const checks: Array<[string, unknown, unknown]> = [
    ['dimensions', readback.dimensions, expected.dimensions],
    ['concepts', readback.concepts, expected.concepts],
    [
      'needsEvidence',
      readback.needsEvidence,
      expected.needsEvidence,
    ],
    [
      'lexicalAliases',
      readback.lexicalAliases,
      expected.lexicalAliasCount,
    ],
    [
      'aliasBindings',
      readback.aliasBindings,
      expected.aliasBindingCount,
    ],
    ['relationTypes', readback.relationTypes, 7],
    [
      'relationRules',
      readback.relationRules,
      loaded.manifest.relationRules.length,
    ],
    [
      'relations',
      readback.relations,
      loaded.manifest.relations.length,
    ],
    [
      'creditAliasIdentities',
      readback.creditAliasIdentities,
      1,
    ],
    [
      'creditAmbiguousBindings',
      readback.creditAmbiguousBindings,
      3,
    ],
    ['forbiddenMit', readback.forbiddenMit, 0],
    ['releaseVersion', readback.releaseVersion, 'v1.0.0'],
    ['releaseStatus', readback.releaseStatus, 'DRAFT'],
    [
      'manifestSha256',
      readback.manifestSha256,
      loaded.manifestSha256,
    ],
    [
      'derivationFingerprint',
      readback.derivationFingerprint,
      loaded.manifest.derivation.fingerprint,
    ],
  ];

  const failures = checks.filter(
    ([, actual, wanted]) => actual !== wanted,
  );

  if (failures.length > 0) {
    throw new Error(
      'BASELINE_READBACK_MISMATCH: ' +
        JSON.stringify(failures),
    );
  }
}

async function auditFailure(
  pool: Pool,
  correlationId: string,
  loaded: LoadedBaseline,
  error: unknown,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SET LOCAL ROLE radar_taxonomy_curator',
    );
    await writeBaselineAudit(client, {
      action: 'BASELINE_IMPORT_FAILED',
      correlationId,
      payload: {
        targetVersion:
          loaded.manifest.targetTaxonomyVersion,
        manifestSha256: loaded.manifestSha256,
        derivationFingerprint:
          loaded.manifest.derivation.fingerprint,
        errorCode:
          error instanceof Error
            ? error.message.split(':')[0]
            : 'UNKNOWN_ERROR',
      },
    });
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    client.release();
  }
}

function injectFailure(
  options: BaselineImportOptions,
  step: NonNullable<BaselineImportOptions['failAfterStep']>,
): void {
  if (options.failAfterStep === step) {
    throw new Error(
      'BASELINE_TEST_FAILURE_INJECTION: ' + step,
    );
  }
}

async function reverifyBaseline(
  loaded: LoadedBaseline,
  expectedManifestSha256: string,
): Promise<void> {
  const verified = await loadBaseline();

  if (
    verified.manifestSha256 !== expectedManifestSha256 ||
    verified.manifestSha256 !== loaded.manifestSha256 ||
    verified.manifest.derivation.fingerprint !==
      loaded.manifest.derivation.fingerprint
  ) {
    throw new Error(
      'NON_DETERMINISTIC_DERIVATION: baseline changed between preflight and locked import',
    );
  }
}

export async function importBaseline(
  pool: Pool,
  loaded: LoadedBaseline,
  options: BaselineImportOptions,
): Promise<ImportResult> {
  if (
    options.expectedManifestSha256 !==
    loaded.manifestSha256
  ) {
    throw new Error(
      'MANIFEST_INTEGRITY_FAILURE: expected hash does not match generated manifest',
    );
  }

  const correlationId = randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    );
    await client.query(
      'SET LOCAL ROLE radar_taxonomy_curator',
    );
    await acquireLock(
      client,
      loaded.manifest.targetTaxonomyVersion,
    );

    await reverifyBaseline(
      loaded,
      options.expectedManifestSha256,
    );

    if ((options.holdAfterLockMs ?? 0) > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.holdAfterLockMs),
      );
    }

    const plan = await planBaselinePersistence(
      client,
      loaded.manifest,
      loaded.manifestSha256,
    );

    if (
      plan.releaseAction ===
      'IDEMPOTENT_EXISTING_RELEASE'
    ) {
      const existingRelease = await client.query<{
        id: string;
      }>(
        [
          'SELECT id',
          'FROM taxonomy_releases',
          'WHERE version_major = 1',
          '  AND version_minor = 0',
          '  AND version_patch = 0',
        ].join('\n'),
      );
      const releaseId = existingRelease.rows[0]?.id;

      if (!releaseId) {
        throw new Error(
          'BASELINE_PERSISTENCE_FAILURE: idempotent release disappeared',
        );
      }

      const readback = await readBaselineState(client);
      assertReadback(loaded, readback);
      await assertBaselineSemanticReadback(
        client,
        loaded.manifest,
        releaseId,
      );
      await client.query('COMMIT');

      return {
        status: 'IDEMPOTENT_ALREADY_IMPORTED',
        releaseId,
        readback,
      };
    }

    if (
      plan.releaseAction === 'VERSION_CONFLICT' ||
      plan.conflicts.length > 0
    ) {
      const code = plan.conflicts.includes(
        'NON_DETERMINISTIC_DERIVATION',
      )
        ? 'NON_DETERMINISTIC_DERIVATION'
        : 'TARGET_VERSION_ALREADY_BOUND';

      throw new Error(
        code + ': ' + plan.conflicts.join('; '),
      );
    }

    await writeBaselineAudit(client, {
      action: 'BASELINE_IMPORT_STARTED',
      correlationId,
      payload: {
        targetVersion:
          loaded.manifest.targetTaxonomyVersion,
        manifestSha256: loaded.manifestSha256,
        derivationFingerprint:
          loaded.manifest.derivation.fingerprint,
      },
    });

    const identities = await ensureBaselineIdentities(
      client,
      loaded.manifest,
    );
    injectFailure(options, 'IDENTITIES');

    const releaseId = await createBaselineRelease(
      client,
      loaded.manifest,
      loaded.manifestSha256,
    );
    injectFailure(options, 'RELEASE');

    await writeBaselineAudit(client, {
      action: 'TAXONOMY_RELEASE_CREATED',
      correlationId,
      releaseId,
      payload: {
        version: 'v1.0.0',
        status: 'DRAFT',
      },
    });

    const releaseConceptIds =
      await persistReleaseMemberships(
        client,
        loaded.manifest,
        {
          releaseId,
          dimensionIds: identities.dimensionIds,
          dimensionRevisionIds:
            identities.dimensionRevisionIds,
          conceptIds: identities.conceptIds,
          conceptRevisionIds:
            identities.conceptRevisionIds,
        },
      );
    injectFailure(options, 'MEMBERSHIPS');

    const aliasIds = await persistAliases(
      client,
      loaded.manifest,
      releaseId,
      releaseConceptIds,
    );
    void aliasIds;
    injectFailure(options, 'ALIASES');

    await persistRelations(
      client,
      loaded.manifest,
      {
        releaseId,
        dimensionIds: identities.dimensionIds,
        releaseConceptIds,
        relationTypeIds:
          identities.relationTypeIds,
      },
    );
    injectFailure(options, 'RELATIONS');

    const readback = await readBaselineState(client);
    assertReadback(loaded, readback);
    await assertBaselineSemanticReadback(
      client,
      loaded.manifest,
      releaseId,
    );

    await writeBaselineAudit(client, {
      action: 'BASELINE_IMPORT_VALIDATED',
      correlationId,
      releaseId,
      payload: {
        manifestSha256: loaded.manifestSha256,
        counts: loaded.manifest.expected,
      },
    });
    await writeBaselineAudit(client, {
      action: 'BASELINE_IMPORT_COMMITTED',
      correlationId,
      releaseId,
      payload: {
        manifestSha256: loaded.manifestSha256,
        derivationFingerprint:
          loaded.manifest.derivation.fingerprint,
      },
    });

    await client.query('COMMIT');

    return {
      status: 'SUCCESS',
      releaseId,
      readback,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await auditFailure(
      pool,
      correlationId,
      loaded,
      error,
    );
    throw error;
  } finally {
    client.release();
  }
}
