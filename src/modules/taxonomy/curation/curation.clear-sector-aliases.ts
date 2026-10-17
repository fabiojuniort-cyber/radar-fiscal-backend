import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { updateConcept, type CuratorActor } from './curation.draft.js';
import type { ReleaseView } from './curation.read.js';

export const sectorAliases = (view: ReleaseView) => view.concepts
  .filter(c => c.dimensionCode === 'sector')
  .reduce((sum, c) => sum + c.aliases.length, 0);

/** Semantic state without the alias lists or revision bookkeeping. */
export const sectorStateWithoutAliases = (view: ReleaseView) => ({
  dimension: view.dimensions.filter(d => d.code === 'sector'),
  groups: view.groups.filter(g => g.dimensionCode === 'sector'),
  concepts: view.concepts.filter(c => c.dimensionCode === 'sector')
    .map(({ aliases: _aliases, revisionNo: _revisionNo, ...rest }) => rest),
});

/** The caller owns the normal TAX-11 curator transaction and advisory lock. */
export async function clearSectorAliases(client: PoolClient, actor: CuratorActor, view: ReleaseView) {
  if (view.release.status !== 'DRAFT') throw new Error('DRAFT required');
  const sector = view.concepts.filter(c => c.dimensionCode === 'sector');
  const affected = sector.filter(c => c.aliases.length > 0);
  const removedSynonyms = sectorAliases(view);
  let recoveryAuditId: string | null = null;
  if (affected.length) {
    recoveryAuditId = randomUUID();
    // Recovery data stays inside Railway. Do not log/export the lists.
    await client.query(`INSERT INTO audit_log (
      id, tenant_id, actor_type, actor_id, action, entity_type, entity_id,
      before_data, after_data, correlation_id
    ) VALUES ($1::uuid, NULL, 'ADMIN', $2, 'TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED',
      'taxonomy_curation', $3::uuid, $4::jsonb, $5::jsonb, $6::uuid)`, [
      recoveryAuditId, actor.userId, view.release.id,
      JSON.stringify({ concepts: affected.map(c => ({ code: c.code, aliases: c.aliases })) }),
      JSON.stringify({ removedSynonyms, rowsAffected: affected.length, justification: actor.justification }),
      randomUUID(),
    ]);
  }
  for (const [index, concept] of affected.entries()) {
    await updateConcept(client, actor, concept.code, { aliases: [] });
    if (index % 250 === 0) console.log(`CLEAR_SYNONYMS_PROGRESS=${index + 1}/${affected.length}`);
  }
  return { removedSynonyms, rowsAffected: affected.length, sectorItems: sector.length, recoveryAuditId };
}
