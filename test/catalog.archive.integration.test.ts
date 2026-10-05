import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Acervo-Test-2026!Safe';

interface ArchiveBody {
  totalItems: number;
  totalIsCapped: boolean;
  items: Array<{ id: string; title: string; sourceCode: string | null }>;
}

test('Acervo search, source filter and source feed maintenance', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  // Letters only: one token that every seeded title carries.
  const marker =
    'acervo' +
    randomUUID()
      .replace(/[^a-f]/g, '')
      .slice(0, 10);
  const contentWord = marker + 'conteudo';
  const email = `acervo-${randomUUID()}@example.test`;

  try {
    await app.ready();

    for (const code of ['dou', 'confaz', 'sped']) {
      await admin.query(
        `INSERT INTO sources (code, name, jurisdiction_level, base_url, connector_key, is_active)
         VALUES ($1, upper($1), 'FEDERAL', 'https://example.invalid/' || $1, 'acervo-test-' || $1, false)
         ON CONFLICT DO NOTHING`,
        [code],
      );
    }
    const sourceRows = await admin.query<{ id: string; code: string }>(
      `SELECT id, code FROM sources WHERE code IN ('dou', 'confaz', 'sped')`,
    );
    const source = Object.fromEntries(
      sourceRows.rows.map((row) => [row.code, row.id]),
    ) as Record<'dou' | 'confaz' | 'sped', string>;

    async function publication(
      key: string,
      actType: string,
      title: string,
      origins: Array<'dou' | 'confaz' | 'sped'>,
      content = 'Texto do ato.',
    ): Promise<string> {
      const id = randomUUID();
      const hash = createHash('sha256').update(id).digest('hex');
      await admin.query(
        `INSERT INTO publications (id, identity_hash, identity_strength, identity_basis,
           jurisdiction_level, act_type, title, published_on)
         VALUES ($1, $2, 'STRONG', '{}'::jsonb, 'FEDERAL', $3, $4, current_date)`,
        [id, hash, actType, title],
      );
      await admin.query(
        `INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text)
         VALUES ($1, 1, $2, $3)`,
        [id, hash, content],
      );
      for (const [index, code] of origins.entries()) {
        await admin.query(
          `INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, first_seen_at)
           VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
          [id, source[code], `${key}-${code}-${id}`, `https://example.invalid/${id}/${code}`, index],
        );
      }
      return id;
    }

    const convenio = await publication('a', 'Convênio ICMS', `Convênio ICMS 12/2026 ${marker}`, ['dou']);
    const portaria1216 = await publication('b', 'Portaria', `Portaria 1216 sobre tributos ${marker}`, ['dou', 'sped']);
    const portaria12160 = await publication('c', 'Portaria', `Portaria 12160 ${marker}`, ['sped']);
    const hidden = await publication('d', 'Aviso de Licitação', `Aviso de Licitação ${marker}`, ['dou']);
    const confazOrigin = await publication('e', 'Instrução Normativa', `Instrução Normativa ${marker}`, ['confaz']);
    const contentOnly = await publication('f', 'Ato', `Ato declaratório ${marker}`, ['dou'], `Trata de ${contentWord} especial.`);

    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Acervo Reader',
        email,
        company: `Acervo Company ${marker}`,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(register.statusCode, 201);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    const headers = {
      authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}`,
    };

    async function archive(query: string): Promise<ArchiveBody> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/archive?limit=50&${query}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ArchiveBody>();
    }

    const ids = (body: ArchiveBody) => body.items.map((item) => item.id).sort();
    const q = (text: string) => `q=${encodeURIComponent(text)}`;

    await t.test('title search excludes hidden families', async () => {
      const body = await archive(q(marker));
      assert.deepEqual(
        ids(body),
        [convenio, portaria1216, portaria12160, confazOrigin, contentOnly].sort(),
      );
      assert.equal(body.totalItems, 5);
      assert.equal(body.totalIsCapped, false);
      assert.ok(!ids(body).includes(hidden));
    });

    await t.test('numbers match exactly: 1216 does not find 12160', async () => {
      assert.deepEqual(ids(await archive(q(`Portaria 1216 ${marker}`))), [portaria1216]);
    });

    await t.test('accents are ignored and the last word matches as a prefix', async () => {
      assert.deepEqual(ids(await archive(q(`convenio ${marker}`))), [convenio]);
      assert.deepEqual(ids(await archive(q(`${marker} conv`))), [convenio]);
    });

    await t.test('full-content search is opt-in', async () => {
      assert.deepEqual(ids(await archive(`${q(contentWord)}&scope=title`)), []);
      assert.deepEqual(ids(await archive(`${q(contentWord)}&scope=full`)), [contentOnly]);
    });

    await t.test('source filter keeps the CONFAZ/DOU rule and second origins', async () => {
      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=dou`)),
        [portaria1216, contentOnly].sort(),
      );
      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=confaz`)),
        [convenio, confazOrigin].sort(),
      );
      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=sped`)),
        [portaria1216, portaria12160].sort(),
      );

      const confazItem = (await archive(q(`convenio ${marker}`))).items[0];
      assert.equal(confazItem?.sourceCode, 'confaz');
    });

    await t.test('feed follows publication and origin changes made by the worker role', async () => {
      const client = await admin.connect();
      try {
        await client.query('SET ROLE radar_worker');
        // No longer CONFAZ-typed: leaves confaz, joins dou.
        await client.query(
          `UPDATE publications SET act_type = 'Portaria', title = $2 WHERE id = $1`,
          [convenio, `Portaria convertida ${marker}`],
        );
        // New origin: appears under sped.
        await client.query(
          `INSERT INTO publication_origins (publication_id, source_id, external_id, official_url)
           VALUES ($1, $2, $3, $4)`,
          [contentOnly, source.sped, `g-${contentOnly}`, `https://example.invalid/${contentOnly}/sped2`],
        );
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
      // Origin removal (admin maintenance path): leaves sped.
      await admin.query(
        `DELETE FROM publication_origins WHERE publication_id = $1 AND source_id = $2`,
        [portaria12160, source.sped],
      );

      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=dou&page=1`)),
        [convenio, portaria1216, contentOnly].sort(),
      );
      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=confaz&page=1`)),
        [confazOrigin],
      );
      assert.deepEqual(
        ids(await archive(`${q(marker)}&source=sped&page=1`)),
        [portaria1216, contentOnly].sort(),
      );
    });

    await t.test('deleting a publication removes its feed rows', async () => {
      const before = await admin.query<{ count: string }>(
        `SELECT count(*) FROM publication_source_feed WHERE publication_id = $1`,
        [hidden],
      );
      assert.ok(Number(before.rows[0]?.count) > 0);
      await admin.query(`DELETE FROM publication_versions WHERE publication_id = $1`, [hidden]);
      await admin.query(`DELETE FROM publications WHERE id = $1`, [hidden]);
      const after = await admin.query<{ count: string }>(
        `SELECT count(*) FROM publication_source_feed WHERE publication_id = $1`,
        [hidden],
      );
      assert.equal(Number(after.rows[0]?.count), 0);
    });

    async function createSource(code: string): Promise<string> {
      const row = await admin.query<{ id: string }>(
        `INSERT INTO sources (code, name, jurisdiction_level, base_url, connector_key, is_active)
         VALUES ($1, $1, 'FEDERAL', 'https://example.invalid/' || $1, 'acervo-test-' || $1, false)
         RETURNING id`,
        [code],
      );
      return row.rows[0]!.id;
    }

    async function addOrigin(
      publicationId: string,
      sourceId: string,
      client: { query: Pool['query'] } = admin,
    ): Promise<string> {
      const row = await client.query<{ id: string }>(
        `INSERT INTO publication_origins (publication_id, source_id, external_id, official_url)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [publicationId, sourceId, randomUUID(), `https://example.invalid/${randomUUID()}`],
      );
      return row.rows[0]!.id;
    }

    async function feedOf(publicationId: string): Promise<string[]> {
      const rows = await admin.query<{ source_code: string }>(
        `SELECT source_code FROM publication_source_feed WHERE publication_id = $1 ORDER BY 1`,
        [publicationId],
      );
      return rows.rows.map((row) => row.source_code);
    }

    async function expectedFeedOf(publicationId: string): Promise<string[]> {
      const rows = await admin.query<{ source_code: string }>(
        `SELECT source_code FROM publication_source_feed_expected(ARRAY[$1::uuid]) ORDER BY 1`,
        [publicationId],
      );
      return rows.rows.map((row) => row.source_code);
    }

    await t.test('B1: CONFAZ membership does not depend on a sources row named confaz', async () => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        // Hide every confaz-coded source for this transaction only.
        await client.query(
          `UPDATE sources SET code = code || '-hidden-' || left(id::text, 8)
           WHERE lower(code) = 'confaz'`,
        );
        const id = randomUUID();
        await client.query(
          `INSERT INTO publications (id, identity_hash, identity_strength, identity_basis,
             jurisdiction_level, act_type, title, published_on)
           VALUES ($1, $2, 'STRONG', '{}'::jsonb, 'FEDERAL', 'Convênio ICMS', $3, current_date)`,
          [id, createHash('sha256').update(id).digest('hex'), `Convênio ICMS ${marker}`],
        );
        await addOrigin(id, source.dou, client);
        const feed = await client.query<{ source_code: string }>(
          `SELECT source_code FROM publication_source_feed WHERE publication_id = $1`,
          [id],
        );
        assert.deepEqual(feed.rows.map((row) => row.source_code), ['confaz']);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    await t.test('B2: case variants of a source code never duplicate a publication', async () => {
      const lower = `${marker}cs`;
      const upperId = await createSource(lower.toUpperCase());
      const lowerId = await createSource(lower);
      const id = await publication('cs', 'Portaria', `Portaria case ${marker}`, []);
      await addOrigin(id, upperId);
      await addOrigin(id, lowerId);

      assert.deepEqual(await feedOf(id), [lower]);
      for (const code of [lower, lower.toUpperCase()]) {
        const body = await archive(`${q(marker)}&source=${code}`);
        assert.deepEqual(ids(body), [id]);
        assert.equal(body.totalItems, 1);
      }

      // A fresh app has empty caches: source-only totals and cards count once.
      const fresh = await buildApp();
      try {
        await fresh.ready();
        const response = await fresh.inject({
          method: 'GET',
          url: `/api/v2/archive?source=${lower}`,
          headers,
        });
        assert.equal(response.json<ArchiveBody>().totalItems, 1);
        const cards = await fresh.inject({ method: 'GET', url: '/public/v2/sources' });
        const totals = cards
          .json<{ items: Array<{ code: string; totalPublications: number }> }>()
          .items.filter((item) => item.code.toLowerCase() === lower)
          .map((item) => item.totalPublications);
        assert.deepEqual(totals, [1, 1]);
      } finally {
        await fresh.close();
      }

      // Renaming a source re-files its publications under the new code.
      await admin.query(`UPDATE sources SET code = $2 WHERE id = $1`, [upperId, `${lower}x`]);
      assert.deepEqual(await feedOf(id), [lower, `${lower}x`]);
    });

    await t.test('B3: concurrent writers on one publication leave the authoritative feed', async () => {
      const [a, b, c, d] = await Promise.all(
        ['a', 'b', 'c', 'd'].map((suffix) => createSource(`${marker}w${suffix}`)),
      );
      const id = await publication('w', 'Portaria', `Portaria concorrente ${marker}`, []);
      const originA = await addOrigin(id, a!);
      const originB = await addOrigin(id, b!);

      const first = await admin.connect();
      const second = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await first.query('BEGIN');
        await first.query(`UPDATE publication_origins SET source_id = $2 WHERE id = $1`, [originA, c]);

        let secondDone = false;
        const secondTx = (async () => {
          const client = await second.connect();
          try {
            await client.query('BEGIN');
            await client.query(`UPDATE publication_origins SET source_id = $2 WHERE id = $1`, [originB, d]);
            await client.query('COMMIT');
          } finally {
            client.release();
            secondDone = true;
          }
        })();

        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(secondDone, false, 'second refresh must wait for the first');
        await first.query('COMMIT');
        await secondTx;
      } finally {
        first.release();
        await second.end();
      }

      const expected = [`${marker}wc`, `${marker}wd`];
      assert.deepEqual(await feedOf(id), expected);
      assert.deepEqual(await expectedFeedOf(id), expected);
    });

    await t.test('SEC-01: a temporary table cannot shadow the feed in SECURITY DEFINER code', async () => {
      const shadowSource = await createSource(`${marker}tmp`);
      const id = await publication('tmp', 'Portaria', `Portaria sombra ${marker}`, []);
      const client = await admin.connect();
      try {
        await client.query('SET ROLE radar_worker');
        await client.query(
          `CREATE TEMP TABLE publication_source_feed (
             source_code TEXT, publication_id UUID, published_on DATE,
             first_collected_at TIMESTAMPTZ, is_hidden BOOLEAN,
             PRIMARY KEY (source_code, publication_id))`,
        );
        await addOrigin(id, shadowSource, client);
        const shadow = await client.query<{ count: string }>(
          `SELECT count(*) FROM pg_temp.publication_source_feed`,
        );
        assert.equal(Number(shadow.rows[0]?.count), 0, 'trigger wrote into the temp table');
      } finally {
        await client.query('DROP TABLE IF EXISTS pg_temp.publication_source_feed');
        await client.query('RESET ROLE');
        client.release();
      }
      assert.deepEqual(await feedOf(id), [`${marker}tmp`]);
    });

    await t.test('bulk updates refresh once per statement; opposite orders wait instead of deadlocking', async () => {
      const bulkSource = await createSource(`${marker}bulk`);
      const created = await admin.query<{ id: string }>(
        `INSERT INTO publications (identity_hash, identity_strength, identity_basis,
           jurisdiction_level, act_type, title, published_on)
         SELECT md5($1 || g) || md5(g || $1), 'STRONG', '{}'::jsonb, 'FEDERAL',
                'Portaria', 'Bulk ' || g || ' ' || $1, current_date
         FROM generate_series(1, 1200) g
         RETURNING id`,
        [marker],
      );
      const bulkIds = created.rows.map((row) => row.id);
      await admin.query(
        `INSERT INTO publication_origins (publication_id, source_id, external_id, official_url)
         SELECT id, $2, 'bulk-' || id, 'https://example.invalid/bulk/' || id
         FROM unnest($1::uuid[]) AS id`,
        [bulkIds, bulkSource],
      );
      // > 1,000 rows in one statement: CONFAZ-typed now, one batch refresh.
      await admin.query(
        `UPDATE publications SET act_type = 'Convênio ICMS' WHERE id = ANY($1::uuid[])`,
        [bulkIds],
      );
      const mismatch = await admin.query<{ count: string }>(
        `SELECT count(*) FROM (
           (SELECT source_code, publication_id FROM publication_source_feed
            WHERE publication_id = ANY($1::uuid[])
            EXCEPT SELECT source_code, publication_id FROM publication_source_feed_expected($1::uuid[]))
           UNION ALL
           (SELECT source_code, publication_id FROM publication_source_feed_expected($1::uuid[])
            EXCEPT SELECT source_code, publication_id FROM publication_source_feed
            WHERE publication_id = ANY($1::uuid[]))
         ) diff`,
        [bulkIds],
      );
      assert.equal(Number(mismatch.rows[0]?.count), 0);

      // Two statements touching the same two publications in opposite order,
      // changing a feed-relevant column so both really call the refresh.
      const [first, second] = [bulkIds[0]!, bulkIds[1]!];
      const one = new Pool({ connectionString: adminUrl, max: 1 });
      const two = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await Promise.all([
          one.query(
            `UPDATE publications SET published_on = published_on - 1 WHERE id = ANY($1::uuid[])`,
            [[first, second]],
          ),
          two.query(
            `UPDATE publications SET published_on = published_on - 2 WHERE id = ANY($1::uuid[])`,
            [[second, first]],
          ),
        ]);

        // The advisory locks themselves: a refresh of [first, second] holds
        // both publications until commit; a refresh of [second, first] in
        // another transaction must wait (ids are locked in sorted order, so
        // the opposite input order cannot deadlock).
        const a = await one.connect();
        const b = await two.connect();
        try {
          await a.query('BEGIN');
          await a.query(
            'SELECT public.refresh_publication_source_feed($1::uuid[])',
            [[first, second]],
          );
          await b.query('BEGIN');
          let waited = true;
          const blocked = b
            .query('SELECT public.refresh_publication_source_feed($1::uuid[])', [[second, first]])
            .then(() => {
              waited = false;
            });
          await new Promise((resolve) => setTimeout(resolve, 300));
          assert.equal(waited, true, 'second refresh must wait');
          // ...and it waits on a per-publication advisory lock (classid
          // 28029), not merely on the feed rows the first refresh rewrote.
          const locks = await admin.query<{ held: string; waiting: string }>(
            `SELECT
               count(*) FILTER (WHERE granted) AS held,
               count(*) FILTER (WHERE NOT granted) AS waiting
             FROM pg_locks
             WHERE locktype = 'advisory' AND classid = 28029`,
          );
          assert.equal(Number(locks.rows[0]?.held), 2, 'first refresh holds one lock per publication');
          assert.equal(Number(locks.rows[0]?.waiting), 1, 'second refresh waits on an advisory lock');
          await a.query('COMMIT');
          await blocked;
          await b.query('COMMIT');
        } finally {
          a.release();
          b.release();
        }
      } finally {
        await one.end();
        await two.end();
      }
      for (const id of [first, second]) {
        assert.deepEqual(await feedOf(id), await expectedFeedOf(id));
      }
    });

    await t.test('hasMore comes from the rows, stopword-only searches are empty', async () => {
      const page1 = await app.inject({
        method: 'GET',
        url: `/api/v2/archive?limit=2&page=1&${q(marker)}`,
        headers,
      });
      assert.equal(page1.json<{ hasMore: boolean }>().hasMore, true);
      const single = await archive(q(`Portaria 1216 ${marker}`));
      assert.equal((single as unknown as { hasMore: boolean }).hasMore, false);

      const stopwords = await archive(q('de da do'));
      assert.equal(stopwords.totalItems, 0);
      assert.deepEqual(stopwords.items, []);
      // A stopword next to a real term is ignored, not required.
      assert.deepEqual(ids(await archive(q(`Portaria de 1216 ${marker}`))), [portaria1216]);
    });

    await t.test('navigation groups the selected branch with exact counts', async () => {
      const navigationCode = `${marker}nav`;
      const navigationSourceId = await createSource(navigationCode);
      await addOrigin(contentOnly, navigationSourceId);

      const dateRow = await admin.query<{ year: number; month: number }>(
        `SELECT extract(year from published_on)::int AS year,
                extract(month from published_on)::int AS month
         FROM publications WHERE id = $1`,
        [contentOnly],
      );
      const expectedYear = String(dateRow.rows[0]!.year);
      const expectedMonth = String(dateRow.rows[0]!.month);

      async function navigation(query: string) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v2/archive/navigation?${query}`,
          headers,
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json<{
          groupBy: string;
          items: Array<{ value: string; label: string; count: number }>;
        }>();
      }

      const types = await navigation(
        `groupBy=actType&source=${encodeURIComponent(navigationCode)}`,
      );
      assert.deepEqual(types.items, [{ value: 'Ato', label: 'Ato', count: 1 }]);

      const years = await navigation(
        `groupBy=year&source=${encodeURIComponent(navigationCode)}&actType=Ato`,
      );
      assert.deepEqual(years.items, [
        { value: expectedYear, label: expectedYear, count: 1 },
      ]);

      const months = await navigation(
        `groupBy=month&source=${encodeURIComponent(navigationCode)}&actType=Ato&year=${expectedYear}`,
      );
      assert.deepEqual(months.items, [
        { value: expectedMonth, label: expectedMonth, count: 1 },
      ]);

      const sources = await navigation('groupBy=source&actType=Ato');
      assert.deepEqual(
        sources.items.find((item) => item.value === navigationCode),
        { value: navigationCode, label: navigationCode, count: 1 },
      );
    });

    await t.test('facets list sources present in the feed', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v2/archive/facets',
        headers,
      });
      assert.equal(response.statusCode, 200);
      const codes = response
        .json<{ sources: Array<{ code: string }> }>()
        .sources.map((item) => item.code);
      for (const code of ['dou', 'confaz', 'sped']) {
        assert.ok(codes.includes(code), `${code} missing from ${codes.join(',')}`);
      }
      assert.equal(new Set(codes).size, codes.length, `duplicated codes: ${codes.join(',')}`);
    });
  } finally {
    await app.close();
    await admin.end();
  }
});
