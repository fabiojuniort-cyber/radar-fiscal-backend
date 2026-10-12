import type { PoolClient } from 'pg';

import { createConcept, type CuratorActor, requireOpenDraft } from './curation.draft.js';

// F2-T02: seven exact values and frequencies derived from the signed-off
// Segmento v1.7.3 XLSX, column Atuação. Synonyms are intentionally NOT
// inherited from Segmento and no classification is published here.
export const F2_ACTUACAO_SOURCE_SHA256 =
  '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd';

export const F2_ACTUACAO_SEED = [
  { code: 'actuacao.servico', label: 'Serviço', count: 583 },
  { code: 'actuacao.industria', label: 'Indústria', count: 380 },
  { code: 'actuacao.comercio_atacadista', label: 'Comércio atacadista', count: 116 },
  { code: 'actuacao.producao_agropecuaria', label: 'Produção agropecuária', count: 108 },
  { code: 'actuacao.comercio_varejista', label: 'Comércio varejista', count: 89 },
  { code: 'actuacao.extracao_mineral', label: 'Extração mineral', count: 41 },
  { code: 'actuacao.representacao_comercial', label: 'Representação comercial', count: 15 },
] as const;

export interface F2ActuacaoResult {
  dimension: 'actuacao';
  seededCodes: string[];
  sourceSha256: string;
  sourceRows: number;
  classificationPublished: false;
}

/** Invoke only inside withCuratorTransaction: role, advisory lock and rollback. */
export async function initializeF2Actuacao(
  client: PoolClient,
  actor: CuratorActor,
): Promise<F2ActuacaoResult> {
  if (!actor.justification.trim()) throw new Error('JUSTIFICATION_REQUIRED');
  const draft = await requireOpenDraft(client);

  const current = await client.query<{ id: string }>(
    'SELECT id FROM taxonomy_dimensions WHERE code = $1 FOR UPDATE',
    ['actuacao'],
  );
  let dimensionId = current.rows[0]?.id;
  if (!dimensionId) {
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO taxonomy_dimensions (code, identity_status) VALUES ('actuacao', 'CURRENT') RETURNING id",
    );
    dimensionId = inserted.rows[0]!.id;
  }

  const hasMembership = await client.query<{ id: string }>(
    'SELECT dimension_id AS id FROM taxonomy_release_dimensions WHERE release_id = $1::uuid AND dimension_id = $2::uuid',
    [draft.id, dimensionId],
  );
  if (!hasMembership.rows.length) {
    const revisions = await client.query<{ id: string }>(
      'SELECT id FROM taxonomy_dimension_revisions WHERE dimension_id = $1::uuid ORDER BY revision_no DESC LIMIT 1',
      [dimensionId],
    );
    let revisionId = revisions.rows[0]?.id;
    if (!revisionId) {
      const created = await client.query<{ id: string }>(
        "INSERT INTO taxonomy_dimension_revisions (dimension_id, revision_no, name, description, governance_status) VALUES ($1::uuid, 1, 'Atuação', 'Forma de atuação econômica independente do Segmento.', 'PROPOSED') RETURNING id",
        [dimensionId],
      );
      revisionId = created.rows[0]!.id;
    }
    await client.query(
      "INSERT INTO taxonomy_release_dimensions (release_id, dimension_id, dimension_revision_id, membership_status, profile_visible, profile_order, help_text, detail_section, detail_order, uses_groups, official_code_type) VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCLUDED', false, 9, 'Atuação econômica curada independentemente dos segmentos e CNAEs.', 'Atuação', 55, false, NULL)",
      [draft.id, dimensionId, revisionId],
    );
  }

  const seededCodes: string[] = [];
  for (const seed of F2_ACTUACAO_SEED) {
    const existing = await client.query<{ id: string }>(
      'SELECT rc.id FROM taxonomy_release_concepts rc JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE rc.release_id = $1::uuid AND c.code = $2',
      [draft.id, seed.code],
    );
    if (existing.rows.length) continue;
    await createConcept(client, actor, 'actuacao', {
      code: seed.code,
      label: seed.label,
      definition: seed.label,
      governanceStatus: 'PROPOSED',
      evidenceStatus: 'NOT_ASSESSED',
      notes: 'F2-T02: Atuação v1.7.3 (' + seed.count + ' CNAEs de origem); revisão obrigatória antes de publicar.',
      // Generic lexical matches like "Serviço" alone can cause false positives.
      classifyByLabel: false,
      profileVisible: false,
      aliases: [],
    });
    seededCodes.push(seed.code);
  }

  await client.query(
    "INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id) VALUES (NULL, 'ADMIN', $1, 'F2_T02_ACTUACAO_INITIALIZED', 'taxonomy_curation', $2::uuid, $3::jsonb, gen_random_uuid())",
    [actor.userId, draft.id, JSON.stringify({
      justification: actor.justification,
      seedSha256: F2_ACTUACAO_SOURCE_SHA256,
      seededCodes,
    })],
  );
  return {
    dimension: 'actuacao',
    seededCodes,
    sourceSha256: F2_ACTUACAO_SOURCE_SHA256,
    sourceRows: F2_ACTUACAO_SEED.reduce((count, item) => count + item.count, 0),
    classificationPublished: false,
  };
}
