import type { PoolClient } from 'pg';

import {
  FORBIDDEN_MIT_CODES,
} from './baseline.constants.js';
import type {
  BaselineReadback,
} from './baseline.types.js';

export async function readBaselineState(
  client: PoolClient,
): Promise<BaselineReadback> {
  const release = await client.query<{
    id: string;
    version: string;
    status: string;
    manifest: Record<string, unknown>;
  }>(
    [
      'SELECT id, version, status, manifest',
      'FROM taxonomy_releases',
      'WHERE version_major = 1',
      '  AND version_minor = 0',
      '  AND version_patch = 0',
      'LIMIT 1',
    ].join('\n'),
  );

  const releaseRow = release.rows[0];

  if (!releaseRow) {
    return {
      dimensions: 0,
      concepts: 0,
      needsEvidence: 0,
      lexicalAliases: 0,
      aliasBindings: 0,
      relationTypes: 0,
      relationRules: 0,
      relations: 0,
      creditAliasIdentities: 0,
      creditAmbiguousBindings: 0,
      forbiddenMit: 0,
      releaseVersion: null,
      releaseStatus: null,
      manifestSha256: null,
      derivationFingerprint: null,
    };
  }

  const [
    dimensions,
    concepts,
    needs,
    aliases,
    bindings,
    relationTypes,
    relationRules,
    relations,
    creditAliases,
    creditBindings,
    forbidden,
  ] = await Promise.all([
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_dimensions',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts rc',
        'JOIN taxonomy_concept_revisions cr',
        '  ON cr.id = rc.concept_revision_id',
        'WHERE rc.release_id = $1',
        "  AND cr.evidence_status = 'NEEDS_EVIDENCE'",
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(DISTINCT alias_id)::text AS count',
        'FROM taxonomy_release_alias_bindings',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_alias_bindings',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_relation_types',
        'WHERE code = ANY($1::text[])',
      ].join('\n'),
      [[
        'narrower_than',
        'broader_than',
        'part_of',
        'related_to',
        'replaced_by',
        'supersedes',
        'applies_to',
      ]],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_relation_rules',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_concept_relations',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_aliases',
        "WHERE normalized_text = 'credito'",
        "  AND language = 'pt-BR'",
      ].join('\n'),
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_alias_bindings b',
        'JOIN taxonomy_aliases a',
        '  ON a.id = b.alias_id',
        'WHERE b.release_id = $1',
        "  AND a.normalized_text = 'credito'",
        "  AND a.language = 'pt-BR'",
        "  AND b.alias_type = 'AMBIGUOUS'",
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts rc',
        'JOIN taxonomy_concepts c',
        '  ON c.id = rc.concept_id',
        'WHERE rc.release_id = $1',
        '  AND c.code = ANY($2::text[])',
      ].join('\n'),
      [releaseRow.id, [...FORBIDDEN_MIT_CODES]],
    ),
  ]);

  const storedManifest = releaseRow.manifest;

  return {
    dimensions: Number(dimensions.rows[0]?.count ?? 0),
    concepts: Number(concepts.rows[0]?.count ?? 0),
    needsEvidence: Number(needs.rows[0]?.count ?? 0),
    lexicalAliases: Number(aliases.rows[0]?.count ?? 0),
    aliasBindings: Number(bindings.rows[0]?.count ?? 0),
    relationTypes: Number(
      relationTypes.rows[0]?.count ?? 0,
    ),
    relationRules: Number(
      relationRules.rows[0]?.count ?? 0,
    ),
    relations: Number(relations.rows[0]?.count ?? 0),
    creditAliasIdentities: Number(
      creditAliases.rows[0]?.count ?? 0,
    ),
    creditAmbiguousBindings: Number(
      creditBindings.rows[0]?.count ?? 0,
    ),
    forbiddenMit: Number(forbidden.rows[0]?.count ?? 0),
    releaseVersion: releaseRow.version,
    releaseStatus: releaseRow.status,
    manifestSha256:
      typeof storedManifest.manifestSha256 === 'string'
        ? storedManifest.manifestSha256
        : null,
    derivationFingerprint:
      typeof storedManifest.derivationFingerprint === 'string'
        ? storedManifest.derivationFingerprint
        : null,
  };
}
