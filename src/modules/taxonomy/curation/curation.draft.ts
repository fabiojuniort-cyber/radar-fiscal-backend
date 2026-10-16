import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { canonicalJson } from '../baseline/baseline.canonical-json.js';
import { normalizeAliasText } from '../baseline/baseline.parser.js';
import {
  GENERIC_LABEL_CODES,
  OFFICIAL_CODE_TYPES,
  isValidOfficialCode,
  normalizeOfficialCode,
  type OfficialCodeType,
  isCnaeActivity,
} from './curation.constants.js';
import {
  CURATED_RELEASE_KIND,
  findLatestPublishedRelease,
  findOpenDraft,
  findRelease,
  legacyDimensionDefaults,
  loadReleaseView,
  pgRunner,
  type ConceptView,
  type DimensionView,
  type GroupView,
  type ReleaseSummary,
  type ReleaseView,
} from './curation.read.js';
import {
  DIMENSION_SEEDS,
  DOCUMENT_LABEL_FIXES,
  OFFICIAL_CODE_SEEDS,
  SEED_NOTE,
} from './curation.seed.js';
import {
  parseTaxonomyCodeCompatibility,
  resolveTaxonomyConceptCode,
  updateDraftTaxonomyCodeCompatibility,
} from '../taxonomy-code-compatibility.js';

export class CurationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CurationError';
  }
}

export interface CuratorActor {
  userId: string;
  justification: string;
}

const CURATION_LOCK_KEY = 'tribusca.taxonomy.curation';

export const ALIAS_TYPES = [
  'EXACT_LEXICAL',
  'ABBREVIATION',
  'HISTORICAL_LABEL',
  'SEARCH_RELATED',
  'AMBIGUOUS',
] as const;

export type AliasType = (typeof ALIAS_TYPES)[number];

const GOVERNANCE_STATUSES = [
  'PROPOSED',
  'UNDER_REVIEW',
  'APPROVED',
  'DEPRECATED',
  'REJECTED',
] as const;

const EVIDENCE_STATUSES = [
  'DOCUMENTED',
  'NEEDS_EVIDENCE',
  'NOT_ASSESSED',
] as const;

/**
 * Runs `fn` in one transaction as radar_taxonomy_curator, serialized with
 * every other curation write through a transaction-scoped advisory lock.
 */
const CURATOR_LOGIN = 'radar_taxonomy_curator_runtime';

/**
 * Refuses a curator connection that is not the dedicated NOINHERIT login
 * (e.g. DATABASE_CURATOR_URL pointing at an admin/superuser URL).
 */
export async function assertCuratorSession(client: PoolClient): Promise<void> {
  const result = await client.query<{ session_user: string; superuser: boolean }>(
    `SELECT session_user::text AS session_user,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), true) AS superuser`,
  );
  const row = result.rows[0];
  if (!row || row.session_user !== CURATOR_LOGIN || row.superuser) {
    throw new CurationError('CURATOR_DATABASE_MISCONFIGURED', 503);
  }
}

export async function withCuratorTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await assertCuratorSession(client);
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [CURATION_LOCK_KEY],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertJustification(actor: CuratorActor): void {
  if (!actor.justification.trim()) {
    throw new CurationError('JUSTIFICATION_REQUIRED');
  }
}

async function writeAudit(
  client: PoolClient,
  actor: CuratorActor,
  action: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `
      INSERT INTO audit_log (
        tenant_id, actor_type, actor_id, action,
        entity_type, entity_id, after_data, correlation_id
      ) VALUES (
        NULL, 'ADMIN', $1, $2,
        'taxonomy_curation', $3::uuid, $4::jsonb, $5::uuid
      )
    `,
    [
      actor.userId,
      action,
      entityId,
      JSON.stringify({ ...payload, justification: actor.justification }),
      randomUUID(),
    ],
  );
}

export async function requireOpenDraft(
  client: PoolClient,
): Promise<ReleaseSummary> {
  const draft = await findOpenDraft(pgRunner(client));
  if (!draft) throw new CurationError('NO_OPEN_DRAFT', 409);
  if (draft.status !== 'DRAFT') {
    throw new CurationError('DRAFT_NOT_EDITABLE', 409);
  }
  return draft;
}

function slugify(value: string): string {
  return normalizeAliasText(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function cleanText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeCodes(
  type: OfficialCodeType | null,
  codes: readonly string[],
): string[] {
  const normalized = [
    ...new Set(codes.map(normalizeOfficialCode).filter(Boolean)),
  ];
  const invalid = normalized.filter(
    (code) => !isValidOfficialCode(type, code),
  );
  if (invalid.length > 0) {
    throw new CurationError(
      'INVALID_OFFICIAL_CODE',
      400,
      `Código(s) oficial(is) inválido(s) para ${type ?? 'texto livre'}: ${invalid.join(', ')}`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Draft creation
// ---------------------------------------------------------------------------

async function nextVersion(
  client: PoolClient,
  source: ReleaseSummary,
): Promise<[number, number, number]> {
  const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(source.version);
  if (!parts) throw new CurationError('INVALID_SOURCE_VERSION', 500);
  const major = Number(parts[1]);
  let minor = Number(parts[2]) + 1;

  for (;;) {
    const taken = await client.query(
      `SELECT 1 FROM taxonomy_releases
       WHERE version_major = $1 AND version_minor = $2 AND version_patch = 0`,
      [major, minor],
    );
    if (taken.rowCount === 0) return [major, minor, 0];
    minor += 1;
  }
}

async function copyReleaseGraph(
  client: PoolClient,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO taxonomy_release_dimensions (
        release_id, dimension_id, dimension_revision_id, membership_status,
        profile_visible, profile_order, help_text, detail_section,
        detail_order, uses_groups, official_code_type
      )
      SELECT
        $2::uuid, dimension_id, dimension_revision_id, membership_status,
        profile_visible, profile_order, help_text, detail_section,
        detail_order, uses_groups, official_code_type
      FROM taxonomy_release_dimensions
      WHERE release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  await client.query(
    `
      INSERT INTO taxonomy_release_groups (
        release_id, dimension_id, code, label, display_order,
        help_text, detail_section, official_codes
      )
      SELECT
        $2::uuid, dimension_id, code, label, display_order,
        help_text, detail_section, official_codes
      FROM taxonomy_release_groups
      WHERE release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  await client.query(
    `
      INSERT INTO taxonomy_release_concepts (
        release_id, concept_id, concept_revision_id, membership_status,
        release_notes, group_id, profile_visible, display_order,
        help_text, classify_by_label, official_codes, f2_suggested_products, f2_suggested_ncms
      )
      SELECT
        $2::uuid, rc.concept_id, rc.concept_revision_id, rc.membership_status,
        rc.release_notes, tg.id, rc.profile_visible, rc.display_order,
        rc.help_text, rc.classify_by_label, rc.official_codes, rc.f2_suggested_products, rc.f2_suggested_ncms
      FROM taxonomy_release_concepts rc
      LEFT JOIN taxonomy_release_groups sg ON sg.id = rc.group_id
      LEFT JOIN taxonomy_release_groups tg
        ON tg.release_id = $2::uuid
       AND tg.dimension_id = sg.dimension_id
       AND tg.code = sg.code
      WHERE rc.release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  await client.query(
    `
      INSERT INTO taxonomy_release_group_segments (
        release_id, group_id, segment_release_concept_id
      )
      SELECT $2::uuid, tg.id, trc.id
      FROM taxonomy_release_group_segments gs
      JOIN taxonomy_release_groups sg ON sg.id = gs.group_id
      JOIN taxonomy_release_groups tg
        ON tg.release_id = $2::uuid
       AND tg.dimension_id = sg.dimension_id
       AND tg.code = sg.code
      JOIN taxonomy_release_concepts src ON src.id = gs.segment_release_concept_id
      JOIN taxonomy_release_concepts trc
        ON trc.release_id = $2::uuid
       AND trc.concept_id = src.concept_id
      WHERE gs.release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  // F2-T02: carry verified Atuação–CNAE provenance into the next draft
  // using the same immutable concept identity, not the old release row IDs.
  await client.query(
    `
      INSERT INTO taxonomy_release_actuacao_cnae_origins
        (release_id, release_concept_id, cnae_code, source_line, source_sha256)
      SELECT $2::uuid, target_concept.id, source.cnae_code,
             source.source_line, source.source_sha256
      FROM taxonomy_release_actuacao_cnae_origins source
      JOIN taxonomy_release_concepts old_concept
        ON old_concept.id = source.release_concept_id
       AND old_concept.release_id = $1::uuid
      JOIN taxonomy_release_concepts target_concept
        ON target_concept.release_id = $2::uuid
       AND target_concept.concept_id = old_concept.concept_id
      WHERE source.release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  await client.query(
    `
      INSERT INTO taxonomy_release_relation_rules (
        release_id, relation_type_id, source_dimension_id,
        target_dimension_id, allowed, requires_evidence,
        acyclic_override, notes
      )
      SELECT
        $2::uuid, relation_type_id, source_dimension_id,
        target_dimension_id, allowed, requires_evidence,
        acyclic_override, notes
      FROM taxonomy_release_relation_rules
      WHERE release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  const bindings = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_release_alias_bindings (
        release_id, alias_id, release_concept_id, alias_type,
        decision_status, jurisdiction_level, uf, municipality_ibge_code,
        context, valid_from, valid_to, temporal_basis, justification,
        evidence_status
      )
      SELECT
        $2::uuid, b.alias_id, trc.id, b.alias_type,
        b.decision_status, b.jurisdiction_level, b.uf,
        b.municipality_ibge_code, b.context, b.valid_from, b.valid_to,
        b.temporal_basis, b.justification, b.evidence_status
      FROM taxonomy_release_alias_bindings b
      JOIN taxonomy_release_concepts src ON src.id = b.release_concept_id
      JOIN taxonomy_release_concepts trc
        ON trc.release_id = $2::uuid
       AND trc.concept_id = src.concept_id
      WHERE b.release_id = $1::uuid
      RETURNING id
    `,
    [sourceId, targetId],
  );

  await client.query(
    `
      INSERT INTO taxonomy_concept_relations (
        release_id, source_release_concept_id, target_release_concept_id,
        relation_type_id, status, valid_from, valid_to, qualifiers,
        justification, evidence_status
      )
      SELECT
        $2::uuid, tsrc.id, ttgt.id, rel.relation_type_id, rel.status,
        rel.valid_from, rel.valid_to, rel.qualifiers, rel.justification,
        rel.evidence_status
      FROM taxonomy_concept_relations rel
      JOIN taxonomy_release_concepts ssrc ON ssrc.id = rel.source_release_concept_id
      JOIN taxonomy_release_concepts stgt ON stgt.id = rel.target_release_concept_id
      JOIN taxonomy_release_concepts tsrc
        ON tsrc.release_id = $2::uuid AND tsrc.concept_id = ssrc.concept_id
      JOIN taxonomy_release_concepts ttgt
        ON ttgt.release_id = $2::uuid AND ttgt.concept_id = stgt.concept_id
      WHERE rel.release_id = $1::uuid
    `,
    [sourceId, targetId],
  );

  // Evidence rows are append-only and keyed by binding/relation/mapping ids.
  // R6 materialized none (see baseline limitations); refuse silently losing
  // them if a future release ever carries evidence.
  const evidence = await client.query<{ count: number }>(
    `
      SELECT (
        (SELECT count(*) FROM taxonomy_alias_binding_evidence e
           JOIN taxonomy_release_alias_bindings b ON b.id = e.alias_binding_id
          WHERE b.release_id = $1::uuid)
        + (SELECT count(*) FROM taxonomy_relation_evidence e
           JOIN taxonomy_concept_relations r ON r.id = e.relation_id
          WHERE r.release_id = $1::uuid)
        + (SELECT count(*) FROM taxonomy_official_mappings m
          WHERE m.release_id = $1::uuid)
      )::int AS count
    `,
    [sourceId],
  );
  if ((evidence.rows[0]?.count ?? 0) > 0) {
    throw new CurationError(
      'SOURCE_EVIDENCE_COPY_NOT_SUPPORTED',
      409,
      'A versão de origem possui evidências/mapeamentos oficiais que esta cópia não sabe preservar.',
    );
  }

  // Preserve multi-valued bindings across drafts; for the first v1.8.0
  // copy, migrate all immutable v1.7.0 one-to-one source origins without
  // modifying either source publication or its imported provenance.
  await client.query(`
    INSERT INTO taxonomy_release_cnae_actuacao(release_id,cnae_code,release_concept_id)
    SELECT $2::uuid, source.cnae_code, target_rc.id
    FROM (
      SELECT x.cnae_code, src_rc.concept_id
      FROM taxonomy_release_cnae_actuacao x
      JOIN taxonomy_release_concepts src_rc ON src_rc.id=x.release_concept_id
      WHERE x.release_id=$1::uuid
      UNION ALL
      SELECT o.cnae_code, src_rc.concept_id
      FROM taxonomy_release_actuacao_cnae_origins o
      JOIN taxonomy_release_concepts src_rc ON src_rc.id=o.release_concept_id
      WHERE o.release_id=$1::uuid
        AND NOT EXISTS (
          SELECT 1 FROM taxonomy_release_cnae_actuacao x
          WHERE x.release_id=$1::uuid AND x.cnae_code=o.cnae_code)
    ) source
    JOIN taxonomy_release_concepts target_rc
      ON target_rc.release_id=$2::uuid AND target_rc.concept_id=source.concept_id
    ON CONFLICT DO NOTHING
  `,[sourceId,targetId]);

  void bindings;
}

async function insertConceptRevision(
  client: PoolClient,
  releaseConceptId: string,
  patch: Partial<{
    label: string;
    definition: string;
    positiveExample: string | null;
    negativeExample: string | null;
    governanceStatus: string;
    evidenceStatus: string;
    notes: string | null;
  }>,
): Promise<boolean> {
  const current = await client.query<{
    concept_id: string;
    revision_id: string;
    label: string;
    definition: string;
    positive_example: string | null;
    negative_example: string | null;
    governance_status: string;
    evidence_status: string;
    notes: string | null;
    source_metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        rc.concept_id, cr.id AS revision_id, cr.label, cr.definition,
        cr.positive_example, cr.negative_example, cr.governance_status,
        cr.evidence_status, cr.notes, cr.source_metadata
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concept_revisions cr ON cr.id = rc.concept_revision_id
      WHERE rc.id = $1::uuid
    `,
    [releaseConceptId],
  );
  const row = current.rows[0];
  if (!row) throw new CurationError('CONCEPT_NOT_FOUND', 404);

  const next = {
    label: patch.label ?? row.label,
    definition: patch.definition ?? row.definition,
    positive_example:
      patch.positiveExample !== undefined
        ? patch.positiveExample
        : row.positive_example,
    negative_example:
      patch.negativeExample !== undefined
        ? patch.negativeExample
        : row.negative_example,
    governance_status: patch.governanceStatus ?? row.governance_status,
    evidence_status: patch.evidenceStatus ?? row.evidence_status,
    notes: patch.notes !== undefined ? patch.notes : row.notes,
  };

  const changed =
    next.label !== row.label ||
    next.definition !== row.definition ||
    next.positive_example !== row.positive_example ||
    next.negative_example !== row.negative_example ||
    next.governance_status !== row.governance_status ||
    next.evidence_status !== row.evidence_status ||
    next.notes !== row.notes;
  if (!changed) return false;

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_concept_revisions (
        concept_id, revision_no, label, definition, positive_example,
        negative_example, governance_status, evidence_status, notes,
        source_metadata
      )
      SELECT
        $1::uuid,
        COALESCE(max(revision_no), 0) + 1,
        $2, $3, $4, $5, $6, $7, $8,
        $9::jsonb
      FROM taxonomy_concept_revisions
      WHERE concept_id = $1::uuid
      RETURNING id
    `,
    [
      row.concept_id,
      next.label,
      next.definition,
      next.positive_example,
      next.negative_example,
      next.governance_status,
      next.evidence_status,
      next.notes,
      JSON.stringify({
        ...row.source_metadata,
        curatedFromRevisionId: row.revision_id,
        curatedBy: 'TAX-11',
      }),
    ],
  );

  await client.query(
    `UPDATE taxonomy_release_concepts
     SET concept_revision_id = $2::uuid
     WHERE id = $1::uuid`,
    [releaseConceptId, inserted.rows[0]!.id],
  );
  return true;
}

async function applyInitialCuration(
  client: PoolClient,
  draftId: string,
): Promise<Record<string, number>> {
  const view = await loadReleaseView(pgRunner(client), draftId, {
    includeRetired: true,
  });
  if (!view) throw new CurationError('DRAFT_NOT_FOUND', 500);

  const counts = {
    dimensionsConfigured: 0,
    groupsCreated: 0,
    conceptsGrouped: 0,
    labelsFixed: 0,
    codesSuggested: 0,
    labelClassificationDisabled: 0,
  };

  for (const dimension of view.dimensions) {
    const defaults = legacyDimensionDefaults(dimension.code);
    await client.query(
      `
        UPDATE taxonomy_release_dimensions
        SET profile_visible = $3,
            profile_order = $4,
            help_text = $5,
            detail_section = $6,
            detail_order = $7,
            uses_groups = $8,
            official_code_type = $9
        WHERE release_id = $1::uuid AND dimension_id = $2::uuid
      `,
      [
        draftId,
        dimension.id,
        defaults.profileVisible,
        defaults.profileOrder,
        defaults.helpText,
        defaults.detailSection,
        defaults.detailOrder,
        defaults.usesGroups,
        defaults.officialCodeType,
      ],
    );
    counts.dimensionsConfigured += 1;
  }

  await client.query(
    `
      UPDATE taxonomy_release_concepts rc
      SET profile_visible = true,
          classify_by_label = NOT (c.code = ANY($2::text[]))
      FROM taxonomy_concepts c
      WHERE rc.release_id = $1::uuid
        AND c.id = rc.concept_id
    `,
    [draftId, [...GENERIC_LABEL_CODES]],
  );
  counts.labelClassificationDisabled = view.concepts.filter((concept) =>
    GENERIC_LABEL_CODES.has(concept.code),
  ).length;

  const conceptByCode = new Map(
    view.concepts.map((concept) => [concept.code, concept]),
  );
  const dimensionByCode = new Map(
    view.dimensions.map((dimension) => [dimension.code, dimension]),
  );

  // The PO calls the sector dimension "Segmento" (Segmento -> Grupo -> Produto).
  const sector = dimensionByCode.get('sector')
  if (sector && sector.name === 'Setor') {
    const current = await client.query<{
      governance_status: string;
      constraints: Record<string, unknown>;
    }>(
      `SELECT dr.governance_status, dr.constraints
       FROM taxonomy_release_dimensions rd
       JOIN taxonomy_dimension_revisions dr ON dr.id = rd.dimension_revision_id
       WHERE rd.release_id = $1::uuid AND rd.dimension_id = $2::uuid`,
      [draftId, sector.id],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO taxonomy_dimension_revisions (
         dimension_id, revision_no, name, description, governance_status, constraints
       )
       SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, 'Segmento', $2, $3, $4::jsonb
       FROM taxonomy_dimension_revisions WHERE dimension_id = $1::uuid
       RETURNING id`,
      [
        sector.id,
        sector.description,
        current.rows[0]?.governance_status ?? 'PROPOSED',
        JSON.stringify(current.rows[0]?.constraints ?? {}),
      ],
    );
    await client.query(
      `UPDATE taxonomy_release_dimensions SET dimension_revision_id = $3::uuid
       WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
      [draftId, sector.id, revision.rows[0]!.id],
    );
  }

  for (const [dimensionCode, seed] of Object.entries(DIMENSION_SEEDS)) {
    const dimension = dimensionByCode.get(dimensionCode);
    if (!dimension) continue;

    for (const [groupIndex, group] of seed.groups.entries()) {
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO taxonomy_release_groups (
            release_id, dimension_id, code, label, display_order,
            detail_section, official_codes
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[])
          RETURNING id
        `,
        [
          draftId,
          dimension.id,
          group.code,
          group.label,
          groupIndex + 1,
          group.detailSection ?? null,
          group.officialCodes ?? [],
        ],
      );
      const groupId = inserted.rows[0]!.id;
      counts.groupsCreated += 1;

      for (const [memberIndex, member] of group.members.entries()) {
        const concept = conceptByCode.get(`${dimensionCode}.${member}`);
        if (!concept) continue;
        await client.query(
          `UPDATE taxonomy_release_concepts
           SET group_id = $2::uuid, display_order = $3, release_notes = $4
           WHERE id = $1::uuid`,
          [concept.releaseConceptId, groupId, memberIndex + 1, SEED_NOTE],
        );
        counts.conceptsGrouped += 1;
      }

      for (const segment of group.segments ?? []) {
        const sector = conceptByCode.get(`sector.${segment}`);
        if (!sector) continue;
        await client.query(
          `INSERT INTO taxonomy_release_group_segments (
             release_id, group_id, segment_release_concept_id
           ) VALUES ($1::uuid, $2::uuid, $3::uuid)
           ON CONFLICT DO NOTHING`,
          [draftId, groupId, sector.releaseConceptId],
        );
      }
    }
  }

  for (const [dimensionCode, codes] of Object.entries(OFFICIAL_CODE_SEEDS)) {
    for (const [suffix, values] of Object.entries(codes)) {
      const concept = conceptByCode.get(`${dimensionCode}.${suffix}`);
      if (!concept) continue;
      await client.query(
        `UPDATE taxonomy_release_concepts
         SET official_codes = $2::text[], release_notes = $3
         WHERE id = $1::uuid`,
        [concept.releaseConceptId, values, SEED_NOTE],
      );
      counts.codesSuggested += 1;
    }
  }

  for (const [suffix, fix] of Object.entries(DOCUMENT_LABEL_FIXES)) {
    const concept = conceptByCode.get(`document.${suffix}`);
    if (!concept) continue;
    const changed = await insertConceptRevision(
      client,
      concept.releaseConceptId,
      { label: fix.label },
    );
    if (changed) counts.labelsFixed += 1;
    await client.query(
      `UPDATE taxonomy_release_concepts
       SET official_codes = $2::text[], release_notes = $3
       WHERE id = $1::uuid`,
      [concept.releaseConceptId, fix.codes, SEED_NOTE],
    );
  }

  return counts;
}

export interface CreateDraftResult {
  draft: ReleaseSummary;
  sourceVersion: string;
  initialCuration: Record<string, number> | null;
}

export async function createDraft(
  client: PoolClient,
  actor: CuratorActor,
): Promise<CreateDraftResult> {
  assertJustification(actor);
  const run = pgRunner(client);

  if (await findOpenDraft(run)) {
    throw new CurationError('DRAFT_ALREADY_OPEN', 409);
  }

  const source = await findLatestPublishedRelease(run);
  if (!source) throw new CurationError('NO_PUBLISHED_RELEASE', 409);

  const sourceView = await loadReleaseView(run, source.id);
  const sourceConfigured =
    sourceView?.dimensions.some((dimension) => dimension.configured) ?? false;

  const sourceManifest = await client.query<{ manifest: unknown }>(
    'SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid',
    [source.id],
  );
  const inheritedCompatibility = parseTaxonomyCodeCompatibility(
    sourceManifest.rows[0]?.manifest,
  );

  const [major, minor, patch] = await nextVersion(client, source);
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_releases (
        version_major, version_minor, version_patch,
        status, previous_release_id, manifest, change_notes,
        created_by_actor
      ) VALUES (
        $1, $2, $3, 'DRAFT', $4::uuid, $5::jsonb, NULL, $6
      ) RETURNING id
    `,
    [
      major,
      minor,
      patch,
      source.id,
      JSON.stringify({
        kind: CURATED_RELEASE_KIND,
        sourceReleaseId: source.id,
        sourceVersion: source.version,
        taxonomyCompatibility: inheritedCompatibility,
      }),
      `curator:${actor.userId}`,
    ],
  );
  const draftId = inserted.rows[0]!.id;

  await copyReleaseGraph(client, source.id, draftId);
  const initialCuration = sourceConfigured
    ? null
    : await applyInitialCuration(client, draftId);

  const draft = await findRelease(run, draftId);
  await writeAudit(client, actor, 'TAXONOMY_CURATION_DRAFT_CREATED', draftId, {
    sourceReleaseId: source.id,
    sourceVersion: source.version,
    targetVersion: draft?.version,
    initialCuration,
  });

  return {
    draft: draft!,
    sourceVersion: source.version,
    initialCuration,
  };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export interface DimensionPatch {
  name?: string | undefined;
  description?: string | null | undefined;
  profileVisible?: boolean | undefined;
  profileOrder?: number | undefined;
  helpText?: string | null | undefined;
  detailSection?: string | null | undefined;
  detailOrder?: number | undefined;
  usesGroups?: boolean | undefined;
  officialCodeType?: OfficialCodeType | null | undefined;
}

async function requireDimension(
  client: PoolClient,
  draftId: string,
  code: string,
): Promise<{
  dimension_id: string;
  revision_id: string;
  name: string;
  description: string | null;
  governance_status: string;
  constraints: Record<string, unknown>;
}> {
  const result = await client.query(
    `
      SELECT
        d.id AS dimension_id, dr.id AS revision_id, dr.name,
        dr.description, dr.governance_status, dr.constraints
      FROM taxonomy_release_dimensions rd
      JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
      JOIN taxonomy_dimension_revisions dr ON dr.id = rd.dimension_revision_id
      WHERE rd.release_id = $1::uuid AND d.code = $2
    `,
    [draftId, code],
  );
  const row = result.rows[0];
  if (!row) throw new CurationError('DIMENSION_NOT_FOUND', 404);
  return row;
}

export async function updateDimension(
  client: PoolClient,
  actor: CuratorActor,
  code: string,
  patch: DimensionPatch,
): Promise<void> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const current = await requireDimension(client, draft.id, code);

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new CurationError('DIMENSION_NAME_REQUIRED');
  const description =
    patch.description !== undefined
      ? cleanText(patch.description)
      : current.description;

  if (name !== current.name || description !== current.description) {
    const revision = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_dimension_revisions (
          dimension_id, revision_no, name, description,
          governance_status, constraints
        )
        SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, $2, $3, $4, $5::jsonb
        FROM taxonomy_dimension_revisions
        WHERE dimension_id = $1::uuid
        RETURNING id
      `,
      [
        current.dimension_id,
        name,
        description,
        current.governance_status,
        JSON.stringify(current.constraints ?? {}),
      ],
    );
    await client.query(
      `UPDATE taxonomy_release_dimensions
       SET dimension_revision_id = $3::uuid
       WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
      [draft.id, current.dimension_id, revision.rows[0]!.id],
    );
  }

  if (
    patch.officialCodeType !== undefined &&
    patch.officialCodeType !== null &&
    !OFFICIAL_CODE_TYPES.includes(patch.officialCodeType)
  ) {
    throw new CurationError('INVALID_OFFICIAL_CODE_TYPE');
  }

  const sets: string[] = [];
  const params: unknown[] = [draft.id, current.dimension_id];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.profileVisible !== undefined) push('profile_visible', patch.profileVisible);
  if (patch.profileOrder !== undefined) push('profile_order', patch.profileOrder);
  if (patch.helpText !== undefined) push('help_text', cleanText(patch.helpText));
  if (patch.detailSection !== undefined) push('detail_section', cleanText(patch.detailSection));
  if (patch.detailOrder !== undefined) push('detail_order', patch.detailOrder);
  if (patch.usesGroups !== undefined) push('uses_groups', patch.usesGroups);
  if (patch.officialCodeType !== undefined) push('official_code_type', patch.officialCodeType);

  if (sets.length > 0) {
    await client.query(
      `UPDATE taxonomy_release_dimensions SET ${sets.join(', ')}
       WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
      params,
    );
  }

  await writeAudit(client, actor, 'TAXONOMY_CURATION_DIMENSION_UPDATED', draft.id, {
    dimension: code,
    patch,
  });
}

async function dimensionCodeType(
  client: PoolClient,
  draftId: string,
  dimensionId: string,
): Promise<OfficialCodeType | null> {
  const result = await client.query<{ official_code_type: OfficialCodeType | null }>(
    `SELECT official_code_type FROM taxonomy_release_dimensions
     WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
    [draftId, dimensionId],
  );
  return result.rows[0]?.official_code_type ?? null;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupInput {
  label?: string | undefined;
  code?: string | undefined;
  displayOrder?: number | undefined;
  helpText?: string | null | undefined;
  detailSection?: string | null | undefined;
  officialCodes?: string[] | undefined;
  segmentCodes?: string[] | undefined;
}

async function setGroupSegments(
  client: PoolClient,
  draftId: string,
  groupId: string,
  segmentCodes: readonly string[],
): Promise<void> {
  await client.query(
    `DELETE FROM taxonomy_release_group_segments WHERE group_id = $1::uuid`,
    [groupId],
  );
  if (segmentCodes.length === 0) return;

  const found = await client.query<{
    id: string;
    code: string;
    membership_status: string;
    official_codes: string[] | null;
  }>(
    `
      SELECT rc.id, c.code, rc.membership_status, rc.official_codes
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      WHERE rc.release_id = $1::uuid
        AND d.code = 'sector'
        AND c.code = ANY($2::text[])
    `,
    [draftId, [...new Set(segmentCodes)]],
  );
  // Only items of the Segmento table qualify: included, and not a CNAE
  // activity (7-digit code), which belongs to a subsegment instead.
  const missing = segmentCodes.filter(
    (code) =>
      !found.rows.some((row) => row.code === code && row.membership_status === 'INCLUDED'),
  );
  if (missing.length > 0) {
    throw new CurationError(
      'UNKNOWN_SEGMENT',
      400,
      `Segmento(s) inexistente(s) na tabela Segmento: ${missing.join(', ')}`,
    );
  }
  const activities = found.rows.filter((row) => isCnaeActivity(row.official_codes ?? []));
  if (activities.length > 0) {
    throw new CurationError(
      'NOT_A_SEGMENT',
      400,
      `Atividade CNAE não é segmento: ${activities.map((row) => row.code).join(', ')}`,
    );
  }
  for (const row of found.rows) {
    await client.query(
      `INSERT INTO taxonomy_release_group_segments (
         release_id, group_id, segment_release_concept_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [draftId, groupId, row.id],
    );
  }
}

/**
 * Takes a whole dimension out of the DRAFT: its items are retired (so they
 * no longer tag acts nor appear in the profile) and the dimension leaves the
 * release. Previous releases keep it; nothing is published here.
 */
export interface RetireDimensionResult {
  retiredConcepts: string[];
  removedGroups: number;
  removedRelationRules: number;
  removedRelations: number;
  removedOfficialMappings: number;
}

export async function retireDimension(
  client: PoolClient,
  actor: CuratorActor,
  code: string,
  options: { recordRetiredCodes?: boolean } = {},
): Promise<RetireDimensionResult> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const current = await requireDimension(client, draft.id, code);
  const concepts = await client.query<{
    release_concept_id: string;
    code: string;
    membership_status: string;
  }>(
    `
      SELECT rc.id AS release_concept_id, c.code, rc.membership_status
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      WHERE rc.release_id = $1::uuid
        AND c.dimension_id = $2::uuid
      ORDER BY c.code
    `,
    [draft.id, current.dimension_id],
  );
  const conceptIds = concepts.rows.map((row) => row.release_concept_id);
  // Compatibility must cover the full historical identity space of a retired
  // dimension, not only concepts still materialized in the current draft.
  // Old monitoring/company profiles can legitimately contain codes whose
  // taxonomy_concepts identity survived after its release membership vanished.
  const historicalConcepts = await client.query<{ code: string }>(
    `
      SELECT c.code
      FROM taxonomy_concepts c
      WHERE c.dimension_id = $1::uuid
      ORDER BY c.code
    `,
    [current.dimension_id],
  );
  const historicalCodes = historicalConcepts.rows.map((row) => row.code);

  if (conceptIds.length > 0) {
    const evidence = await client.query<{ relation_evidence: number; mapping_evidence: number }>(
      `
        SELECT
          (
            SELECT count(*)::int
            FROM taxonomy_relation_evidence e
            JOIN taxonomy_concept_relations r ON r.id = e.relation_id
            WHERE r.release_id = $1::uuid
              AND (
                r.source_release_concept_id = ANY($2::uuid[])
                OR r.target_release_concept_id = ANY($2::uuid[])
              )
          ) AS relation_evidence,
          (
            SELECT count(*)::int
            FROM taxonomy_official_mapping_evidence e
            JOIN taxonomy_official_mappings m ON m.id = e.official_mapping_id
            WHERE m.release_id = $1::uuid
              AND m.release_concept_id = ANY($2::uuid[])
          ) AS mapping_evidence
      `,
      [draft.id, conceptIds],
    );
    const row = evidence.rows[0];
    if ((row?.relation_evidence ?? 0) > 0 || (row?.mapping_evidence ?? 0) > 0) {
      throw new CurationError(
        'RETIRED_DIMENSION_HAS_EVIDENCE',
        409,
        'A dimensão possui relações/mapeamentos com evidência e não pode ser retirada sem migração explícita.',
      );
    }
  }

  let removedRelations = 0;
  let removedOfficialMappings = 0;
  if (conceptIds.length > 0) {
    const relations = await client.query(
      `
        DELETE FROM taxonomy_concept_relations
        WHERE release_id = $1::uuid
          AND (
            source_release_concept_id = ANY($2::uuid[])
            OR target_release_concept_id = ANY($2::uuid[])
          )
      `,
      [draft.id, conceptIds],
    );
    removedRelations = relations.rowCount ?? 0;

    const mappings = await client.query(
      `
        DELETE FROM taxonomy_official_mappings
        WHERE release_id = $1::uuid
          AND release_concept_id = ANY($2::uuid[])
      `,
      [draft.id, conceptIds],
    );
    removedOfficialMappings = mappings.rowCount ?? 0;
  }

  const relationRules = await client.query(
    `
      DELETE FROM taxonomy_release_relation_rules
      WHERE release_id = $1::uuid
        AND (source_dimension_id = $2::uuid OR target_dimension_id = $2::uuid)
    `,
    [draft.id, current.dimension_id],
  );

  const groups = await client.query<{ id: string }>(
    `
      SELECT id
      FROM taxonomy_release_groups
      WHERE release_id = $1::uuid AND dimension_id = $2::uuid
    `,
    [draft.id, current.dimension_id],
  );
  const groupIds = groups.rows.map((row) => row.id);
  if (groupIds.length > 0) {
    await client.query(
      `
        UPDATE taxonomy_release_concepts
        SET group_id = NULL
        WHERE release_id = $1::uuid AND group_id = ANY($2::uuid[])
      `,
      [draft.id, groupIds],
    );
    await client.query(
      'DELETE FROM taxonomy_release_group_segments WHERE group_id = ANY($1::uuid[])',
      [groupIds],
    );
    await client.query(
      'DELETE FROM taxonomy_release_groups WHERE id = ANY($1::uuid[])',
      [groupIds],
    );
  }

  const included = concepts.rows.filter((row) => row.membership_status === 'INCLUDED');
  for (const row of included) {
    await updateConcept(client, actor, row.code, { membershipStatus: 'RETIRED' });
  }

  await client.query(
    `UPDATE taxonomy_release_dimensions
     SET membership_status = 'RETIRED', profile_visible = FALSE
     WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
    [draft.id, current.dimension_id],
  );

  if (options.recordRetiredCodes !== false) {
    await updateDraftTaxonomyCodeCompatibility(client, draft.id, {
      retiredCodes: historicalCodes,
    });
  }

  const result: RetireDimensionResult = {
    retiredConcepts: concepts.rows.map((row) => row.code),
    removedGroups: groupIds.length,
    removedRelationRules: relationRules.rowCount ?? 0,
    removedRelations,
    removedOfficialMappings,
  };
  await writeAudit(client, actor, 'TAXONOMY_CURATION_DIMENSION_RETIRED', draft.id, {
    code,
    ...result,
  });
  return result;
}

export async function createGroup(
  client: PoolClient,
  actor: CuratorActor,
  dimensionCode: string,
  input: GroupInput,
): Promise<string> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const dimension = await requireDimension(client, draft.id, dimensionCode);
  const label = input.label?.trim();
  if (!label) throw new CurationError('GROUP_LABEL_REQUIRED');
  const code = input.code?.trim() || slugify(label);
  if (!code) throw new CurationError('GROUP_CODE_REQUIRED');
  const type = await dimensionCodeType(client, draft.id, dimension.dimension_id);

  const order =
    input.displayOrder ??
    (
      await client.query<{ next: number }>(
        `SELECT COALESCE(max(display_order), 0) + 1 AS next
         FROM taxonomy_release_groups
         WHERE release_id = $1::uuid AND dimension_id = $2::uuid`,
        [draft.id, dimension.dimension_id],
      )
    ).rows[0]!.next;

  let groupId: string;
  try {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_release_groups (
          release_id, dimension_id, code, label, display_order,
          help_text, detail_section, official_codes
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text[])
        RETURNING id
      `,
      [
        draft.id,
        dimension.dimension_id,
        code,
        label,
        order,
        cleanText(input.helpText),
        cleanText(input.detailSection),
        normalizeCodes(type, input.officialCodes ?? []),
      ],
    );
    groupId = inserted.rows[0]!.id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurationError('GROUP_ALREADY_EXISTS', 409);
    }
    throw error;
  }

  if (input.segmentCodes) {
    await setGroupSegments(client, draft.id, groupId, input.segmentCodes);
  }

  await writeAudit(client, actor, 'TAXONOMY_CURATION_GROUP_CREATED', draft.id, {
    dimension: dimensionCode,
    groupId,
    input,
  });
  return groupId;
}

async function requireGroup(
  client: PoolClient,
  draftId: string,
  groupId: string,
): Promise<{ id: string; dimension_id: string }> {
  const result = await client.query<{ id: string; dimension_id: string }>(
    `SELECT id, dimension_id FROM taxonomy_release_groups
     WHERE id = $1::uuid AND release_id = $2::uuid`,
    [groupId, draftId],
  );
  const row = result.rows[0];
  if (!row) throw new CurationError('GROUP_NOT_FOUND', 404);
  return row;
}

export async function updateGroup(
  client: PoolClient,
  actor: CuratorActor,
  groupId: string,
  input: GroupInput,
): Promise<void> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const group = await requireGroup(client, draft.id, groupId);
  const type = await dimensionCodeType(client, draft.id, group.dimension_id);

  const sets: string[] = [];
  const params: unknown[] = [groupId];
  const push = (column: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) throw new CurationError('GROUP_LABEL_REQUIRED');
    push('label', label);
  }
  if (input.displayOrder !== undefined) push('display_order', input.displayOrder);
  if (input.helpText !== undefined) push('help_text', cleanText(input.helpText));
  if (input.detailSection !== undefined) push('detail_section', cleanText(input.detailSection));
  if (input.officialCodes !== undefined) {
    push('official_codes', normalizeCodes(type, input.officialCodes), '::text[]');
  }
  if (sets.length > 0) {
    await client.query(
      `UPDATE taxonomy_release_groups SET ${sets.join(', ')} WHERE id = $1::uuid`,
      params,
    );
  }
  if (input.segmentCodes !== undefined) {
    await setGroupSegments(client, draft.id, groupId, input.segmentCodes);
  }

  await writeAudit(client, actor, 'TAXONOMY_CURATION_GROUP_UPDATED', draft.id, {
    groupId,
    input,
  });
}

export async function deleteGroup(
  client: PoolClient,
  actor: CuratorActor,
  groupId: string,
): Promise<void> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  await requireGroup(client, draft.id, groupId);
  await client.query(
    `UPDATE taxonomy_release_concepts SET group_id = NULL
     WHERE release_id = $1::uuid AND group_id = $2::uuid`,
    [draft.id, groupId],
  );
  await client.query(
    `DELETE FROM taxonomy_release_groups WHERE id = $1::uuid`,
    [groupId],
  );
  await writeAudit(client, actor, 'TAXONOMY_CURATION_GROUP_DELETED', draft.id, {
    groupId,
  });
}

// ---------------------------------------------------------------------------
// Concepts (items)
// ---------------------------------------------------------------------------

export interface ConceptAliasInput {
  text: string;
  aliasType: AliasType;
}

export interface ConceptInput {
  label?: string | undefined;
  definition?: string | undefined;
  positiveExample?: string | null | undefined;
  negativeExample?: string | null | undefined;
  governanceStatus?: string | undefined;
  evidenceStatus?: string | undefined;
  notes?: string | null | undefined;
  groupId?: string | null | undefined;
  profileVisible?: boolean | undefined;
  displayOrder?: number | null | undefined;
  helpText?: string | null | undefined;
  classifyByLabel?: boolean | undefined;
  officialCodes?: string[] | undefined;
  aliases?: ConceptAliasInput[] | undefined;
  membershipStatus?: 'INCLUDED' | 'RETIRED' | undefined;
}

async function requireDraftConcept(
  client: PoolClient,
  draftId: string,
  code: string,
): Promise<{ id: string; dimension_id: string; concept_id: string }> {
  const result = await client.query<{
    id: string;
    dimension_id: string;
    concept_id: string;
  }>(
    `
      SELECT rc.id, c.dimension_id, c.id AS concept_id
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      WHERE rc.release_id = $1::uuid AND c.code = $2
    `,
    [draftId, code],
  );
  const row = result.rows[0];
  if (!row) throw new CurationError('CONCEPT_NOT_FOUND', 404);
  return row;
}

async function setConceptAliases(
  client: PoolClient,
  draftId: string,
  releaseConceptId: string,
  aliases: readonly ConceptAliasInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM taxonomy_release_alias_bindings
     WHERE release_id = $1::uuid AND release_concept_id = $2::uuid`,
    [draftId, releaseConceptId],
  );

  const seen = new Set<string>();
  for (const alias of aliases) {
    const text = alias.text.trim();
    if (!text) continue;
    if (!ALIAS_TYPES.includes(alias.aliasType)) {
      throw new CurationError('INVALID_ALIAS_TYPE');
    }
    const normalized = normalizeAliasText(text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    const aliasRow = await client.query<{ id: string }>(
      `
        WITH inserted AS (
          INSERT INTO taxonomy_aliases (text, normalized_text, language)
          VALUES ($1, $2, 'pt-BR')
          ON CONFLICT (normalized_text, language) DO NOTHING
          RETURNING id
        )
        SELECT id FROM inserted
        UNION ALL
        SELECT id FROM taxonomy_aliases
        WHERE normalized_text = $2 AND language = 'pt-BR'
        LIMIT 1
      `,
      [text, normalized],
    );

    await client.query(
      `
        INSERT INTO taxonomy_release_alias_bindings (
          release_id, alias_id, release_concept_id, alias_type,
          decision_status, justification, evidence_status
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, 'APPROVED',
          'Curadoria TAX-11', 'NOT_ASSESSED'
        )
      `,
      [draftId, aliasRow.rows[0]!.id, releaseConceptId, alias.aliasType],
    );
  }
}

async function applyConceptSettings(
  client: PoolClient,
  draftId: string,
  releaseConceptId: string,
  dimensionId: string,
  input: ConceptInput,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [releaseConceptId];
  const push = (column: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (input.groupId !== undefined) {
    if (input.groupId !== null) {
      const group = await requireGroup(client, draftId, input.groupId);
      if (group.dimension_id !== dimensionId) {
        throw new CurationError('GROUP_DIMENSION_MISMATCH');
      }
    }
    push('group_id', input.groupId, '::uuid');
  }
  if (input.profileVisible !== undefined) push('profile_visible', input.profileVisible);
  if (input.displayOrder !== undefined) push('display_order', input.displayOrder);
  if (input.helpText !== undefined) push('help_text', cleanText(input.helpText));
  if (input.classifyByLabel !== undefined) push('classify_by_label', input.classifyByLabel);
  if (input.officialCodes !== undefined) {
    const type = await dimensionCodeType(client, draftId, dimensionId);
    push('official_codes', normalizeCodes(type, input.officialCodes), '::text[]');
  }
  if (input.membershipStatus !== undefined) {
    if (!['INCLUDED', 'RETIRED'].includes(input.membershipStatus)) {
      throw new CurationError('INVALID_MEMBERSHIP_STATUS');
    }
    push('membership_status', input.membershipStatus);
  }
  if (sets.length > 0) {
    await client.query(
      `UPDATE taxonomy_release_concepts SET ${sets.join(', ')} WHERE id = $1::uuid`,
      params,
    );
  }
  if (input.aliases !== undefined) {
    await setConceptAliases(client, draftId, releaseConceptId, input.aliases);
  }
}

export function validateSemanticInput(input: ConceptInput): void {
  if (
    input.governanceStatus !== undefined &&
    !(GOVERNANCE_STATUSES as readonly string[]).includes(input.governanceStatus)
  ) {
    throw new CurationError('INVALID_GOVERNANCE_STATUS');
  }
  if (
    input.evidenceStatus !== undefined &&
    !(EVIDENCE_STATUSES as readonly string[]).includes(input.evidenceStatus)
  ) {
    throw new CurationError('INVALID_EVIDENCE_STATUS');
  }
  if (input.label !== undefined && !input.label.trim()) {
    throw new CurationError('LABEL_REQUIRED');
  }
  if (input.definition !== undefined && !input.definition.trim()) {
    throw new CurationError('DEFINITION_REQUIRED');
  }
}

/**
 * Code generated from the item name (dimension.slug). When another item
 * already uses it, a numeric suffix keeps it unique; a historical concept of
 * the same dimension outside the draft is reused (same identity).
 */
async function availableConceptCode(
  client: PoolClient,
  draftId: string,
  dimensionId: string,
  base: string,
): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}_${attempt}`;
    const found = await client.query<{ dimension_id: string; in_draft: boolean }>(
      `
        SELECT c.dimension_id,
          EXISTS (
            SELECT 1 FROM taxonomy_release_concepts rc
            WHERE rc.release_id = $2::uuid AND rc.concept_id = c.id
          ) AS in_draft
        FROM taxonomy_concepts c
        WHERE c.code = $1
      `,
      [candidate, draftId],
    );
    const row = found.rows[0];
    if (!row || (!row.in_draft && row.dimension_id === dimensionId)) return candidate;
  }
  throw new CurationError('CONCEPT_CODE_EXHAUSTED', 409);
}

export async function createConcept(
  client: PoolClient,
  actor: CuratorActor,
  dimensionCode: string,
  input: ConceptInput & { code?: string | undefined },
): Promise<string> {
  assertJustification(actor);
  validateSemanticInput(input);
  const draft = await requireOpenDraft(client);
  const dimension = await requireDimension(client, draft.id, dimensionCode);
  const label = input.label?.trim();
  if (!label) throw new CurationError('LABEL_REQUIRED');

  const explicitCode = input.code?.trim();
  const suffix = explicitCode
    ? explicitCode.replace(new RegExp(`^${dimensionCode}\\.`), '')
    : slugify(label) || 'item';
  let code = `${dimensionCode}.${suffix}`;
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(code)) {
    throw new CurationError('INVALID_CONCEPT_CODE');
  }
  if (!explicitCode) {
    code = await availableConceptCode(client, draft.id, dimension.dimension_id, code);
  }

  const existing = await client.query<{
    id: string;
    dimension_id: string;
    in_draft: boolean;
  }>(
    `
      SELECT c.id, c.dimension_id,
        EXISTS (
          SELECT 1 FROM taxonomy_release_concepts rc
          WHERE rc.release_id = $2::uuid AND rc.concept_id = c.id
        ) AS in_draft
      FROM taxonomy_concepts c
      WHERE c.code = $1
    `,
    [code, draft.id],
  );

  let conceptId: string;
  const found = existing.rows[0];
  if (found) {
    if (found.in_draft) throw new CurationError('CONCEPT_ALREADY_EXISTS', 409);
    if (found.dimension_id !== dimension.dimension_id) {
      throw new CurationError('CONCEPT_CODE_TAKEN', 409);
    }
    conceptId = found.id;
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO taxonomy_concepts (code, dimension_id, identity_status)
       VALUES ($1, $2::uuid, 'CURRENT') RETURNING id`,
      [code, dimension.dimension_id],
    );
    conceptId = inserted.rows[0]!.id;
  }

  const revision = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_concept_revisions (
        concept_id, revision_no, label, definition, positive_example,
        negative_example, governance_status, evidence_status, notes,
        source_metadata
      )
      SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, $2, $3, $4, $5,
             $6, $7, $8, '{"createdBy":"TAX-11 curation"}'::jsonb
      FROM taxonomy_concept_revisions WHERE concept_id = $1::uuid
      RETURNING id
    `,
    [
      conceptId,
      label,
      input.definition?.trim() || label,
      cleanText(input.positiveExample),
      cleanText(input.negativeExample),
      input.governanceStatus ?? 'PROPOSED',
      input.evidenceStatus ?? 'NOT_ASSESSED',
      cleanText(input.notes),
    ],
  );

  const releaseConcept = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_release_concepts (
        release_id, concept_id, concept_revision_id, membership_status,
        profile_visible, classify_by_label
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCLUDED', true, true)
      RETURNING id
    `,
    [draft.id, conceptId, revision.rows[0]!.id],
  );
  const releaseConceptId = releaseConcept.rows[0]!.id;

  await applyConceptSettings(client, draft.id, releaseConceptId, dimension.dimension_id, {
    ...input,
    membershipStatus: undefined,
  });

  await writeAudit(client, actor, 'TAXONOMY_CURATION_CONCEPT_CREATED', draft.id, {
    code,
    input,
  });
  return code;
}

export async function updateConcept(
  client: PoolClient,
  actor: CuratorActor,
  code: string,
  input: ConceptInput,
): Promise<void> {
  assertJustification(actor);
  validateSemanticInput(input);
  const draft = await requireOpenDraft(client);
  const concept = await requireDraftConcept(client, draft.id, code);

  await insertConceptRevision(client, concept.id, {
    ...(input.label !== undefined ? { label: input.label.trim() } : {}),
    ...(input.definition !== undefined ? { definition: input.definition.trim() } : {}),
    ...(input.positiveExample !== undefined ? { positiveExample: cleanText(input.positiveExample) } : {}),
    ...(input.negativeExample !== undefined ? { negativeExample: cleanText(input.negativeExample) } : {}),
    ...(input.governanceStatus !== undefined ? { governanceStatus: input.governanceStatus } : {}),
    ...(input.evidenceStatus !== undefined ? { evidenceStatus: input.evidenceStatus } : {}),
    ...(input.notes !== undefined ? { notes: cleanText(input.notes) } : {}),
  });

  await applyConceptSettings(client, draft.id, concept.id, concept.dimension_id, input);

  await writeAudit(client, actor, 'TAXONOMY_CURATION_CONCEPT_UPDATED', draft.id, {
    code,
    input,
  });
}

// ---------------------------------------------------------------------------
// Spreadsheet import (one row per item)
// ---------------------------------------------------------------------------

/**
 * One spreadsheet row. For group/codes/synonyms, `undefined` means "keep the
 * current value" (column absent or cell blank) and null/[] means "clear"
 * (cell with "—" or "-"). Blank cells never erase curated data.
 */
export interface ImportRow {
  line: number;
  group: string | null | undefined;
  item: string;
  officialCodes: string[] | undefined;
  synonyms: string[] | undefined;
  profileVisible: boolean | null;
  classifyByLabel?: boolean | null | undefined;
  definition?: string | undefined;
  displayOrder: number | null;
  code: string | null;
}

export interface ImportReport {
  created: number;
  updated: number;
  groupsCreated: number;
  errors: Array<{ line: number; message: string }>;
  warnings: Array<{ line: number; message: string }>;
}

export async function importDimensionRows(
  client: PoolClient,
  actor: CuratorActor,
  dimensionCode: string,
  rows: readonly ImportRow[],
): Promise<ImportReport> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const view = await loadReleaseView(pgRunner(client), draft.id, {
    includeRetired: true,
  });
  if (!view) throw new CurationError('DRAFT_NOT_FOUND', 500);
  await requireDimension(client, draft.id, dimensionCode);

  const report: ImportReport = { created: 0, updated: 0, groupsCreated: 0, errors: [], warnings: [] };
  const concepts = view.concepts.filter((c) => c.dimensionCode === dimensionCode);
  const byCode = new Map(concepts.map((c) => [c.code, c]));
  const byLabel = new Map(concepts.map((c) => [normalizeAliasText(c.label), c]));
  const groupIds = new Map(
    view.groups
      .filter((group) => group.dimensionCode === dimensionCode)
      .map((group) => [normalizeAliasText(group.label), group.id]),
  );

  for (const row of rows) {
    await client.query('SAVEPOINT import_row');
    const groupsCreatedInRow: string[] = [];
    try {
      let groupId: string | null | undefined;
      if (row.group === null) {
        groupId = null;
      } else if (row.group) {
        const key = normalizeAliasText(row.group);
        groupId = groupIds.get(key);
        if (!groupId) {
          groupId = await createGroup(client, actor, dimensionCode, {
            label: row.group,
          });
          groupIds.set(key, groupId);
          groupsCreatedInRow.push(key);
        }
      }

      const input: ConceptInput = {
        label: row.item,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(row.officialCodes !== undefined ? { officialCodes: row.officialCodes } : {}),
        ...(row.profileVisible !== null ? { profileVisible: row.profileVisible } : {}),
        ...(row.classifyByLabel !== null && row.classifyByLabel !== undefined
          ? { classifyByLabel: row.classifyByLabel }
          : {}),
        ...(row.definition ? { definition: row.definition } : {}),
        ...(row.displayOrder !== null ? { displayOrder: row.displayOrder } : {}),
      };
      const synonyms = row.synonyms?.map((text) => ({
        text,
        aliasType: 'EXACT_LEXICAL' as const,
      }));

      // "Código TriBusca" filled = update that item; blank = new item.
      const existing = row.code ? byCode.get(row.code) : undefined;
      if (row.code && !existing) {
        throw new CurationError(
          'CONCEPT_NOT_FOUND',
          404,
          `Código TriBusca “${row.code}” não existe nesta tabela (deixe em branco para criar um item novo)`,
        );
      }

      if (existing) {
        const aliasUpdate =
          synonyms === undefined
            ? {}
            : {
                // Spreadsheet synonyms replace the "equivalente exato" list;
                // other alias types (siglas, nomes antigos…) are kept, and a
                // synonym already known keeps its type, so exporting and
                // importing the same sheet changes nothing.
                aliases: (() => {
                  const known = new Map(
                    (existing.aliases as ConceptAliasInput[]).map((alias) => [
                      normalizeAliasText(alias.text),
                      alias,
                    ]),
                  );
                  const inSheet = new Set(synonyms.map((item) => normalizeAliasText(item.text)));
                  return [
                    ...(existing.aliases as ConceptAliasInput[]).filter(
                      (alias) =>
                        alias.aliasType !== 'EXACT_LEXICAL' &&
                        !inSheet.has(normalizeAliasText(alias.text)),
                    ),
                    ...synonyms.map((item) => known.get(normalizeAliasText(item.text)) ?? item),
                  ];
                })(),
              };
        await updateConcept(client, actor, existing.code, {
          ...input,
          ...aliasUpdate,
          membershipStatus: 'INCLUDED',
        });
        report.updated += 1;
      } else {
        const sameName = byLabel.get(normalizeAliasText(row.item));
        const code = await createConcept(client, actor, dimensionCode, {
          ...input,
          ...(synonyms ? { aliases: synonyms } : {}),
        });
        if (sameName) {
          report.warnings.push({
            line: row.line,
            message: `“${row.item}” já existia (${sameName.code}); criado como item novo ${code}. Para atualizar o existente, preencha o Código TriBusca.`,
          });
        }
        byLabel.set(normalizeAliasText(row.item), {
          code,
          aliases: synonyms ?? [],
        } as unknown as ConceptView);
        report.created += 1;
      }
      await client.query('RELEASE SAVEPOINT import_row');
      report.groupsCreated += groupsCreatedInRow.length;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT import_row');
      // The rollback also undid groups created by this row.
      for (const key of groupsCreatedInRow) groupIds.delete(key);
      report.errors.push({
        line: row.line,
        message: error instanceof Error ? error.message : 'Erro desconhecido',
      });
    }
  }

  await writeAudit(client, actor, 'TAXONOMY_CURATION_IMPORT', draft.id, {
    dimension: dimensionCode,
    rows: rows.length,
    created: report.created,
    updated: report.updated,
    errors: report.errors.length,
  });
  return report;
}

/**
 * One row of the spreadsheet-like editor. `code` null = new row (code is
 * generated from the label). `group` undefined keeps the current group,
 * null clears it, a label links (or creates) the group.
 */
export interface GridRowInput {
  code: string | null;
  group?: string | null | undefined;
  label: string;
  officialCodes: string[];
  /** F2-TAB-03, required when adding a CNAE in v1.8.0. */
  actuacaoCodes?: string[];
  aliases: ConceptAliasInput[];
  profileVisible: boolean;
  classifyByLabel: boolean;
  displayOrder: number | null;
}

export interface GridSaveResult {
  created: string[];
  updated: number;
  retired: number;
  groupsCreated: number;
  groupsUpdated: number;
}

/**
 * Saves every pending change of the editor at once. All-or-nothing: the
 * first invalid row aborts the whole save (the caller's transaction rolls
 * back) and the error names the row.
 */
export async function saveDimensionRows(
  client: PoolClient,
  actor: CuratorActor,
  dimensionCode: string,
  input: {
    rows: readonly GridRowInput[];
    retire: readonly string[];
    /** Segment of each group, edited in the grid's Segmento column. */
    groupSegments?: ReadonlyArray<{ group: string; segmentCodes: string[] }> | undefined;
  },
): Promise<GridSaveResult> {
  assertJustification(actor);
  const draft = await requireOpenDraft(client);
  const view = await loadReleaseView(pgRunner(client), draft.id, { includeRetired: true });
  if (!view) throw new CurationError('DRAFT_NOT_FOUND', 500);
  await requireDimension(client, draft.id, dimensionCode);

  const concepts = new Map(
    view.concepts.filter((c) => c.dimensionCode === dimensionCode).map((c) => [c.code, c]),
  );
  const groupIds = new Map(
    view.groups
      .filter((group) => group.dimensionCode === dimensionCode)
      .map((group) => [normalizeAliasText(group.label), group.id]),
  );
  const result: GridSaveResult = { created: [], updated: 0, retired: 0, groupsCreated: 0, groupsUpdated: 0 };

  for (const [index, row] of input.rows.entries()) {
    const label = row.label.trim();
    const where = `Linha ${index + 1}${label ? ` (“${label}”)` : ''}`;
    try {
      if (!label) throw new CurationError('LABEL_REQUIRED', 400, 'o nome do item é obrigatório');
      let groupId: string | null | undefined;
      if (row.group === null || row.group?.trim() === '') {
        groupId = row.group === undefined ? undefined : null;
      } else if (row.group) {
        const key = normalizeAliasText(row.group);
        groupId = groupIds.get(key);
        if (!groupId) {
          groupId = await createGroup(client, actor, dimensionCode, { label: row.group.trim() });
          groupIds.set(key, groupId);
          result.groupsCreated += 1;
        }
      }
      const fields: ConceptInput = {
        label,
        ...(groupId !== undefined ? { groupId } : {}),
        officialCodes: row.officialCodes,
        aliases: row.aliases,
        profileVisible: row.profileVisible,
        classifyByLabel: row.classifyByLabel,
        displayOrder: row.displayOrder,
      };
      if (row.code) {
        if (!concepts.has(row.code)) throw new CurationError('CONCEPT_NOT_FOUND', 404);
        await updateConcept(client, actor, row.code, fields);
        result.updated += 1;
      } else {
        const created=await createConcept(client, actor, dimensionCode, fields);
        // A new CNAE cannot enter the v1.8 DRAFT without 1+ valid Atuações.
        // This is part of the same curator transaction as row creation.
        if(draft.version==='v1.8.0'&&dimensionCode==='sector'&&
           row.officialCodes.length===1&&/^\d{7}$/.test(row.officialCodes[0]??'')){
          const codes=row.actuacaoCodes??[];
          if(codes.length<1)throw new CurationError('F2_TAB03_LAST_ACTUACAO_REQUIRED',422);
          if(codes.length>12||new Set(codes).size!==codes.length||
            codes.some(x=>!/^actuacao\.[a-z0-9_]+$/.test(x)))
            throw new CurationError('F2_TAB03_INVALID_ACTUACAO',422);
          const eligible=await client.query<{id:string}>(`
            SELECT rc.id FROM taxonomy_release_concepts rc
            JOIN taxonomy_concepts c ON c.id=rc.concept_id
            JOIN taxonomy_dimensions d ON d.id=c.dimension_id
            JOIN taxonomy_release_dimensions rd
              ON rd.release_id=rc.release_id AND rd.dimension_id=d.id
            WHERE rc.release_id=$1::uuid AND rc.membership_status='INCLUDED'
              AND rd.membership_status='INCLUDED' AND d.code='actuacao'
              AND c.code=ANY($2::text[])
          `,[draft.id,codes]);
          if(eligible.rows.length!==codes.length)
            throw new CurationError('F2_TAB03_ACTUACAO_NOT_IN_DRAFT',422);
          await client.query(`
            INSERT INTO taxonomy_release_cnae_actuacao(release_id,cnae_code,release_concept_id)
            SELECT $1::uuid,$2,unnest($3::uuid[])
          `,[draft.id,row.officialCodes[0],eligible.rows.map(x=>x.id)]);
        }
        result.created.push(created);
      }
    } catch (error) {
      const message =
        error instanceof CurationError
          ? error.message !== error.code
            ? error.message
            : error.code
          : error instanceof Error
            ? error.message
            : 'erro desconhecido';
      throw new CurationError('ROW_INVALID', 400, `${where}: ${message}`);
    }
  }

  for (const { group, segmentCodes } of input.groupSegments ?? []) {
    const groupId = groupIds.get(normalizeAliasText(group));
    if (!groupId) throw new CurationError('GROUP_NOT_FOUND', 404, `Grupo “${group}” não encontrado`);
    try {
      await updateGroup(client, actor, groupId, { segmentCodes });
    } catch (error) {
      const message = error instanceof CurationError && error.message !== error.code ? error.message : 'segmento inválido';
      throw new CurationError('ROW_INVALID', 400, `Grupo “${group}”: ${message}`);
    }
    result.groupsUpdated += 1;
  }

  for (const code of input.retire) {
    if (!concepts.has(code)) throw new CurationError('CONCEPT_NOT_FOUND', 404, `Item ${code} não encontrado`);
    await updateConcept(client, actor, code, { membershipStatus: 'RETIRED' });
    result.retired += 1;
  }

  await writeAudit(client, actor, 'TAXONOMY_CURATION_GRID_SAVE', draft.id, {
    dimension: dimensionCode,
    created: result.created.length,
    updated: result.updated,
    retired: result.retired,
    groupsCreated: result.groupsCreated,
    groupsUpdated: result.groupsUpdated,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Diff, validation and publication
// ---------------------------------------------------------------------------

export interface DraftDiff {
  sourceVersion: string | null;
  targetVersion: string;
  addedConcepts: string[];
  removedConcepts: string[];
  changedConcepts: Array<{ code: string; fields: string[] }>;
  changedDimensions: Array<{ code: string; fields: string[] }>;
  addedGroups: string[];
  removedGroups: string[];
  changedGroups: Array<{ key: string; fields: string[] }>;
}

const CONCEPT_DIFF_FIELDS: Array<keyof ConceptView> = [
  'label',
  'definition',
  'positiveExample',
  'negativeExample',
  'governanceStatus',
  'evidenceStatus',
  'notes',
  'groupCode',
  'profileVisible',
  'displayOrder',
  'helpText',
  'classifyByLabel',
  'officialCodes',
  'actuacaoCodes',
  'aliases',
];

const DIMENSION_DIFF_FIELDS: Array<keyof DimensionView> = [
  'name',
  'description',
  'profileVisible',
  'profileOrder',
  'helpText',
  'detailSection',
  'detailOrder',
  'usesGroups',
  'officialCodeType',
];

const GROUP_DIFF_FIELDS: Array<keyof GroupView> = [
  'label',
  'displayOrder',
  'helpText',
  'detailSection',
  'officialCodes',
  'segmentCodes',
];

function differs(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function diffReleaseViews(
  source: ReleaseView | null,
  target: ReleaseView,
): DraftDiff {
  const sourceConcepts = new Map(
    (source?.concepts ?? []).map((concept) => [concept.code, concept]),
  );
  const targetConcepts = new Map(
    target.concepts
      .filter((concept) => concept.membershipStatus === 'INCLUDED')
      .map((concept) => [concept.code, concept]),
  );

  const diff: DraftDiff = {
    sourceVersion: source?.release.version ?? null,
    targetVersion: target.release.version,
    addedConcepts: [],
    removedConcepts: [],
    changedConcepts: [],
    changedDimensions: [],
    addedGroups: [],
    removedGroups: [],
    changedGroups: [],
  };

  for (const [code, concept] of targetConcepts) {
    const before = sourceConcepts.get(code);
    if (!before) {
      diff.addedConcepts.push(code);
      continue;
    }
    const fields = CONCEPT_DIFF_FIELDS.filter((field) =>
      differs(before[field], concept[field]),
    );
    if (fields.length > 0) diff.changedConcepts.push({ code, fields });
  }
  for (const code of sourceConcepts.keys()) {
    if (!targetConcepts.has(code)) diff.removedConcepts.push(code);
  }

  const sourceDimensions = new Map(
    (source?.dimensions ?? []).map((dimension) => [dimension.code, dimension]),
  );
  for (const dimension of target.dimensions) {
    const before = sourceDimensions.get(dimension.code);
    if (!before) continue;
    const fields = DIMENSION_DIFF_FIELDS.filter((field) =>
      differs(before[field], dimension[field]),
    );
    if (fields.length > 0) diff.changedDimensions.push({ code: dimension.code, fields });
  }

  const groupKey = (group: GroupView) => `${group.dimensionCode}/${group.code}`;
  const sourceGroups = new Map((source?.groups ?? []).map((g) => [groupKey(g), g]));
  const targetGroups = new Map(target.groups.map((g) => [groupKey(g), g]));
  for (const [key, group] of targetGroups) {
    const before = sourceGroups.get(key);
    if (!before) {
      diff.addedGroups.push(key);
      continue;
    }
    const fields = GROUP_DIFF_FIELDS.filter((field) =>
      differs(before[field], group[field]),
    );
    if (fields.length > 0) diff.changedGroups.push({ key, fields });
  }
  for (const key of sourceGroups.keys()) {
    if (!targetGroups.has(key)) diff.removedGroups.push(key);
  }

  return diff;
}

export interface ValidationIssue {
  severity: 'BLOCKER' | 'WARNING';
  code: string;
  message: string;
  subject?: string;
}

export async function validateReleaseView(
  client: PoolClient | null,
  view: ReleaseView,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const included = view.concepts.filter((c) => c.membershipStatus === 'INCLUDED');
  const dimensionByCode = new Map(view.dimensions.map((d) => [d.code, d]));

  const version=/^v(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(view.release.version);
  // F2-TAB-03: every included 7-digit CNAE in v1.8+ requires ≥1 release
  // Atuação membership; no change to published v1.7 or to source staging.
  if(version&&Number(version[1])===1&&Number(version[2])>=8){
    const atuacoes=new Set(included.filter(c=>c.dimensionCode==='actuacao').map(c=>c.code));
    for(const cnae of included){
      if(cnae.dimensionCode!=='sector'||cnae.officialCodes.length!==1||
         !/^\\d{7}$/.test(cnae.officialCodes[0]??''))continue;
      const codes=cnae.actuacaoCodes??[];
      if(codes.length<1||codes.some(code=>!atuacoes.has(code))){
        issues.push({severity:'BLOCKER',code:'F2_TAB03_CNAE_ACTUACAO_REQUIRED',
          message:'CNAE sem Atuação válida no rascunho v1.8.0.',subject:cnae.code});
      }
    }
  }

  for (const dimension of view.dimensions) {
    const concepts = included.filter((c) => c.dimensionCode === dimension.code);
    if (dimension.profileVisible && !concepts.some((c) => c.profileVisible)) {
      issues.push({
        severity: 'WARNING',
        code: 'PROFILE_DIMENSION_EMPTY',
        message: `"${dimension.name}" aparece no Perfil Tributário sem nenhum item disponível.`,
        subject: dimension.code,
      });
    }

    const labels = new Map<string, string[]>();
    for (const concept of concepts) {
      const key = normalizeAliasText(concept.label);
      labels.set(key, [...(labels.get(key) ?? []), concept.code]);
    }
    for (const codes of labels.values()) {
      if (codes.length > 1) {
        issues.push({
          severity: 'WARNING',
          code: 'DUPLICATE_LABEL',
          message: `Itens com o mesmo nome em "${dimension.name}": ${codes.join(', ')}.`,
          subject: dimension.code,
        });
      }
    }
  }

  for (const concept of included) {
    const dimension = dimensionByCode.get(concept.dimensionCode);
    const type = dimension?.officialCodeType ?? null;
    const invalid = concept.officialCodes.filter((code) => !isValidOfficialCode(type, code));
    if (invalid.length > 0) {
      issues.push({
        severity: 'BLOCKER',
        code: 'INVALID_OFFICIAL_CODE',
        message: `${concept.label}: código(s) inválido(s) ${invalid.join(', ')}.`,
        subject: concept.code,
      });
    }
    // Every synonym now marks legislações; the ones the dictionary had
    // flagged as ambiguous or search-only deserve a second look.
    const risky = concept.aliases.filter(
      (alias) => alias.aliasType === 'AMBIGUOUS' || alias.aliasType === 'SEARCH_RELATED',
    );
    if (risky.length > 0) {
      issues.push({
        severity: 'WARNING',
        code: 'SYNONYM_WAS_NOT_AUTOMATIC',
        message: `${concept.label}: o(s) sinônimo(s) ${risky
          .map((alias) => `“${alias.text}” (${alias.aliasType === 'AMBIGUOUS' ? 'ambíguo' : 'só busca'} no dicionário)`)
          .join(', ')} agora marcam legislações automaticamente. Confira se devem ficar.`,
        subject: concept.code,
      });
    }
    if (/;\s*(\d+|—|modelo)/i.test(concept.label)) {
      issues.push({
        severity: 'WARNING',
        code: 'LABEL_WITH_MODEL',
        message: `${concept.label}: o nome ainda contém o modelo; use o campo Código oficial.`,
        subject: concept.code,
      });
    }
  }

  const usedGroups = new Set(included.map((c) => c.groupId).filter(Boolean));
  for (const group of view.groups) {
    if (!usedGroups.has(group.id)) {
      issues.push({
        severity: 'WARNING',
        code: 'EMPTY_GROUP',
        message: `Grupo "${group.label}" está vazio.`,
        subject: `${group.dimensionCode}/${group.code}`,
      });
    }
  }

  if (client) {
    const releaseId = view.release.id;
    const residue = await client.query<{
      orphan_concepts: number;
      orphan_groups: number;
      orphan_relation_rules: number;
      orphan_relations: number;
      orphan_official_mappings: number;
    }>(
      `
        SELECT
          (
            SELECT count(*)::int
            FROM taxonomy_release_concepts rc
            JOIN taxonomy_concepts c ON c.id = rc.concept_id
            JOIN taxonomy_release_dimensions rd
              ON rd.release_id = rc.release_id
             AND rd.dimension_id = c.dimension_id
            WHERE rc.release_id = $1::uuid
              AND rc.membership_status = 'INCLUDED'
              AND rd.membership_status <> 'INCLUDED'
          ) AS orphan_concepts,
          (
            SELECT count(*)::int
            FROM taxonomy_release_groups g
            JOIN taxonomy_release_dimensions rd
              ON rd.release_id = g.release_id
             AND rd.dimension_id = g.dimension_id
            WHERE g.release_id = $1::uuid
              AND rd.membership_status <> 'INCLUDED'
          ) AS orphan_groups,
          (
            SELECT count(*)::int
            FROM taxonomy_release_relation_rules rr
            JOIN taxonomy_release_dimensions src
              ON src.release_id = rr.release_id
             AND src.dimension_id = rr.source_dimension_id
            JOIN taxonomy_release_dimensions tgt
              ON tgt.release_id = rr.release_id
             AND tgt.dimension_id = rr.target_dimension_id
            WHERE rr.release_id = $1::uuid
              AND (
                src.membership_status <> 'INCLUDED'
                OR tgt.membership_status <> 'INCLUDED'
              )
          ) AS orphan_relation_rules,
          (
            SELECT count(*)::int
            FROM taxonomy_concept_relations rel
            JOIN taxonomy_release_concepts src_rc
              ON src_rc.id = rel.source_release_concept_id
            JOIN taxonomy_concepts src_c ON src_c.id = src_rc.concept_id
            JOIN taxonomy_release_dimensions src_rd
              ON src_rd.release_id = rel.release_id
             AND src_rd.dimension_id = src_c.dimension_id
            JOIN taxonomy_release_concepts tgt_rc
              ON tgt_rc.id = rel.target_release_concept_id
            JOIN taxonomy_concepts tgt_c ON tgt_c.id = tgt_rc.concept_id
            JOIN taxonomy_release_dimensions tgt_rd
              ON tgt_rd.release_id = rel.release_id
             AND tgt_rd.dimension_id = tgt_c.dimension_id
            WHERE rel.release_id = $1::uuid
              AND (
                src_rc.membership_status <> 'INCLUDED'
                OR tgt_rc.membership_status <> 'INCLUDED'
                OR src_rd.membership_status <> 'INCLUDED'
                OR tgt_rd.membership_status <> 'INCLUDED'
              )
          ) AS orphan_relations,
          (
            SELECT count(*)::int
            FROM taxonomy_official_mappings m
            JOIN taxonomy_release_concepts rc
              ON rc.id = m.release_concept_id
             AND rc.release_id = m.release_id
            JOIN taxonomy_concepts c ON c.id = rc.concept_id
            JOIN taxonomy_release_dimensions rd
              ON rd.release_id = m.release_id
             AND rd.dimension_id = c.dimension_id
            WHERE m.release_id = $1::uuid
              AND (
                rc.membership_status <> 'INCLUDED'
                OR rd.membership_status <> 'INCLUDED'
              )
          ) AS orphan_official_mappings
      `,
      [releaseId],
    );
    const residueRow = residue.rows[0];
    for (const [code, count, message] of [
      ['RETIRED_DIMENSION_CONCEPTS', residueRow?.orphan_concepts ?? 0, 'Há conceitos ativos pertencentes a dimensões retiradas.'],
      ['RETIRED_DIMENSION_GROUPS', residueRow?.orphan_groups ?? 0, 'Há grupos pertencentes a dimensões retiradas.'],
      ['RETIRED_DIMENSION_RELATION_RULES', residueRow?.orphan_relation_rules ?? 0, 'Há regras de relação apontando para dimensões retiradas.'],
      ['RETIRED_DIMENSION_RELATIONS', residueRow?.orphan_relations ?? 0, 'Há relações apontando para conceitos/dimensões retirados.'],
      ['RETIRED_DIMENSION_OFFICIAL_MAPPINGS', residueRow?.orphan_official_mappings ?? 0, 'Há mapeamentos oficiais apontando para conceitos/dimensões retirados.'],
    ] as const) {
      if (count > 0) {
        issues.push({
          severity: 'BLOCKER',
          code,
          message: `${message} Quantidade: ${count}.`,
        });
      }
    }

    const manifestRow = await client.query<{ manifest: unknown }>(
      'SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid',
      [releaseId],
    );
    const compatibility = parseTaxonomyCodeCompatibility(manifestRow.rows[0]?.manifest);
    const includedCodes = new Set(included.map((concept) => concept.code));

    // TAX-12 removes these dimensions from the current taxonomy. Every
    // historical identity under them must therefore be explicitly closed by
    // either a redirect or retiredCodes, even when that identity has no
    // taxonomy_release_concepts membership in the current draft.
    const historicalCompatibility = await client.query<{
      dimension_code: string;
      code: string;
      label: string;
    }>(
      `
        SELECT d.code AS dimension_code, c.code, historical_revision.label
        FROM taxonomy_release_dimensions rd
        JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
        JOIN taxonomy_concepts c ON c.dimension_id = rd.dimension_id
        LEFT JOIN taxonomy_release_concepts rc
          ON rc.release_id = rd.release_id
         AND rc.concept_id = c.id
        JOIN taxonomy_concept_revisions historical_revision
          ON historical_revision.id = COALESCE(
            rc.concept_revision_id,
            (
              SELECT r.id
              FROM taxonomy_concept_revisions r
              WHERE r.concept_id = c.id
              ORDER BY r.revision_no DESC
              LIMIT 1
            )
          )
        WHERE rd.release_id = $1::uuid
          AND rd.membership_status <> 'INCLUDED'
          AND d.code = ANY($2::text[])
        ORDER BY d.code, c.code
      `,
      [releaseId, ['treatment', 'platform', 'tax_species']],
    );
    const redirectedCodes = new Set(Object.keys(compatibility.redirects));
    const retiredCompatibilityCodes = new Set(compatibility.retiredCodes);
    const uncoveredHistoricalCodes = historicalCompatibility.rows.filter(
      (row) =>
        !redirectedCodes.has(row.code) &&
        !retiredCompatibilityCodes.has(row.code),
    );
    if (uncoveredHistoricalCodes.length > 0) {
      issues.push({
        severity: 'BLOCKER',
        code: 'INCOMPLETE_RETIRED_DIMENSION_COMPATIBILITY',
        message:
          'Compatibilidade histórica incompleta para dimensão(ões) retirada(s): ' +
          uncoveredHistoricalCodes
            .map((row) => `${row.dimension_code}:${row.code}`)
            .join(', ') +
          '.',
      });
    }

    // A retired Treatment identity is only valid while no active Theme
    // successor exists. Old manifests may carry a retiredCode from a release
    // where the successor did not exist yet; publishing that state after a
    // later RESTORE/CREATE would silently drop historical profile criteria.
    const activeThemes = included.filter(
      (concept) => concept.dimensionCode === 'theme',
    );
    const staleRetiredTreatments = historicalCompatibility.rows.flatMap(
      (row) => {
        if (
          row.dimension_code !== 'treatment' ||
          !retiredCompatibilityCodes.has(row.code)
        ) {
          return [];
        }

        const sourceSuffix = row.code.slice(row.code.indexOf('.') + 1);
        const suffixMatches = activeThemes.filter(
          (concept) =>
            concept.code.slice(concept.code.indexOf('.') + 1) === sourceSuffix,
        );
        if (suffixMatches.length === 1) {
          return [{ source: row.code, target: suffixMatches[0]!.code }];
        }
        if (suffixMatches.length > 1) return [];

        const normalizedLabel = normalizeAliasText(row.label);
        const labelMatches = activeThemes.filter(
          (concept) => normalizeAliasText(concept.label) === normalizedLabel,
        );
        return labelMatches.length === 1
          ? [{ source: row.code, target: labelMatches[0]!.code }]
          : [];
      },
    );
    if (staleRetiredTreatments.length > 0) {
      issues.push({
        severity: 'BLOCKER',
        code: 'RETIRED_TREATMENT_HAS_ACTIVE_SUCCESSOR',
        message:
          'Compatibilidade histórica inválida: Treatment marcado como retirado possui Theme ativo correspondente: ' +
          staleRetiredTreatments
            .map(({ source, target }) => `${source} → ${target}`)
            .join(', ') +
          '.',
      });
    }

    try {
      for (const [from, directTarget] of Object.entries(compatibility.redirects)) {
        const target = resolveTaxonomyConceptCode(from, compatibility);
        if (!target || !includedCodes.has(target)) {
          issues.push({
            severity: 'BLOCKER',
            code: 'INVALID_TAXONOMY_CODE_REDIRECT',
            message: `Compatibilidade inválida: ${from} → ${directTarget} não resolve para um conceito ativo.`,
            subject: from,
          });
        }
        if (includedCodes.has(from) && from !== target) {
          issues.push({
            severity: 'BLOCKER',
            code: 'ACTIVE_CODE_HAS_REDIRECT',
            message: `Compatibilidade ambígua: ${from} ainda está ativo e também redireciona para ${target}.`,
            subject: from,
          });
        }
      }
    } catch (error) {
      issues.push({
        severity: 'BLOCKER',
        code: 'TAXONOMY_CODE_REDIRECT_CYCLE',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    for (const retiredCode of compatibility.retiredCodes) {
      if (includedCodes.has(retiredCode)) {
        issues.push({
          severity: 'BLOCKER',
          code: 'RETIRED_CODE_STILL_ACTIVE',
          message: `Compatibilidade inválida: ${retiredCode} está marcado como retirado, mas continua ativo.`,
          subject: retiredCode,
        });
      }
    }

    const catalogTypes: Array<[OfficialCodeType, string]> = [
      ['NCM', 'NCM'],
      ['CNAE', 'CNAE'],
      ['CCLASSTRIB', 'CCLASSTRIB'],
    ];
    for (const [type, catalogCode] of catalogTypes) {
      const codes = [
        ...new Set([
          ...included
            .filter((c) => dimensionByCode.get(c.dimensionCode)?.officialCodeType === type)
            .flatMap((c) => c.officialCodes),
          ...view.groups
            .filter((g) => dimensionByCode.get(g.dimensionCode)?.officialCodeType === type)
            .flatMap((g) => g.officialCodes),
        ]),
      ];
      if (codes.length === 0) continue;
      const known = await client.query<{ code: string }>(
        `
          SELECT DISTINCT x.code
          FROM unnest($2::text[]) AS x(code)
          WHERE EXISTS (
            SELECT 1
            FROM official_catalog_entries e
            JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
            JOIN official_catalogs oc ON oc.id = ed.catalog_id
            WHERE oc.code = $1 AND ed.status = 'CURRENT'
              AND regexp_replace(e.official_code, '[^0-9A-Za-z]', '', 'g') LIKE x.code || '%'
          )
        `,
        [catalogCode, codes],
      );
      const catalogLoaded = await client.query(
        `SELECT 1 FROM official_catalog_editions ed
         JOIN official_catalogs oc ON oc.id = ed.catalog_id
         WHERE oc.code = $1 AND ed.status = 'CURRENT' LIMIT 1`,
        [catalogCode],
      );
      if (catalogLoaded.rowCount === 0) {
        issues.push({
          severity: 'WARNING',
          code: 'CATALOG_NOT_LOADED',
          message: `Tabela oficial ${type} não carregada; os códigos ${type} não foram conferidos.`,
        });
        continue;
      }
      const knownSet = new Set(known.rows.map((row) => row.code));
      const unknown = codes.filter((code) => !knownSet.has(code));
      if (unknown.length > 0) {
        issues.push({
          severity: 'WARNING',
          code: 'OFFICIAL_CODE_NOT_IN_CATALOG',
          message: `${type}: ${unknown.length} código(s) não encontrado(s) na edição vigente: ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? '…' : ''}.`,
        });
      }
    }
  }

  return issues;
}

export interface PublishResult {
  release: ReleaseSummary;
  snapshotSha256: string;
  diff: DraftDiff;
}

export function releaseSnapshot(view: ReleaseView): Record<string, unknown> {
  return {
    version: view.release.version,
    dimensions: view.dimensions.map((d) => ({
      code: d.code,
      name: d.name,
      description: d.description,
      profileVisible: d.profileVisible,
      profileOrder: d.profileOrder,
      helpText: d.helpText,
      detailSection: d.detailSection,
      detailOrder: d.detailOrder,
      usesGroups: d.usesGroups,
      officialCodeType: d.officialCodeType,
    })),
    groups: view.groups.map((g) => ({
      dimension: g.dimensionCode,
      code: g.code,
      label: g.label,
      displayOrder: g.displayOrder,
      helpText: g.helpText,
      detailSection: g.detailSection,
      officialCodes: g.officialCodes,
      segments: g.segmentCodes,
    })),
    concepts: view.concepts
      .filter((c) => c.membershipStatus === 'INCLUDED')
      .map((c) => ({
        code: c.code,
        label: c.label,
        definition: c.definition,
        positiveExample: c.positiveExample,
        negativeExample: c.negativeExample,
        governanceStatus: c.governanceStatus,
        evidenceStatus: c.evidenceStatus,
        group: c.groupCode,
        profileVisible: c.profileVisible,
        displayOrder: c.displayOrder,
        helpText: c.helpText,
        classifyByLabel: c.classifyByLabel,
        officialCodes: c.officialCodes,
        aliases: c.aliases,
      })),
  };
}

export async function publishDraft(
  client: PoolClient,
  actor: CuratorActor,
  input: { changeNotes: string; gitSha?: string | null },
): Promise<PublishResult> {
  assertJustification(actor);
  const notes = input.changeNotes.trim();
  if (!notes) throw new CurationError('CHANGE_NOTES_REQUIRED');

  const draft = await requireOpenDraft(client);
  const run = pgRunner(client);
  const view = await loadReleaseView(run, draft.id);
  if (!view) throw new CurationError('DRAFT_NOT_FOUND', 500);

  const issues = await validateReleaseView(client, view);
  const blockers = issues.filter((issue) => issue.severity === 'BLOCKER');
  if (blockers.length > 0) {
    throw new CurationError(
      'DRAFT_HAS_BLOCKERS',
      409,
      blockers.map((b) => b.message).join(' | '),
    );
  }

  const latest = await findLatestPublishedRelease(run);
  if (latest && latest.id !== draft.previousReleaseId) {
    throw new CurationError('STALE_DRAFT_BASE', 409);
  }
  const sourceView = latest ? await loadReleaseView(run, latest.id) : null;
  const diff = diffReleaseViews(sourceView, view);

  const snapshot = releaseSnapshot(view);
  const snapshotJson = canonicalJson(snapshot);
  const snapshotSha256 = createHash('sha256').update(snapshotJson, 'utf8').digest('hex');
  const gitSha =
    input.gitSha && /^[a-f0-9]{40}$/.test(input.gitSha)
      ? input.gitSha
      : createHash('sha1').update(snapshotJson, 'utf8').digest('hex');

  const draftManifest = await client.query<{ manifest: unknown }>(
    'SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid',
    [draft.id],
  );
  const taxonomyCompatibility = parseTaxonomyCodeCompatibility(
    draftManifest.rows[0]?.manifest,
  );

  const manifest = {
    kind: CURATED_RELEASE_KIND,
    taxonomyCompatibility,
    sourceReleaseId: draft.previousReleaseId,
    sourceVersion: latest?.version ?? null,
    snapshotSha256,
    artifactGitShaSource: input.gitSha ? 'RAILWAY_GIT_COMMIT_SHA' : 'SNAPSHOT_SHA1',
    publishedBy: `curator:${actor.userId}`,
    counts: {
      dimensions: view.dimensions.length,
      groups: view.groups.length,
      concepts: view.concepts.filter((c) => c.membershipStatus === 'INCLUDED').length,
      added: diff.addedConcepts.length,
      removed: diff.removedConcepts.length,
      changed: diff.changedConcepts.length,
    },
    warnings: issues.length,
  };

  const updated = await client.query(
    `
      UPDATE taxonomy_releases
      SET status = 'PUBLISHED',
          approved_at = now(),
          published_at = now(),
          artifact_repository = 'fabiojuniort-cyber/radar-fiscal-backend',
          artifact_path = $2,
          artifact_git_sha = $3,
          artifact_sha256 = $4,
          manifest = $5::jsonb,
          change_notes = $6
      WHERE id = $1::uuid AND status = 'DRAFT'
    `,
    [
      draft.id,
      `taxonomy-curation/releases/${draft.version}.json`,
      gitSha,
      snapshotSha256,
      JSON.stringify(manifest),
      notes,
    ],
  );
  if (updated.rowCount !== 1) throw new CurationError('PUBLISH_FAILED', 409);

  await writeAudit(client, actor, 'TAXONOMY_CURATION_PUBLISHED', draft.id, {
    version: draft.version,
    snapshotSha256,
    counts: manifest.counts,
  });

  const release = await findRelease(run, draft.id);
  return { release: release!, snapshotSha256, diff };
}

// ---------------------------------------------------------------------------
// Runtime switches
// ---------------------------------------------------------------------------

export async function setRuntimeSetting(
  client: PoolClient,
  actor: CuratorActor,
  key: 'classification_enabled' | 'classification_excluded_sources',
  value: unknown,
): Promise<void> {
  assertJustification(actor);
  if (key === 'classification_enabled' && typeof value !== 'boolean') {
    throw new CurationError('INVALID_SETTING_VALUE');
  }
  if (
    key === 'classification_excluded_sources' &&
    (!Array.isArray(value) || value.length > 0)
  ) {
    throw new CurationError('INVALID_SETTING_VALUE');
  }
  const updated = await client.query(
    `UPDATE taxonomy_runtime_settings
     SET value = $2::jsonb, updated_at = now(), updated_by = $3
     WHERE key = $1`,
    [key, JSON.stringify(value), `curator:${actor.userId}`],
  );
  if (updated.rowCount !== 1) throw new CurationError('SETTING_NOT_FOUND', 404);
  await writeAudit(client, actor, 'TAXONOMY_RUNTIME_SETTING_UPDATED', null, {
    key,
    value,
  });
}

