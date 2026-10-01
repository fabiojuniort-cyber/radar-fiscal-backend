import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  importNcmCatalog,
} from '../src/modules/taxonomy/ncm/ncm-catalog.importer.js';
import {
  parseNcmCatalogPayload,
} from '../src/modules/taxonomy/ncm/ncm-catalog.source.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');

const parsed = parseNcmCatalogPayload({
  Data_Ultima_Atualizacao_NCM: '01/10/2026',
  Ato: { Tipo: 'Res Gecex', Numero: '999' },
  Nomenclaturas: [
    { Codigo: '01', Descricao: 'Animais vivos.', Data_Inicio: '01/04/2022', Data_Fim: '31/12/9999' },
    { Codigo: '1006.30.11', Descricao: 'Arroz semibranqueado ou branqueado.', Data_Inicio: '01/04/2022', Data_Fim: '31/12/9999' },
    { Codigo: '1006.20.99', Descricao: 'Outros arrozes descascados.', Data_Inicio: '01/04/2022', Data_Fim: '31/12/9999' },
  ],
});

const sourceSha256 = 'a'.repeat(64);

test('official NCM catalog import is idempotent and uses curator privileges', async () => {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const client = await pool.connect();

  try {
    const first = await importNcmCatalog(client, {
      sourceUrl: 'https://example.invalid/ncm.json',
      sourceSha256,
      parsed,
    });

    assert.equal(first.created, true);
    assert.equal(first.entriesInserted, 3);
    assert.equal(first.assignableCount, 2);

    const replay = await importNcmCatalog(client, {
      sourceUrl: 'https://example.invalid/ncm.json',
      sourceSha256,
      parsed,
    });

    assert.equal(replay.created, false);
    assert.equal(replay.editionId, first.editionId);
    assert.equal(replay.entriesInserted, 0);

    const state = await client.query<{
      catalogs: number;
      current_editions: number;
      entries: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM official_catalogs WHERE code = 'NCM') AS catalogs,
        (
          SELECT count(*)::int
          FROM official_catalog_editions ed
          JOIN official_catalogs c ON c.id = ed.catalog_id
          WHERE c.code = 'NCM' AND ed.status = 'CURRENT'
        ) AS current_editions,
        (
          SELECT count(*)::int
          FROM official_catalog_entries e
          JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
          JOIN official_catalogs c ON c.id = ed.catalog_id
          WHERE c.code = 'NCM'
        ) AS entries
    `);

    assert.deepEqual(state.rows[0], {
      catalogs: 1,
      current_editions: 1,
      entries: 3,
    });

    const runtimeWrite = await client.query<{ can_insert: boolean }>(`
      SELECT has_table_privilege(
        'radar_worker_runtime',
        'public.official_catalog_entries',
        'INSERT'
      ) AS can_insert
    `);
    assert.equal(runtimeWrite.rows[0]?.can_insert, false);
  } finally {
    client.release();
    await pool.end();
  }
});
