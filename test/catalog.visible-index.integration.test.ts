import assert from 'node:assert/strict';
import test from 'node:test';

import { sql } from 'kysely';

import { visiblePublicationSql } from '../src/api/routes/catalog-monitoring.route.js';
import { buildApp } from '../src/app.js';

// Guards the coupling between visiblePublicationSql and the partial index
// from migrations/028: if either predicate changes without the other,
// PostgreSQL silently stops using the index and every catalog request goes
// back to scanning and sorting the whole publications table.
test('catalog visibility predicate is served by ix_publications_visible_order', async () => {
  const app = await buildApp();

  try {
    await app.ready();

    const plans = await app.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx);
      await sql`SET LOCAL enable_bitmapscan = off`.execute(trx);

      const count = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN (COSTS OFF)
        SELECT count(*)
        FROM publications p
        WHERE ${visiblePublicationSql}
      `.execute(trx);

      const page = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN (COSTS OFF)
        SELECT p.id
        FROM publications p
        WHERE ${visiblePublicationSql}
        ORDER BY
          p.published_on DESC NULLS LAST,
          p.first_collected_at DESC
        LIMIT 25
      `.execute(trx);

      return [count, page].map((result) =>
        result.rows.map((row) => row['QUERY PLAN']).join('\n'),
      );
    });

    for (const plan of plans) {
      assert.match(plan, /ix_publications_visible_order/, plan);
    }

    assert.doesNotMatch(plans[1]!, /\bSort\b/, plans[1]);
  } finally {
    await app.close();
  }
});
