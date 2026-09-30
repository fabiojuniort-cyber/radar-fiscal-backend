import type { Pool } from 'pg';

import { planBaselinePersistence } from './baseline.planner.js';
import type {
  BaselineDryRunReport,
} from './baseline.types.js';
import type {
  LoadedBaseline,
} from './baseline.source-reader.js';

export async function dryRunBaseline(
  pool: Pool,
  loaded: LoadedBaseline,
): Promise<BaselineDryRunReport> {
  const client = await pool.connect();

  try {
    await client.query(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );

    const plan = await planBaselinePersistence(
      client,
      loaded.manifest,
      loaded.manifestSha256,
    );

    await client.query('ROLLBACK');

    return {
      readiness:
        plan.releaseAction === 'VERSION_CONFLICT' ||
        plan.conflicts.length > 0
          ? 'BLOCKED'
          : 'READY',
      sourceIntegrity: 'PASS',
      counts: {
        dimensions: loaded.manifest.dimensions.length,
        concepts: loaded.manifest.concepts.length,
        needsEvidence:
          loaded.manifest.expected.needsEvidence,
        lexicalAliases:
          loaded.manifest.expected.lexicalAliasCount,
        aliasBindings:
          loaded.manifest.expected.aliasBindingCount,
        multiBindAliases:
          loaded.manifest.expected
            .multiBindLexicalAliasCount,
      },
      validationIssues: [],
      plan,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
