import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import { withCuratorTransaction, type CuratorActor } from '../../modules/taxonomy/curation/curation.draft.js';
import {
  loadProductSheet,
  parseProductSheet,
  type ProductLoadSummary,
} from '../../modules/taxonomy/curation/curation.product-load.js';
import { resolveCuratorDatabaseUrl } from './curator-client.js';

/**
 * Loads a product classification sheet (Segmento;Grupo;Item) into the open
 * curation DRAFT (rules in curation.product-load.ts):
 *
 *   node dist/infrastructure/database/taxonomy-load-products.js \
 *     --file=ops/taxonomy/loads/classificacao-produtos-agro.csv [--confirm]
 *
 * Without --confirm everything runs and is rolled back (dry run); with
 * errors nothing is saved. Nothing is published: the curator reviews the
 * DRAFT before publishing.
 */

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const file = arg('file');
const confirm = process.argv.includes('--confirm');
if (!file) {
  console.error('Usage: taxonomy-load-products --file=<Segmento;Grupo;Item csv> [--confirm]');
  process.exit(1);
}

const connectionString = resolveCuratorDatabaseUrl({
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  DATABASE_CURATOR_URL: process.env.DATABASE_CURATOR_URL,
  DB_CURATOR_RUNTIME_PASSWORD: process.env.DB_CURATOR_RUNTIME_PASSWORD,
});
if (!connectionString) {
  console.error('DATABASE_CURATOR_URL (or DATABASE_URL + DB_CURATOR_RUNTIME_PASSWORD) is required.');
  process.exit(1);
}

const sheet = parseProductSheet(readFileSync(file, 'utf8'));
const actor: CuratorActor = {
  userId: 'ops:taxonomy-load-products',
  justification: `Carga da planilha de classificação de produtos (${sheet.length} itens)`,
};

class Rollback extends Error {}

const pool = new Pool({ connectionString, max: 1 });
let summary: ProductLoadSummary | undefined;
try {
  await withCuratorTransaction(pool, async (client) => {
    summary = await loadProductSheet(client, actor, sheet);
    if (!confirm || summary.errors.length > 0) throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await pool.end();
}

const saved = confirm && summary !== undefined && summary.errors.length === 0;
console.log('TAXONOMY_LOAD_PRODUCTS=' + JSON.stringify({ saved, ...summary }));
if (confirm && !saved) process.exitCode = 2;
