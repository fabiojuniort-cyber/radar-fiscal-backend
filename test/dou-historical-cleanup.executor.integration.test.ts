import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Client } from 'pg';

import { deriveDouCleanupCandidates } from '../src/modules/collection/dou-historical-cleanup.dry-run.js';
import {
  DOU_CLEANUP_POLICY_KEY,
  deterministicOperationId,
  runDouHistoricalCleanupExecutor,
} from '../src/modules/collection/dou-historical-cleanup.executor.js';

// Runs LAST in CI: scope events are append-only, so the suppressed/restored
// fixtures cannot be removed afterwards (the CI database is ephemeral).
const pageUrl = (page: string) => `https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=05/10/2026&jornal=530&pagina=${page}`;
function douMetadata(section: string, matter: string, page: string): Record<string, unknown> {
  return {
    sourceRole: 'PRIMARY', ingestionChannel: 'INLABS',
    dou: {
      section, publicationDate: '2026-10-05', officialMatterId: matter, edition: '180',
      sourceActType: 'PORTARIA', abstract: '', continuationTitles: [], continuationAbstracts: [], scopeStructureIncomplete: false,
      archive: { section, date: '2026-10-05', filename: `2026-10-05-${section}.zip`, rawSha256: 'a'.repeat(64) },
      parts: [{ filename: `530_20261005_${matter}.xml`, rawSha256: 'b'.repeat(64), attributes: {
        pubName: section, pubDate: '05/10/2026', idMateria: matter, editionNumber: '180', artType: 'PORTARIA',
        pdfPage: pageUrl(page), numberPage: page,
      } }],
    },
  };
}

test('executor refuses drift, suppresses idempotently, verifies and restores only its own events', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  ok(adminUrl, 'DATABASE_ADMIN_URL is required');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    let sourceId = (await admin.query<{ id: string }>(`SELECT id FROM sources WHERE code = 'dou'`)).rows[0]?.id;
    if (!sourceId) {
      sourceId = randomUUID();
      await admin.query(`INSERT INTO sources (id, code, name, jurisdiction_level, base_url, connector_key, is_active)
        VALUES ($1, 'dou', 'DOU executor fixture', 'FEDERAL', 'https://example.invalid', 'dou', false)`, [sourceId]);
    }
    const seeded: string[] = [];
    for (const [index, section] of ['DO2', 'DO2', 'DO2E'].entries()) {
      const id = randomUUID();
      const matter = `8100000${index}`;
      const page = String(70 + index);
      const meta = douMetadata(section, matter, page);
      await admin.query(`INSERT INTO publications (id, identity_hash, identity_strength, identity_basis, jurisdiction_level, title, act_type, agency)
        VALUES ($1::uuid, encode(sha256(convert_to($2::text, 'UTF8')), 'hex'), 'STRONG', '{}', 'FEDERAL', 'PORTARIA Nº ' || $3, 'PORTARIA', 'União')`,
        [id, id, String(index)]);
      await admin.query(`INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, metadata)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`, [id, sourceId, `2026-10-05:${section}:180:${matter}`, pageUrl(page), JSON.stringify(meta)]);
      await admin.query(`INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text, is_current, source_metadata)
        VALUES ($1::uuid, 1, repeat('d', 64), 'Ato de pessoal.', true, $2::jsonb)`, [id, JSON.stringify(meta)]);
      seeded.push(id);
    }

    const { summary, candidates } = await deriveDouCleanupCandidates(admin);
    for (const id of seeded) ok(candidates.some(candidate => candidate.publicationId === id));
    const approved = {
      approvedCandidateSetSha256: summary.candidateSetSha256,
      approvedCandidateCount: candidates.length,
      actorRef: 'DOU_CLEAN_01_TEST',
      chunkSize: 2,
    };

    // Drifted approval is refused before any write.
    await rejects(runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'apply', approvedCandidateSetSha256: 'f'.repeat(64) }),
      /CANDIDATE_SET_DIFFERS_FROM_APPROVED_DRY_RUN/);
    await rejects(runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'apply', approvedCandidateCount: candidates.length + 1 }),
      /CANDIDATE_SET_DIFFERS_FROM_APPROVED_DRY_RUN/);
    equal((await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'verify' })).state.outOfScopeByThisPolicy, 0);

    const applied = await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'apply' });
    deepEqual(applied.transitions, { applied: candidates.length, replayed: 0 });
    equal(applied.state.outOfScopeByThisPolicy, candidates.length);
    equal(applied.state.inScopeCandidates, 0);
    equal(applied.state.candidateFeedRows, 0);

    // Re-run replays the same deterministic operations; nothing new is written.
    const replay = await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'apply' });
    deepEqual(replay.transitions, { applied: 0, replayed: candidates.length });
    equal(replay.state.epoch, applied.state.epoch);

    // Suppression does not change the evidence: verify still matches the approval.
    const verified = await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'verify' });
    equal(verified.derived.candidateSetSha256, summary.candidateSetSha256);
    equal(verified.state.outOfScopeByThisPolicy, candidates.length);

    const events = await admin.query<{ operation_id: string; policy_key: string; manifest_sha256: string }>(
      `SELECT operation_id, policy_key, manifest_sha256::text FROM publication_scope_events WHERE publication_id = $1`, [seeded[0]]);
    equal(events.rows.length, 1);
    equal(events.rows[0]!.operation_id, deterministicOperationId('suppress', summary.candidateSetSha256, seeded[0]!));
    equal(events.rows[0]!.policy_key, DOU_CLEANUP_POLICY_KEY);
    match(events.rows[0]!.operation_id, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

    const restored = await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'restore' });
    deepEqual(restored.transitions, { applied: candidates.length, replayed: 0 });
    equal(restored.state.outOfScopeByThisPolicy, 0);
    equal(restored.state.inScopeCandidates, candidates.length);
    ok(restored.state.candidateFeedRows >= candidates.length);

    // Nothing left to restore; a second restore is a no-op.
    deepEqual((await runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'restore' })).transitions, { applied: 0, replayed: 0 });
    // After RESTORE the same manifest cannot silently re-suppress (operation superseded).
    await rejects(runDouHistoricalCleanupExecutor(admin, { ...approved, mode: 'apply' }), /PUBLICATION_SCOPE_OPERATION_SUPERSEDED/);
  } finally {
    await admin.end();
  }
});
