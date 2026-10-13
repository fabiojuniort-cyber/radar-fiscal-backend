import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  matchPublicationByTaxonomy,
} from '../src/modules/taxonomy/matching/taxonomy-matching.service.js';

const sha = (value: string): string =>
  createHash('sha256')
    .update(value)
    .digest('hex');

function runtimeUrl(
  adminUrl: string,
  role: string,
  password: string,
): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

function cnpjFrom(
  value: string,
): string {
  return Array.from(
    sha(value).slice(0, 14),
  )
    .map(
      (character) =>
        String(
          Number.parseInt(
            character,
            16,
          ) % 10,
        ),
    )
    .join('');
}

test('TAX-09 matches private profiles from global effective taxonomy without breaking RLS', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL;
  const runtimePassword =
    process.env
      .DB_WORKER_RUNTIME_PASSWORD ??
    process.env.DB_RUNTIME_PASSWORD;

  assert.ok(
    adminUrl,
    'DATABASE_ADMIN_URL is required',
  );
  assert.ok(
    runtimePassword,
    'worker runtime password is required',
  );

  const admin = new Pool({
    connectionString: adminUrl,
    max: 2,
  });
  const worker = new Pool({
    connectionString: runtimeUrl(
      adminUrl,
      'radar_worker_runtime',
      runtimePassword,
    ),
    max: 2,
  });

  try {
    const suffix = randomUUID()
      .replaceAll('-', '')
      .slice(0, 10);

    const tenantId = randomUUID();
    const otherTenantId =
      randomUUID();
    const companyId = randomUUID();
    const profileId = randomUUID();
    const legacyProfileId = randomUUID();
    const retiredProfileId = randomUUID();
    const invalidProfileId =
      randomUUID();
    const publicationId =
      randomUUID();
    const publicationVersionId =
      randomUUID();
    const releaseId = randomUUID();
    const dimensionId = randomUUID();
    const dimensionRevisionId =
      randomUUID();
    const parentConceptId =
      randomUUID();
    const parentRevisionId =
      randomUUID();
    const parentReleaseConceptId =
      randomUUID();
    const childConceptId =
      randomUUID();
    const childRevisionId =
      randomUUID();
    const childReleaseConceptId =
      randomUUID();
    const relationTypeId =
      randomUUID();
    const runId = randomUUID();
    const assertionId = randomUUID();

    const dimensionCode =
      'tax09_' + suffix;
    const parentCode =
      dimensionCode + '.benefit';
    const childCode =
      dimensionCode +
      '.presumed_credit';
    const legacyParentCode =
      dimensionCode + '.legacy_benefit';
    const retiredLegacyCode =
      dimensionCode + '.retired_legacy';
    const versionMajor =
      1800000000 +
      (
        Number.parseInt(
          suffix.slice(0, 5),
          16,
        ) %
        1000000
      );

    await admin.query(
      [
        'INSERT INTO tenants (id,name,slug)',
        'VALUES ($1,$2,$3)',
      ].join(' '),
      [
        tenantId,
        'TAX09 Tenant',
        'tax09-' + suffix,
      ],
    );

    await admin.query(
      [
        'INSERT INTO tenants (id,name,slug)',
        'VALUES ($1,$2,$3)',
      ].join(' '),
      [
        otherTenantId,
        'TAX09 Other',
        'tax09-other-' + suffix,
      ],
    );

    await admin.query(
      [
        'INSERT INTO companies (',
        'id,tenant_id,legal_name,head_office_cnpj',
        ') VALUES ($1,$2,$3,$4)',
      ].join(' '),
      [
        companyId,
        tenantId,
        'TAX09 Company',
        cnpjFrom(
          'tax09-company-' + suffix,
        ),
      ],
    );

    await admin.query(
      [
        'INSERT INTO monitoring_profiles (',
        'id,company_id,name,criteria,criteria_schema_version,profile_version',
        ') VALUES ($1,$2,$3,$4::jsonb,2,1)',
      ].join(' '),
      [
        profileId,
        companyId,
        'TAX09 Taxonomy Profile',
        JSON.stringify({
          taxonomy: {
            releasePolicy:
              'CURRENT_PUBLISHED',
            anyOf: [parentCode],
            allOf: [],
            noneOf: [],
            includeDescendants: true,
          },
        }),
      ],
    );

    await admin.query(
      [
        'INSERT INTO monitoring_profiles (',
        'id,company_id,name,criteria,criteria_schema_version,profile_version',
        ') VALUES ($1,$2,$3,$4::jsonb,2,1)',
      ].join(' '),
      [
        invalidProfileId,
        companyId,
        'TAX09 Invalid Code',
        JSON.stringify({
          taxonomy: {
            releasePolicy:
              'CURRENT_PUBLISHED',
            anyOf: [
              dimensionCode +
                '.missing',
            ],
            allOf: [],
            noneOf: [],
            includeDescendants: false,
          },
        }),
      ],
    );

    await admin.query(
      [
        'INSERT INTO monitoring_profiles (',
        'id,company_id,name,criteria,criteria_schema_version,profile_version',
        ') VALUES ($1,$2,$3,$4::jsonb,2,1)',
      ].join(' '),
      [
        legacyProfileId,
        companyId,
        'TAX12 Legacy Treatment Code',
        JSON.stringify({
          taxonomy: {
            releasePolicy: 'CURRENT_PUBLISHED',
            anyOf: [legacyParentCode],
            allOf: [],
            noneOf: [],
            includeDescendants: true,
          },
        }),
      ],
    );

    await admin.query(
      [
        'INSERT INTO monitoring_profiles (',
        'id,company_id,name,criteria,criteria_schema_version,profile_version',
        ') VALUES ($1,$2,$3,$4::jsonb,2,1)',
      ].join(' '),
      [
        retiredProfileId,
        companyId,
        'TAX12 Retired Code',
        JSON.stringify({
          taxonomy: {
            releasePolicy: 'CURRENT_PUBLISHED',
            anyOf: [retiredLegacyCode],
            allOf: [],
            noneOf: [],
            includeDescendants: false,
          },
        }),
      ],
    );

    await admin.query(
      [
        'INSERT INTO publications (',
        'id,identity_hash,identity_strength,identity_basis,jurisdiction_level,title',
        ') VALUES ($1,$2,',
        "'SOURCE_SCOPED','{}'::jsonb,'FEDERAL','TAX09 Fixture')",
      ].join(' '),
      [
        publicationId,
        sha('tax09-pub-' + suffix),
      ],
    );

    await admin.query(
      [
        'INSERT INTO publication_versions (',
        'id,publication_id,version_no,content_hash,content_text',
        ') VALUES ($1,$2,1,$3,$4)',
      ].join(' '),
      [
        publicationVersionId,
        publicationId,
        sha(
          'tax09-content-' +
            suffix,
        ),
        'Texto classificado no conceito filho.',
      ],
    );

    await admin.query(
      [
        'INSERT INTO taxonomy_releases (',
        'id,version_major,version_minor,version_patch,created_by_actor',
        ') VALUES ($1,$2,0,0,\'tax09-test\')',
      ].join(' '),
      [
        releaseId,
        versionMajor,
      ],
    );

    await admin.query(
      'UPDATE taxonomy_releases SET manifest = $2::jsonb WHERE id = $1::uuid',
      [
        releaseId,
        JSON.stringify({
          taxonomyCompatibility: {
            version: 1,
            redirects: {
              [legacyParentCode]: parentCode,
            },
            retiredCodes: [retiredLegacyCode],
          },
        }),
      ],
    );

    await admin.query(
      [
        'INSERT INTO taxonomy_dimensions (id,code)',
        'VALUES ($1,$2)',
      ].join(' '),
      [dimensionId, dimensionCode],
    );

    await admin.query(
      [
        'INSERT INTO taxonomy_dimension_revisions (',
        'id,dimension_id,revision_no,name,governance_status',
        ") VALUES ($1,$2,1,'TAX09 Dimension','APPROVED')",
      ].join(' '),
      [
        dimensionRevisionId,
        dimensionId,
      ],
    );

    await admin.query(
      [
        'INSERT INTO taxonomy_release_dimensions (',
        'release_id,dimension_id,dimension_revision_id',
        ') VALUES ($1,$2,$3)',
      ].join(' '),
      [
        releaseId,
        dimensionId,
        dimensionRevisionId,
      ],
    );

    for (const concept of [
      {
        conceptId: parentConceptId,
        revisionId: parentRevisionId,
        releaseConceptId:
          parentReleaseConceptId,
        code: parentCode,
        label: 'Tax benefit',
      },
      {
        conceptId: childConceptId,
        revisionId: childRevisionId,
        releaseConceptId:
          childReleaseConceptId,
        code: childCode,
        label: 'Presumed credit',
      },
    ]) {
      await admin.query(
        [
          'INSERT INTO taxonomy_concepts (id,code,dimension_id)',
          'VALUES ($1,$2,$3)',
        ].join(' '),
        [
          concept.conceptId,
          concept.code,
          dimensionId,
        ],
      );

      await admin.query(
        [
          'INSERT INTO taxonomy_concept_revisions (',
          'id,concept_id,revision_no,label,definition,governance_status,evidence_status',
          ") VALUES ($1,$2,1,$3,$4,'APPROVED','DOCUMENTED')",
        ].join(' '),
        [
          concept.revisionId,
          concept.conceptId,
          concept.label,
          concept.label +
            ' definition',
        ],
      );

      await admin.query(
        [
          'INSERT INTO taxonomy_release_concepts (',
          'id,release_id,concept_id,concept_revision_id',
          ') VALUES ($1,$2,$3,$4)',
        ].join(' '),
        [
          concept.releaseConceptId,
          releaseId,
          concept.conceptId,
          concept.revisionId,
        ],
      );
    }

    await admin.query(
      [
        'INSERT INTO taxonomy_relation_types (',
        'id,code,inverse_code,directed,acyclic,hierarchical,canonical_storage_code,description',
        ") VALUES ($1,'narrower_than','broader_than',true,true,true,'narrower_than','TAX09 fixture')",
        'ON CONFLICT (code) DO NOTHING',
      ].join(' '),
      [relationTypeId],
    );

    const actualRelationType =
      await admin.query<{
        id: string;
      }>(
        [
          'SELECT id',
          'FROM taxonomy_relation_types',
          "WHERE code = 'narrower_than'",
        ].join(' '),
      );

    const actualRelationTypeId =
      actualRelationType.rows[0]?.id;

    assert.ok(actualRelationTypeId);

    await admin.query(
      [
        'INSERT INTO taxonomy_release_relation_rules (',
        'release_id,relation_type_id,source_dimension_id,target_dimension_id,allowed',
        ') VALUES ($1,$2,$3,$3,true)',
      ].join(' '),
      [
        releaseId,
        actualRelationTypeId,
        dimensionId,
      ],
    );

    await admin.query(
      [
        'INSERT INTO taxonomy_concept_relations (',
        'release_id,source_release_concept_id,target_release_concept_id,relation_type_id,status',
        ") VALUES ($1,$2,$3,$4,'APPROVED')",
      ].join(' '),
      [
        releaseId,
        childReleaseConceptId,
        parentReleaseConceptId,
        actualRelationTypeId,
      ],
    );

    await admin.query(
      [
        'UPDATE taxonomy_releases',
        "SET status = 'PUBLISHED',",
        'approved_at = now(),',
        'published_at = now(),',
        "artifact_repository = 'tax09-test',",
        "artifact_path = 'fixture',",
        'artifact_git_sha = $2,',
        'artifact_sha256 = $3',
        'WHERE id = $1',
      ].join(' '),
      [
        releaseId,
        'c'.repeat(40),
        'd'.repeat(64),
      ],
    );

    await admin.query(
      [
        'INSERT INTO publication_taxonomy_runs (',
        'id,publication_version_id,taxonomy_release_id,method_type,',
        'engine_key,engine_version,config_snapshot,config_sha256,',
        'input_sha256,run_fingerprint,status,started_at,finished_at',
        ') VALUES ($1,$2,$3,',
        "'RULE','tax09-test','1','{}'::jsonb,$4,$5,$6,'SUCCESS',now(),now())",
      ].join(' '),
      [
        runId,
        publicationVersionId,
        releaseId,
        sha('{}'),
        sha(
          'tax09-input-' + suffix,
        ),
        sha(
          'tax09-run-' + suffix,
        ),
      ],
    );

    await admin.query(
      [
        'INSERT INTO publication_taxonomy_assertions (',
        'id,run_id,taxonomy_release_id,release_concept_id,',
        'assertion_status,confidence,decision_origin,reason_code',
        ") VALUES ($1,$2,$3,$4,'CONFIRMED',1,'RULE_ENGINE','TAX09_TEST')",
      ].join(' '),
      [
        assertionId,
        runId,
        releaseId,
        childReleaseConceptId,
      ],
    );

    const conceptCountBefore =
      await admin.query<{
        n: number;
      }>(
        'SELECT count(*)::int AS n FROM taxonomy_concepts',
      );

    const first =
      await matchPublicationByTaxonomy(
        worker,
        {
          tenantId,
          monitoringProfileId:
            profileId,
          publicationVersionId,
        },
      );

    assert.equal(
      first.disposition,
      'MATCHED_CREATED',
    );
    assert.deepEqual(
      first.matchedCriteriaCodes,
      [parentCode],
    );
    assert.deepEqual(
      first.matchedAssertionCodes,
      [childCode],
    );
    assert.deepEqual(
      first.classificationRunIds,
      [runId],
    );
    assert.ok(
      first.companyPublicationId,
    );
    assert.ok(
      first.publicationMatchId,
    );

    const second =
      await matchPublicationByTaxonomy(
        worker,
        {
          tenantId,
          monitoringProfileId:
            profileId,
          publicationVersionId,
        },
      );

    assert.equal(
      second.disposition,
      'MATCHED_EXISTING',
    );
    assert.equal(
      second.publicationMatchId,
      first.publicationMatchId,
    );

    const matchRows =
      await admin.query<{
        n: number;
      }>(
        [
          'SELECT count(*)::int AS n',
          'FROM publication_matches',
          'WHERE monitoring_profile_id = $1',
        ].join(' '),
        [profileId],
      );

    assert.equal(
      matchRows.rows[0]?.n,
      1,
    );

    const evidence =
      await admin.query<{
        matched_fields: {
          taxonomyReleaseId: string;
          publicationVersionId: string;
          classificationRunIds: string[];
          matchedCriteriaCodes: string[];
          matchedAssertionCodes: string[];
          materialHash: string;
        };
      }>(
        [
          'SELECT matched_fields',
          'FROM publication_matches',
          'WHERE id = $1',
        ].join(' '),
        [first.publicationMatchId],
      );

    assert.equal(
      evidence.rows[0]
        ?.matched_fields
        .taxonomyReleaseId,
      releaseId,
    );
    assert.equal(
      evidence.rows[0]
        ?.matched_fields
        .publicationVersionId,
      publicationVersionId,
    );
    assert.match(
      evidence.rows[0]
        ?.matched_fields
        .materialHash ?? '',
      /^[a-f0-9]{64}$/,
    );

    await admin.query(
      [
        'UPDATE company_publications',
        "SET status = 'RELEVANT'",
        'WHERE id = $1',
      ].join(' '),
      [first.companyPublicationId],
    );

    await matchPublicationByTaxonomy(
      worker,
      {
        tenantId,
        monitoringProfileId:
          profileId,
        publicationVersionId,
      },
    );

    const status =
      await admin.query<{
        status: string;
      }>(
        [
          'SELECT status',
          'FROM company_publications',
          'WHERE id = $1',
        ].join(' '),
        [first.companyPublicationId],
      );

    assert.equal(
      status.rows[0]?.status,
      'RELEVANT',
    );

    const legacy = await matchPublicationByTaxonomy(
      worker,
      {
        tenantId,
        monitoringProfileId: legacyProfileId,
        publicationVersionId,
      },
    );
    assert.equal(legacy.disposition, 'MATCHED_CREATED');
    assert.deepEqual(legacy.matchedCriteriaCodes, [legacyParentCode]);
    assert.deepEqual(legacy.matchedAssertionCodes, [childCode]);

    const retired = await matchPublicationByTaxonomy(
      worker,
      {
        tenantId,
        monitoringProfileId: retiredProfileId,
        publicationVersionId,
      },
    );
    assert.equal(retired.disposition, 'NO_MATCH');
    assert.deepEqual(retired.matchedCriteriaCodes, []);
    assert.deepEqual(retired.matchedAssertionCodes, []);

    await assert.rejects(
      matchPublicationByTaxonomy(
        worker,
        {
          tenantId:
            otherTenantId,
          monitoringProfileId:
            profileId,
          publicationVersionId,
        },
      ),
      /MONITORING_PROFILE_NOT_FOUND_IN_TENANT/,
    );

    await assert.rejects(
      matchPublicationByTaxonomy(
        worker,
        {
          tenantId,
          monitoringProfileId:
            invalidProfileId,
          publicationVersionId,
        },
      ),
      /TAXONOMY_CRITERIA_CODE_NOT_IN_CURRENT_RELEASE/,
    );

    const conceptCountAfter =
      await admin.query<{
        n: number;
      }>(
        'SELECT count(*)::int AS n FROM taxonomy_concepts',
      );

    assert.equal(
      conceptCountAfter.rows[0]?.n,
      conceptCountBefore.rows[0]?.n,
      'private matching must not write global taxonomy',
    );

    const rls =
      await admin.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        [
          'SELECT relname,relrowsecurity,relforcerowsecurity',
          'FROM pg_class',
          'WHERE relname = ANY($1::text[])',
          'ORDER BY relname',
        ].join(' '),
        [[
          'monitoring_profiles',
          'company_publications',
          'publication_matches',
        ]],
      );

    assert.equal(
      rls.rows.length,
      3,
    );
    assert.ok(
      rls.rows.every(
        (row) =>
          row.relrowsecurity &&
          row.relforcerowsecurity,
      ),
    );
  } finally {
    await worker.end();
    await admin.end();
  }
});
