import {
  CompiledQuery,
  type Kysely,
  type Transaction,
} from 'kysely';
import type { Pool, PoolClient } from 'pg';

import type { DB } from '../../../infrastructure/database/database.types.js';
import {
  DEFAULT_DETAIL_SECTIONS,
  DEFAULT_OFFICIAL_CODE_TYPES,
  DEFAULT_PROFILE_HELP,
  DEFAULT_SECTION_ORDER,
  LEGACY_PROFILE_DIMENSIONS,
  type OfficialCodeType,
} from './curation.constants.js';

/** Minimal query runner so reads work on Kysely (API) and pg (curator). */
export type SqlRunner = <T>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

export function kyselyRunner(
  db: Kysely<DB> | Transaction<DB>,
): SqlRunner {
  return async <T>(text: string, params: readonly unknown[] = []) => {
    const result = await db.executeQuery<T>(
      CompiledQuery.raw(text, [...params]),
    );
    return result.rows;
  };
}

export function pgRunner(client: Pool | PoolClient): SqlRunner {
  return async <T>(text: string, params: readonly unknown[] = []) => {
    const result = await client.query(text, [...params]);
    return result.rows as T[];
  };
}

export const CURATED_RELEASE_KIND = 'TAX-11_CURATED_RELEASE';

export interface ReleaseSummary {
  id: string;
  version: string;
  status: string;
  createdAt: string;
  publishedAt: string | null;
  previousReleaseId: string | null;
  changeNotes: string | null;
}

export interface DimensionView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  revisionNo: number;
  membershipStatus: string;
  /** True when the release stores curated settings for this dimension. */
  configured: boolean;
  profileVisible: boolean;
  profileOrder: number;
  helpText: string | null;
  detailSection: string | null;
  detailOrder: number;
  usesGroups: boolean;
  officialCodeType: OfficialCodeType | null;
  conceptCount: number;
}

export interface GroupView {
  id: string;
  dimensionCode: string;
  code: string;
  label: string;
  displayOrder: number;
  helpText: string | null;
  detailSection: string | null;
  officialCodes: string[];
  segmentCodes: string[];
}

export interface AliasView {
  text: string;
  aliasType: string;
}

export interface ConceptView {
  releaseConceptId: string;
  conceptId: string;
  code: string;
  dimensionCode: string;
  label: string;
  definition: string;
  positiveExample: string | null;
  negativeExample: string | null;
  governanceStatus: string;
  evidenceStatus: string;
  notes: string | null;
  releaseNotes: string | null;
  revisionNo: number;
  membershipStatus: string;
  groupId: string | null;
  groupCode: string | null;
  profileVisible: boolean;
  displayOrder: number | null;
  helpText: string | null;
  classifyByLabel: boolean;
  officialCodes: string[];
  aliases: AliasView[];
  /** Release-scoped overrides: NULL means inherit F2 source suggestions; [] means cleared. */
  f2DraftSuggestions?: {products:string[]|null;ncms:string[]|null};
  /** F2 suggestions, not legal classification evidence. */
  f2Source?: {
    atuacao: string;
    suggestedProducts: string;
    suggestedNcms: string;
    sourceSha256: string;
    sourceBatchId: string;
  };
}

export interface ReleaseView {
  release: ReleaseSummary;
  dimensions: DimensionView[];
  groups: GroupView[];
  concepts: ConceptView[];
}

interface ReleaseRow {
  id: string;
  version: string;
  status: string;
  created_at: Date | string;
  published_at: Date | string | null;
  previous_release_id: string | null;
  change_notes: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function toSummary(row: ReleaseRow): ReleaseSummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    createdAt: iso(row.created_at) ?? '',
    publishedAt: iso(row.published_at),
    previousReleaseId: row.previous_release_id,
    changeNotes: row.change_notes,
  };
}

const RELEASE_COLUMNS = `
  id, version, status, created_at, published_at,
  previous_release_id, change_notes
`;

export async function findLatestPublishedRelease(
  run: SqlRunner,
): Promise<ReleaseSummary | null> {
  const rows = await run<ReleaseRow>(`
    SELECT ${RELEASE_COLUMNS}
    FROM taxonomy_releases
    WHERE status = 'PUBLISHED'
    ORDER BY version_major DESC, version_minor DESC, version_patch DESC
    LIMIT 1
  `);
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function findOpenDraft(
  run: SqlRunner,
): Promise<ReleaseSummary | null> {
  const rows = await run<ReleaseRow>(`
    SELECT ${RELEASE_COLUMNS}
    FROM taxonomy_releases
    WHERE status IN ('DRAFT', 'IN_REVIEW', 'APPROVED')
      -- Only drafts opened by the curation flow; baseline/successor drafts
      -- created by operational commands are not editable here.
      AND manifest ->> 'kind' = '${CURATED_RELEASE_KIND}'
    ORDER BY version_major DESC, version_minor DESC, version_patch DESC
    LIMIT 1
  `);
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function findRelease(
  run: SqlRunner,
  releaseId: string,
): Promise<ReleaseSummary | null> {
  const rows = await run<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM taxonomy_releases WHERE id = $1::uuid`,
    [releaseId],
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

export function legacyDimensionDefaults(code: string): Pick<
  DimensionView,
  | 'profileVisible'
  | 'profileOrder'
  | 'helpText'
  | 'detailSection'
  | 'detailOrder'
  | 'usesGroups'
  | 'officialCodeType'
> {
  const profileIndex = (
    LEGACY_PROFILE_DIMENSIONS as readonly string[]
  ).indexOf(code);
  const detailSection = DEFAULT_DETAIL_SECTIONS[code] ?? null;
  const sectionIndex = detailSection
    ? (DEFAULT_SECTION_ORDER as readonly string[]).indexOf(detailSection)
    : -1;

  return {
    profileVisible: profileIndex >= 0,
    profileOrder: profileIndex >= 0 ? profileIndex + 1 : 100,
    helpText: DEFAULT_PROFILE_HELP[code] ?? null,
    detailSection,
    detailOrder: sectionIndex >= 0 ? sectionIndex + 1 : 100,
    usesGroups: true,
    officialCodeType: DEFAULT_OFFICIAL_CODE_TYPES[code] ?? null,
  };
}

interface DimensionRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  revision_no: number;
  membership_status: string;
  profile_visible: boolean | null;
  profile_order: number | null;
  help_text: string | null;
  detail_section: string | null;
  detail_order: number | null;
  uses_groups: boolean | null;
  official_code_type: OfficialCodeType | null;
  concept_count: number;
}

interface GroupRow {
  id: string;
  dimension_code: string;
  code: string;
  label: string;
  display_order: number;
  help_text: string | null;
  detail_section: string | null;
  official_codes: string[];
  segment_codes: string[] | null;
}

interface ConceptRow {
  release_concept_id: string;
  concept_id: string;
  code: string;
  dimension_code: string;
  label: string;
  definition: string;
  positive_example: string | null;
  negative_example: string | null;
  governance_status: string;
  evidence_status: string;
  notes: string | null;
  release_notes: string | null;
  revision_no: number;
  membership_status: string;
  group_id: string | null;
  group_code: string | null;
  profile_visible: boolean | null;
  display_order: number | null;
  help_text: string | null;
  classify_by_label: boolean | null;
  official_codes: string[];
  f2_suggested_products: string[] | null;
  f2_suggested_ncms: string[] | null;
  aliases: AliasView[] | null;
}

export async function loadReleaseView(
  run: SqlRunner,
  releaseId: string,
  options: { includeRetired?: boolean } = {},
): Promise<ReleaseView | null> {
  const release = await findRelease(run, releaseId);
  if (!release) return null;

  const membershipFilter = options.includeRetired
    ? ''
    : `AND rc.membership_status = 'INCLUDED'`;
  const dimensionMembershipFilter = options.includeRetired
    ? ''
    : `AND rd.membership_status = 'INCLUDED'`;

  const dimensionRows = await run<DimensionRow>(
    `
      SELECT
        d.id, d.code, dr.name, dr.description, dr.revision_no,
        rd.membership_status, rd.profile_visible, rd.profile_order,
        rd.help_text, rd.detail_section, rd.detail_order,
        rd.uses_groups, rd.official_code_type,
        (
          SELECT count(*)::int
          FROM taxonomy_release_concepts rc
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          WHERE rc.release_id = rd.release_id
            AND c.dimension_id = d.id
            AND rc.membership_status = 'INCLUDED'
        ) AS concept_count
      FROM taxonomy_release_dimensions rd
      JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
      JOIN taxonomy_dimension_revisions dr ON dr.id = rd.dimension_revision_id
      WHERE rd.release_id = $1::uuid
        ${dimensionMembershipFilter}
      ORDER BY d.code
    `,
    [releaseId],
  );

  const groupRows = await run<GroupRow>(
    `
      SELECT
        g.id, d.code AS dimension_code, g.code, g.label, g.display_order,
        g.help_text, g.detail_section, g.official_codes,
        (
          SELECT array_agg(c.code ORDER BY c.code)
          FROM taxonomy_release_group_segments gs
          JOIN taxonomy_release_concepts rc
            ON rc.id = gs.segment_release_concept_id
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          WHERE gs.group_id = g.id
        ) AS segment_codes
      FROM taxonomy_release_groups g
      JOIN taxonomy_dimensions d ON d.id = g.dimension_id
      JOIN taxonomy_release_dimensions rd
        ON rd.release_id = g.release_id
       AND rd.dimension_id = g.dimension_id
      WHERE g.release_id = $1::uuid
        ${dimensionMembershipFilter}
      ORDER BY d.code, g.display_order, g.label
    `,
    [releaseId],
  );

  const conceptRows = await run<ConceptRow>(
    `
      SELECT
        rc.id AS release_concept_id,
        rc.concept_id,
        c.code,
        d.code AS dimension_code,
        cr.label,
        cr.definition,
        cr.positive_example,
        cr.negative_example,
        cr.governance_status,
        cr.evidence_status,
        cr.notes,
        rc.release_notes,
        cr.revision_no,
        rc.membership_status,
        rc.group_id,
        g.code AS group_code,
        rc.profile_visible,
        rc.display_order,
        rc.help_text,
        rc.classify_by_label,
        rc.official_codes,
        rc.f2_suggested_products,
        rc.f2_suggested_ncms,
        (
          SELECT json_agg(
            json_build_object('text', a.text, 'aliasType', b.alias_type)
            ORDER BY a.normalized_text
          )
          FROM taxonomy_release_alias_bindings b
          JOIN taxonomy_aliases a ON a.id = b.alias_id
          WHERE b.release_concept_id = rc.id
            AND b.release_id = rc.release_id
            AND b.decision_status = 'APPROVED'
        ) AS aliases
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      JOIN taxonomy_concept_revisions cr ON cr.id = rc.concept_revision_id
      JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      JOIN taxonomy_release_dimensions rd
        ON rd.release_id = rc.release_id
       AND rd.dimension_id = c.dimension_id
      LEFT JOIN taxonomy_release_groups g ON g.id = rc.group_id
      WHERE rc.release_id = $1::uuid
        ${membershipFilter}
        ${dimensionMembershipFilter}
      ORDER BY d.code, rc.display_order NULLS LAST, cr.label, c.code
    `,
    [releaseId],
  );

  const dimensions: DimensionView[] = dimensionRows.map((row) => {
    const legacy = legacyDimensionDefaults(row.code);
    const configured = row.profile_visible !== null;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      revisionNo: row.revision_no,
      membershipStatus: row.membership_status,
      configured,
      profileVisible: row.profile_visible ?? legacy.profileVisible,
      profileOrder: row.profile_order ?? legacy.profileOrder,
      helpText: configured ? row.help_text : legacy.helpText,
      detailSection: configured ? row.detail_section : legacy.detailSection,
      detailOrder: row.detail_order ?? legacy.detailOrder,
      usesGroups: row.uses_groups ?? legacy.usesGroups,
      officialCodeType: configured
        ? row.official_code_type
        : legacy.officialCodeType,
      conceptCount: row.concept_count,
    };
  });

  dimensions.sort(
    (left, right) =>
      left.profileOrder - right.profileOrder ||
      left.name.localeCompare(right.name, 'pt-BR'),
  );

  const groups: GroupView[] = groupRows.map((row) => ({
    id: row.id,
    dimensionCode: row.dimension_code,
    code: row.code,
    label: row.label,
    displayOrder: row.display_order,
    helpText: row.help_text,
    detailSection: row.detail_section,
    officialCodes: row.official_codes ?? [],
    segmentCodes: row.segment_codes ?? [],
  }));

  const concepts: ConceptView[] = conceptRows.map((row) => ({
    releaseConceptId: row.release_concept_id,
    conceptId: row.concept_id,
    code: row.code,
    dimensionCode: row.dimension_code,
    label: row.label,
    definition: row.definition,
    positiveExample: row.positive_example,
    negativeExample: row.negative_example,
    governanceStatus: row.governance_status,
    evidenceStatus: row.evidence_status,
    notes: row.notes,
    releaseNotes: row.release_notes,
    revisionNo: row.revision_no,
    membershipStatus: row.membership_status,
    groupId: row.group_id,
    groupCode: row.group_code,
    profileVisible: row.profile_visible ?? true,
    displayOrder: row.display_order,
    helpText: row.help_text,
    classifyByLabel: row.classify_by_label ?? true,
    officialCodes: row.official_codes ?? [],
    f2DraftSuggestions:{products:row.f2_suggested_products,ncms:row.f2_suggested_ncms},
    aliases: row.aliases ?? [],
  }));

  return { release, dimensions, groups, concepts };
}

export interface RuntimeSettings {
  classificationEnabled: boolean;
  classificationExcludedSources: string[];
  updatedAt: Record<string, string>;
  updatedBy: Record<string, string>;
}

export async function loadRuntimeSettings(
  run: SqlRunner,
): Promise<RuntimeSettings> {
  const rows = await run<{
    key: string;
    value: unknown;
    updated_at: Date | string;
    updated_by: string;
  }>(`SELECT key, value, updated_at, updated_by FROM taxonomy_runtime_settings`);

  const byKey = new Map(rows.map((row) => [row.key, row]));

  return {
    classificationEnabled:
      byKey.get('classification_enabled')?.value === true,
    // Legacy persisted exclusions no longer restrict the Acervo.
    classificationExcludedSources: [],
    updatedAt: Object.fromEntries(
      rows.map((row) => [row.key, iso(row.updated_at) ?? '']),
    ),
    updatedBy: Object.fromEntries(
      rows.map((row) => [row.key, row.updated_by]),
    ),
  };
}

