import {
  CURATED_ENGINE_KEY,
  CURATED_ENGINE_VERSION,
} from '../classification/classification.curated.js';
import {
  DEFAULT_SECTION_ORDER,
} from './curation.constants.js';
import {
  findLatestPublishedRelease,
  loadReleaseView,
  loadRuntimeSettings,
  type ConceptView,
  type ReleaseSummary,
  type SqlRunner,
} from './curation.read.js';

export type PublicationTaxonomyStatus =
  | 'CLASSIFIED'
  | 'PENDING'
  | 'FAILED'
  | 'DISABLED'
  | 'EXCLUDED'
  | 'NO_RELEASE'
  | 'NOT_FOUND';

export interface TagReason {
  type: 'TEXT' | 'SYNONYM' | 'NCM' | 'CCLASSTRIB' | 'CURATOR';
  term: string | null;
  excerpt: string | null;
}

export interface PublicationTag {
  kind: 'CONCEPT' | 'GROUP';
  conceptCode: string | null;
  groupCode: string | null;
  label: string;
  dimensionCode: string;
  groupLabel: string | null;
  origin: 'AUTOMATIC' | 'CURATOR';
  assertionId: string | null;
  removed: boolean;
  reason: TagReason;
}

export interface PublicationTagSection {
  name: string;
  order: number;
  tags: PublicationTag[];
}

export interface PublicationTaxonomyView {
  publicationId: string;
  publicationVersionId: string | null;
  release: ReleaseSummary | null;
  status: PublicationTaxonomyStatus;
  classifiedAt: string | null;
  sections: PublicationTagSection[];
}

const REASON_TYPES: Record<string, TagReason['type']> = {
  CANONICAL_LABEL: 'TEXT',
  EXACT_LEXICAL_ALIAS: 'SYNONYM',
  ABBREVIATION_ALIAS: 'SYNONYM',
  OFFICIAL_CODE_NCM: 'NCM',
  OFFICIAL_CODE_CCLASSTRIB: 'CCLASSTRIB',
};

interface AutomaticRow {
  assertion_id: string;
  release_concept_id: string;
  reason_code: string | null;
  excerpt: string | null;
  term: string | null;
  latest_review: 'CONFIRM' | 'REJECT' | null;
}

interface CuratorRow {
  release_concept_id: string;
  action: 'ADD' | 'REMOVE';
  rationale: string;
}

export async function loadPublicationTaxonomy(
  run: SqlRunner,
  publicationId: string,
  options: { includeRemoved?: boolean } = {},
): Promise<PublicationTaxonomyView> {
  const base: PublicationTaxonomyView = {
    publicationId,
    publicationVersionId: null,
    release: null,
    status: 'NOT_FOUND',
    classifiedAt: null,
    sections: [],
  };

  const version = await run<{ id: string; excluded: boolean }>(
    `
      SELECT pv.id,
        EXISTS (
          SELECT 1
          FROM publication_origins po
          JOIN sources s ON s.id = po.source_id
          WHERE po.publication_id = pv.publication_id
            AND s.code = ANY(
              SELECT jsonb_array_elements_text(value)
              FROM taxonomy_runtime_settings
              WHERE key = 'classification_excluded_sources'
            )
        ) AS excluded
      FROM publication_versions pv
      WHERE pv.publication_id = $1::uuid AND pv.is_current = true
      LIMIT 1
    `,
    [publicationId],
  );
  const current = version[0];
  if (!current) return base;
  base.publicationVersionId = current.id;

  const release = await findLatestPublishedRelease(run);
  if (!release) return { ...base, status: 'NO_RELEASE' };
  base.release = release;

  const scan = (
    await run<{
      status: 'SUCCESS' | 'FAILED';
      run_id: string | null;
      scanned_at: Date | string;
    }>(
      `
        SELECT status, run_id, scanned_at
        FROM publication_taxonomy_scans
        WHERE publication_version_id = $1::uuid
          AND taxonomy_release_id = $2::uuid
          AND engine_key = $3 AND engine_version = $4
      `,
      [current.id, release.id, CURATED_ENGINE_KEY, CURATED_ENGINE_VERSION],
    )
  )[0];

  const automatic = scan?.run_id
    ? await run<AutomaticRow>(
        `
          SELECT
            a.id AS assertion_id,
            a.release_concept_id,
            a.reason_code,
            sp.excerpt,
            sp.selector ->> 'term' AS term,
            (
              SELECT r.decision
              FROM publication_taxonomy_reviews r
              WHERE r.assertion_id = a.id
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT 1
            ) AS latest_review
          FROM publication_taxonomy_assertions a
          LEFT JOIN LATERAL (
            SELECT excerpt, selector
            FROM publication_taxonomy_spans
            WHERE assertion_id = a.id
            ORDER BY created_at
            LIMIT 1
          ) sp ON true
          WHERE a.run_id = $1::uuid
        `,
        [scan.run_id],
      )
    : [];

  const curator = await run<CuratorRow>(
    `
      SELECT DISTINCT ON (release_concept_id)
        release_concept_id, action, rationale
      FROM publication_taxonomy_curator_tags
      WHERE publication_version_id = $1::uuid
        AND taxonomy_release_id = $2::uuid
      ORDER BY release_concept_id, created_at DESC, id DESC
    `,
    [current.id, release.id],
  );

  const settings = await loadRuntimeSettings(run);
  let status: PublicationTaxonomyStatus;
  if (scan?.status === 'SUCCESS') status = 'CLASSIFIED';
  else if (current.excluded) status = 'EXCLUDED';
  else if (!settings.classificationEnabled) status = 'DISABLED';
  else if (scan?.status === 'FAILED') status = 'FAILED';
  else status = 'PENDING';

  const view = await loadReleaseView(run, release.id);
  if (!view) return { ...base, status };

  const conceptById = new Map(
    view.concepts.map((concept) => [concept.releaseConceptId, concept]),
  );
  const dimensionByCode = new Map(view.dimensions.map((d) => [d.code, d]));
  const groupById = new Map(view.groups.map((g) => [g.id, g]));

  const sectionOf = (concept: ConceptView): string | null => {
    const group = concept.groupId ? groupById.get(concept.groupId) : undefined;
    return (
      group?.detailSection ??
      dimensionByCode.get(concept.dimensionCode)?.detailSection ??
      null
    );
  };

  const tags = new Map<string, { section: string; tag: PublicationTag }>();
  const add = (concept: ConceptView, tag: Omit<PublicationTag, 'kind' | 'conceptCode' | 'groupCode' | 'label' | 'dimensionCode' | 'groupLabel'>) => {
    const section = sectionOf(concept);
    if (!section) return;
    const group = concept.groupId ? groupById.get(concept.groupId) : undefined;
    tags.set(concept.releaseConceptId, {
      section,
      tag: {
        kind: 'CONCEPT',
        conceptCode: concept.code,
        groupCode: group?.code ?? null,
        label: concept.label,
        dimensionCode: concept.dimensionCode,
        groupLabel: group?.label ?? null,
        ...tag,
      },
    });
  };

  for (const row of automatic) {
    const concept = conceptById.get(row.release_concept_id);
    if (!concept) continue;
    const removed = row.latest_review === 'REJECT';
    if (removed && !options.includeRemoved) continue;
    add(concept, {
      origin: 'AUTOMATIC',
      assertionId: row.assertion_id,
      removed,
      reason: {
        type: REASON_TYPES[row.reason_code ?? ''] ?? 'TEXT',
        term: row.term,
        excerpt: row.excerpt,
      },
    });
  }

  for (const row of curator) {
    const concept = conceptById.get(row.release_concept_id);
    if (!concept) continue;
    if (row.action === 'REMOVE') {
      const existing = tags.get(row.release_concept_id);
      if (existing?.tag.origin === 'CURATOR') tags.delete(row.release_concept_id);
      continue;
    }
    if (tags.get(row.release_concept_id)?.tag.removed === false) continue;
    add(concept, {
      origin: 'CURATOR',
      assertionId: null,
      removed: false,
      reason: { type: 'CURATOR', term: null, excerpt: row.rationale },
    });
  }

  // Product groups whose NCM prefix matches a detected NCM but none of whose
  // items was tagged: show the group itself, explaining the NCM.
  const productType = view.dimensions.find((d) => d.officialCodeType === 'NCM');
  if (productType) {
    const mentions = await run<{ ncm_code: string }>(
      `SELECT DISTINCT ncm_code FROM publication_ncm_mentions
       WHERE publication_version_id = $1::uuid
         AND verification_status <> 'REJECTED'`,
      [current.id],
    );
    const taggedGroups = new Set(
      [...tags.values()].map((entry) => entry.tag.groupCode).filter(Boolean),
    );
    for (const group of view.groups) {
      if (group.dimensionCode !== productType.code) continue;
      if (taggedGroups.has(group.code)) continue;
      const hit = mentions.find((m) =>
        group.officialCodes.some((prefix) => m.ncm_code.startsWith(prefix)),
      );
      if (!hit) continue;
      const section = group.detailSection ?? productType.detailSection;
      if (!section) continue;
      tags.set(`group:${group.id}`, {
        section,
        tag: {
          kind: 'GROUP',
          conceptCode: null,
          groupCode: group.code,
          label: group.label,
          dimensionCode: group.dimensionCode,
          groupLabel: null,
          origin: 'AUTOMATIC',
          assertionId: null,
          removed: false,
          reason: {
            type: 'NCM',
            term: hit.ncm_code,
            excerpt: `NCM ${hit.ncm_code} citado na legislação`,
          },
        },
      });
    }
  }

  const sectionOrder = new Map<string, number>();
  for (const dimension of view.dimensions) {
    if (dimension.detailSection) {
      const current = sectionOrder.get(dimension.detailSection);
      if (current === undefined || dimension.detailOrder < current) {
        sectionOrder.set(dimension.detailSection, dimension.detailOrder);
      }
    }
  }

  const sections = new Map<string, PublicationTagSection>();
  for (const { section, tag } of tags.values()) {
    if (!sections.has(section)) {
      const fallback = (DEFAULT_SECTION_ORDER as readonly string[]).indexOf(section);
      sections.set(section, {
        name: section,
        order: sectionOrder.get(section) ?? (fallback >= 0 ? fallback + 1 : 100),
        tags: [],
      });
    }
    sections.get(section)!.tags.push(tag);
  }

  const ordered = [...sections.values()].sort(
    (left, right) =>
      left.order - right.order || left.name.localeCompare(right.name, 'pt-BR'),
  );
  for (const section of ordered) {
    section.tags.sort((left, right) => left.label.localeCompare(right.label, 'pt-BR'));
  }

  return {
    ...base,
    status,
    classifiedAt: scan?.status === 'SUCCESS' ? new Date(scan.scanned_at).toISOString() : null,
    sections: ordered,
  };
}
