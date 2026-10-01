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
    });
  } finally {
    await app.close();
    await admin.end();
  }
});
