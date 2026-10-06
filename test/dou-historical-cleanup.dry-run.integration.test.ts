import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Client } from 'pg';

import { runDouHistoricalCleanupDryRun } from '../src/modules/collection/dou-historical-cleanup.dry-run.js';

// Real connector shape: the origin URL is the certified page of the XML part.
const pageUrl = (page: string) => `https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=05/10/2026&jornal=530&pagina=${page}`;
const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: Aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';

function douMetadata(section: string, matter: string, page: string): Record<string, unknown> {
  return {
    sourceRole: 'PRIMARY', ingestionChannel: 'INLABS',
    dou: {
      section, publicationDate: '2026-10-05', officialMatterId: matter, edition: '180',
      sourceActType: 'EXTRATO DE CONTRATO', abstract: '',
      continuationTitles: [], continuationAbstracts: [], scopeStructureIncomplete: false,
      archive: { section, date: '2026-10-05', filename: `2026-10-05-${section}.zip`, rawSha256: 'a'.repeat(64) },
      parts: [{ filename: `530_20261005_${matter}.xml`, rawSha256: 'b'.repeat(64), attributes: {
        pubName: section, pubDate: '05/10/2026', idMateria: matter, editionNumber: '180', artType: 'EXTRATO DE CONTRATO',
        pdfPage: pageUrl(page), numberPage: page,
      } }],
    },
  };
}

test('in-database dry run is read-only, deterministic and prints only aggregates', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  ok(adminUrl, 'DATABASE_ADMIN_URL is required');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const created: { publications: string[]; source?: string } = { publications: [] };
  try {
    const existing = await admin.query<{ id: string }>(`SELECT id FROM sources WHERE code = 'dou'`);
    let sourceId = existing.rows[0]?.id;
    if (!sourceId) {
      sourceId = randomUUID();
      await admin.query(
        `INSERT INTO sources (id, code, name, jurisdiction_level, base_url, connector_key, is_active)
         VALUES ($1, 'dou', 'DOU dry-run fixture', 'FEDERAL', 'https://example.invalid', 'dou', false)`, [sourceId]);
      created.source = sourceId;
    }
    async function seed(title: string, actType: string, section: string | null, matter: string, content: string) {
      const publicationId = randomUUID();
      const page = matter.slice(-1);
      const meta = section ? douMetadata(section, matter, page) : {};
      await admin.query(
        `INSERT INTO publications (id, identity_hash, identity_strength, identity_basis, jurisdiction_level, title, act_type, agency)
         VALUES ($1::uuid, encode(sha256(convert_to($4::text, 'UTF8')), 'hex'), 'STRONG', '{}', 'FEDERAL', $2, $3, 'União')`,
        [publicationId, title, actType, publicationId]);
      await admin.query(
        `INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, metadata)
         VALUES ($1::uuid, $2::uuid, $3, $5::text, $4::jsonb)`,
        [publicationId, sourceId, section ? `2026-10-05:${section}:180:${matter}` : null, JSON.stringify(meta),
          section ? pageUrl(page) : `https://example.invalid/${publicationId}`]);
      await admin.query(
        `INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text, is_current, source_metadata)
         VALUES ($1, 1, repeat('c', 64), $2, true, $3::jsonb)`, [publicationId, content, JSON.stringify(meta)]);
      created.publications.push(publicationId);
    }
    await seed('PORTARIA Nº 1', 'PORTARIA', 'DO2', '71000001', 'Nomeação de servidor.');
    await seed('EXTRATO DE CONTRATO Nº 7/2026', 'EXTRATO DE CONTRATO', 'DO3', '71000002', routine);
    await seed('PORTARIA SEM PROVENIENCIA', 'PORTARIA', null, '71000003', 'Texto.');

    const before = await admin.query<{ count: string }>(`SELECT count(*) FROM publication_scope_events`);
    const fixedNow = () => new Date('2026-10-06T00:00:00.000Z');
    const first = await runDouHistoricalCleanupDryRun(admin, { batchSize: 2, now: fixedNow });
    const second = await runDouHistoricalCleanupDryRun(admin, { batchSize: 500, now: fixedNow });

    // Read-only and no transaction left open on the caller's connection.
    const status = await admin.query<{ read_only: string }>(`SELECT current_setting('transaction_read_only') AS read_only`);
    equal(status.rows[0]!.read_only, 'off');
    const after = await admin.query<{ count: string }>(`SELECT count(*) FROM publication_scope_events`);
    equal(after.rows[0]!.count, before.rows[0]!.count);

    equal(first.executionAllowed, false);
    equal(first.mode, 'DRY_RUN_READ_ONLY');
    match(first.databaseIdentity, /^pg:[a-f0-9]{32}$/);
    ok(first.counts.publicationsInspected >= 3);
    ok((first.byReason.CANDIDATE.excluded_dou_section ?? 0) >= 1);
    ok((first.byReason.CANDIDATE.strict_routine_contract_excerpt ?? 0) >= 1);
    ok((first.byReason.REVIEW.missing_or_conflicting_dou_provenance ?? 0) >= 1);
    ok((first.candidatesBySection.DO2 ?? 0) >= 1 && (first.candidatesBySection.DO3 ?? 0) >= 1);
    // Batch size changes the per-batch anchors but never the candidate set.
    equal(first.candidateSetSha256, second.candidateSetSha256);
    deepEqual(first.counts, second.counts);
    match(first.candidateSetSha256, /^[a-f0-9]{64}$/);

    // The summary never carries identifiers or text of the inspected rows.
    const serialized = JSON.stringify(first);
    for (const publicationId of created.publications) equal(serialized.includes(publicationId), false);
    equal(serialized.includes('Alfa Ltda'), false);
  } finally {
    if (created.publications.length) {
      await admin.query(`DELETE FROM publication_versions WHERE publication_id = ANY($1::uuid[])`, [created.publications]);
      await admin.query(`DELETE FROM publication_origins WHERE publication_id = ANY($1::uuid[])`, [created.publications]);
      await admin.query(`DELETE FROM publications WHERE id = ANY($1::uuid[])`, [created.publications]);
    }
    if (created.source) await admin.query(`DELETE FROM sources WHERE id = $1`, [created.source]);
    await admin.end();
  }
});
