import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { createConcept, CurationError, type CuratorActor, requireOpenDraft } from './curation.draft.js';

// F2-T02: 12 approved categories from Segmento v5 (13th "Produção Agrícola"
// is NOT approved). Frequencies are documentary, never import gates.
// Only Energia e utilidades has approved synonyms; no inherited Segmento aliases.
export const F2_ACTUACAO_SOURCE_SHA256 =
  'd27368e821b3cf892400a8fe8fd9cd8b1b74f0f711541a203655acab041ce814';

export const F2_ACTUACAO_SEED = [
  { code: 'actuacao.servico', label: 'Serviço', count: 505 },
  { code: 'actuacao.industria', label: 'Indústria', count: 370 },
  { code: 'actuacao.comercio_atacadista', label: 'Comércio atacadista', count: 115 },
  { code: 'actuacao.comercio_varejista', label: 'Comércio varejista', count: 86 },
  { code: 'actuacao.transportador', label: 'Transportador', count: 44 },
  { code: 'actuacao.extracao_mineral', label: 'Extração mineral', count: 40 },
  { code: 'actuacao.produtor_rural', label: 'Produtor rural', count: 37 },
  { code: 'actuacao.locacao_e_licenciamento', label: 'Locação e licenciamento', count: 20 },
  { code: 'actuacao.institucional', label: 'Institucional', count: 19 },
  { code: 'actuacao.representacao_comercial', label: 'Representação comercial', count: 15 },
  {
    code: 'actuacao.energia_e_utilidades', label: 'Energia e utilidades', count: 8,
    synonyms: [
      'geração de energia elétrica',
      'transmissão de energia elétrica',
      'distribuição de energia elétrica',
      'comercialização de energia elétrica',
      'produção de gás',
      'distribuição de gás canalizado',
      'produção e distribuição de vapor',
      'produção e distribuição de água quente',
    ],
  },
  { code: 'actuacao.armazem', label: 'Armazém', count: 3 },
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
  if (!actor.justification.trim()) throw new CurationError('JUSTIFICATION_REQUIRED');
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
      notes: 'F2-T02: Atuação v5 (' + seed.count + ' CNAEs de origem); revisão obrigatória antes de publicar.',
      // Generic lexical matches like "Serviço" alone can cause false positives.
      classifyByLabel: false,
      profileVisible: false,
      aliases: 'synonyms' in seed ? seed.synonyms.map(text => ({ text, aliasType: 'EXACT_LEXICAL' as const })) : [],
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
    sourceRows: 1332,
    classificationPublished: false,
  };
}

/** Canonical SHA256 of Segmento v5 origins (including unapproved categories), one line each:
 * `sourceLine|cnae7digits|AtuaçãoLabel\n`, preserving XLSX row order.
 * This projection pin prevents a client from submitting forged associations
 * while claiming the original XLSX file hash.
 */
export const F2_ACTUACAO_ORIGINS_PROJECTION_SHA256 =
  '009b3c495081114283c65c65001b0a198a8661dc52e4854670090664b58e59df';

export interface F2ActuacaoOriginInput {
  sourceLine: number;
  cnaeCode: string;
  atuacaoLabel: string;
}
export interface F2ActuacaoOriginsResult {
  releaseId: string;
  sourceSha256: string;
  projectionSha256: string;
  originCount: number;
  reusedExisting: boolean;
  classificationPublished: false;
}

function originProjection(rows: readonly F2ActuacaoOriginInput[]): string {
  return rows.map((row) => String(row.sourceLine) + '|' + row.cnaeCode + '|' + row.atuacaoLabel + '\n').join('');
}

export function validateF2ActuacaoOrigins(rows: readonly F2ActuacaoOriginInput[]): string {
  if (rows.length !== 1332) throw new CurationError('F2_ORIGINS_ROW_COUNT_INVALID');
  const known = new Set<string>(F2_ACTUACAO_SEED.map((item) => item.label));
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.sourceLine !== i + 2 || !/^[0-9]{7}$/.test(row.cnaeCode)) {
      throw new CurationError('F2_ORIGINS_ROW_INVALID_' + (i + 2));
    }
    if (!known.has(row.atuacaoLabel)) throw new CurationError('F2_ORIGINS_LABEL_INVALID');
    if (seen.has(row.cnaeCode)) throw new CurationError('F2_ORIGINS_CNAE_DUPLICATE');
    seen.add(row.cnaeCode);
  }
  const digest = createHash('sha256').update(originProjection(rows), 'utf8').digest('hex');
  if (digest !== F2_ACTUACAO_ORIGINS_PROJECTION_SHA256) {
    throw new CurationError('F2_ORIGINS_PROJECTION_HASH_MISMATCH');
  }
  return digest;
}

/** Strict curator-only DRAFT write. It is not a T03 product/NCM import. */
export async function persistF2ActuacaoCnaeOrigins(
  client: PoolClient,
  actor: CuratorActor,
  rows: readonly F2ActuacaoOriginInput[],
  sourceSha256: string,
): Promise<F2ActuacaoOriginsResult> {
  if (!actor.justification.trim()) throw new CurationError('JUSTIFICATION_REQUIRED');
  if (sourceSha256 !== F2_ACTUACAO_SOURCE_SHA256) {
    throw new CurationError('F2_ORIGINS_SOURCE_HASH_MISMATCH');
  }
  const projectionSha256 = validateF2ActuacaoOrigins(rows);
  const draft = await requireOpenDraft(client);
  const count = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
    [draft.id],
  );
  if ((count.rows[0]?.count ?? 0) !== 0) {
    const previous = await client.query<{ source_line: number; cnae_code: string; code: string; source_sha256: string }>(
      'SELECT o.source_line, o.cnae_code, c.code, o.source_sha256 FROM taxonomy_release_actuacao_cnae_origins o JOIN taxonomy_release_concepts rc ON rc.id = o.release_concept_id JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE o.release_id = $1::uuid ORDER BY o.source_line',
      [draft.id],
    );
    const labels = new Map<string, string>(F2_ACTUACAO_SEED.map((item) => [item.code, item.label]));
    const recovered: F2ActuacaoOriginInput[] = previous.rows.map((item) => ({
      sourceLine: item.source_line,
      cnaeCode: item.cnae_code,
      atuacaoLabel: labels.get(item.code) ?? '',
    }));
    if (previous.rows.length !== 1332 ||
        previous.rows.some((item) => item.source_sha256 !== sourceSha256) ||
        originProjection(recovered) !== originProjection(rows)) {
      throw new CurationError('F2_ORIGINS_EXISTING_ROWS_CONFLICT');
    }
    return {
      releaseId: draft.id, sourceSha256, projectionSha256, originCount: rows.length,
      reusedExisting: true, classificationPublished: false,
    };
  }

  const byLabel = new Map<string, string>(F2_ACTUACAO_SEED.map((item) => [item.label, item.code]));
  const selected = await client.query<{ code: string; release_id: string }>(
    'SELECT c.code, rc.release_id FROM taxonomy_release_concepts rc JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE rc.release_id = $1::uuid AND c.code LIKE $2',
    [draft.id, 'actuacao.%'],
  );
  const present = new Set(selected.rows.map((row) => row.code));
  if (present.size !== F2_ACTUACAO_SEED.length || F2_ACTUACAO_SEED.some((item) => !present.has(item.code))) {
    throw new CurationError('F2_ACTUACAO_NOT_INITIALIZED');
  }

  const payload = rows.map((row) => ({
    source_line: row.sourceLine, cnae_code: row.cnaeCode,
    concept_code: byLabel.get(row.atuacaoLabel),
  }));
  const inserted = await client.query<{ cnae_code: string }>(
    `INSERT INTO taxonomy_release_actuacao_cnae_origins
       (release_id, release_concept_id, cnae_code, source_line, source_sha256)
     SELECT $1::uuid, rc.id, s.cnae_code, s.source_line, $3
     FROM jsonb_to_recordset($2::jsonb)
       AS s(source_line integer, cnae_code text, concept_code text)
     JOIN taxonomy_concepts c ON c.code = s.concept_code
     JOIN taxonomy_release_concepts rc
       ON rc.concept_id = c.id AND rc.release_id = $1::uuid
     RETURNING cnae_code`,
    [draft.id, JSON.stringify(payload), sourceSha256],
  );
  if (inserted.rows.length !== rows.length) {
    throw new CurationError('F2_ORIGINS_INSERT_READBACK_MISMATCH');
  }
  await client.query(
    `INSERT INTO audit_log
       (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
     VALUES (NULL, 'ADMIN', $1, 'F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED',
             'taxonomy_curation', $2::uuid, $3::jsonb, $4::uuid)`,
    [actor.userId, draft.id, JSON.stringify({
      justification: actor.justification, sourceSha256, projectionSha256,
      originCount: rows.length, publicationRequested: false,
    }), randomUUID()],
  );
  return {
    releaseId: draft.id, sourceSha256, projectionSha256, originCount: rows.length,
    reusedExisting: false, classificationPublished: false,
  };
}
