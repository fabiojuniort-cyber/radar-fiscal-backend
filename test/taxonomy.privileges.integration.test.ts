import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool, type PoolClient } from 'pg';

const TAXONOMY_TABLES = [
  'taxonomy_releases',
  'taxonomy_dimensions',
  'taxonomy_dimension_revisions',
  'taxonomy_release_dimensions',
  'taxonomy_concepts',
  'taxonomy_concept_revisions',
  'taxonomy_release_concepts',
  'taxonomy_aliases',
  'taxonomy_release_alias_bindings',
  'taxonomy_relation_types',
  'taxonomy_release_relation_rules',
  'taxonomy_concept_relations',
  'taxonomy_evidence',
  'taxonomy_concept_revision_evidence',
  'taxonomy_alias_binding_evidence',
  'taxonomy_relation_evidence',
  'official_catalogs',
  'official_catalog_editions',
  'official_catalog_entries',
  'taxonomy_official_mappings',
  'taxonomy_official_mapping_evidence',
] as const;

async function withRole<T>(
  client: PoolClient,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('taxonomy privileges preserve global read-only runtimes and tenant RLS', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const client = await pool.connect();

  try {
    await t.test('all 21 taxonomy tables are global without tenant_id', async () => {
      const result = await client.query<{
        table_name: string;
        has_tenant_id: boolean;
      }>(
        `
          SELECT
            t.table_name,
            EXISTS (
              SELECT 1
              FROM information_schema.columns c
              WHERE c.table_schema = 'public'
                AND c.table_name = t.table_name
                AND c.column_name = 'tenant_id'
            ) AS has_tenant_id
          FROM unnest($1::text[]) AS t(table_name)
          ORDER BY t.table_name
        `,
        [TAXONOMY_TABLES],
      );

      assert.equal(result.rowCount, TAXONOMY_TABLES.length);
      assert.ok(result.rows.every((row) => !row.has_tenant_id));
    });

    await t.test('private tables retain RLS and FORCE RLS', async () => {
      const protectedTables = [
        'tenants',
        'tenant_memberships',
        'companies',
        'company_tax_profiles',
        'establishments',
        'company_cnaes',
        'establishment_cnaes',
        'monitoring_profiles',
        'company_publications',
        'publication_matches',
        'audit_log',
      ];

      const result = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = ANY($1::text[])
        `,
        [protectedTables],
      );

      assert.equal(result.rowCount, protectedTables.length);
      assert.ok(
        result.rows.every(
          (row) => row.relrowsecurity && row.relforcerowsecurity,
        ),
      );
    });

    await t.test('TAX13 legal-scope ledger is FORCE RLS and admin-write only', async () => {
      const result = await client.query<{
        rls: boolean;
        forced: boolean;
        app_read: boolean;
        worker_read: boolean;
        worker_write: boolean;
        curator_read: boolean;
        curator_write: boolean;
      }>(`
        SELECT cls.relrowsecurity AS rls,
               cls.relforcerowsecurity AS forced,
               has_table_privilege('radar_app_runtime', cls.oid, 'SELECT') AS app_read,
               has_table_privilege('radar_worker_runtime', cls.oid, 'SELECT') AS worker_read,
               has_table_privilege('radar_worker_runtime', cls.oid, 'INSERT') AS worker_write,
               has_table_privilege('radar_taxonomy_curator', cls.oid, 'SELECT') AS curator_read,
               has_table_privilege('radar_taxonomy_curator', cls.oid, 'INSERT') AS curator_write
        FROM pg_class cls
        WHERE cls.oid = 'public.publication_legal_scope_attestations'::regclass
      `);
      assert.deepEqual(result.rows[0], {
        rls: true,
        forced: true,
        app_read: false,
        worker_read: true,
        worker_write: false,
        curator_read: false,
        curator_write: false,
      });

      await withRole(client, 'radar_worker_runtime', async () => {
        await client.query('SELECT id FROM public.publication_legal_scope_attestations LIMIT 1');
      });
      await assert.rejects(
        withRole(client, 'radar_app_runtime', async () => {
          await client.query('SELECT id FROM public.publication_legal_scope_attestations LIMIT 1');
        }),
        /permission denied/,
      );
    });

    await t.test('TAX13 legal scope has immutable and provenance triggers', async () => {
      const triggerNames = await client.query<{tgname:string}>(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.publication_legal_scope_attestations'::regclass
          AND NOT tgisinternal
        ORDER BY tgname
      `);
      assert.deepEqual(triggerNames.rows.map(r => r.tgname), [
        'trg_tax13_legal_scope_append_only',
        'trg_tax13_legal_scope_provenance',
      ]);
    });

    await t.test('TAX13 legal evidence is append-only and bound to a real source origin', async () => {
      await client.query('BEGIN');
      try {
        const seed = randomUUID();
        const hash = createHash('sha256').update(seed).digest('hex');
        const source = await client.query<{ id: string }>(`
          INSERT INTO public.sources
            (code, name, jurisdiction_level, base_url, connector_key)
          VALUES ($1, 'B4 test source', 'FEDERAL', 'https://www.confaz.fazenda.gov.br', $2)
          RETURNING id
        `, ['tax13_b4_' + seed, 'tax13_b4_' + seed]);
        const publication = await client.query<{ id: string }>(`
          INSERT INTO public.publications
            (identity_hash, identity_strength, identity_basis, jurisdiction_level, title)
          VALUES ($1, 'STRONG', '{}'::jsonb, 'FEDERAL', 'B4 audited fixture')
          RETURNING id
        `, [hash]);
        const version = await client.query<{ id: string }>(`
          INSERT INTO public.publication_versions
            (publication_id, version_no, content_hash, content_text, is_current)
          VALUES ($1::uuid, 1, $2, 'Texto legal não verificado', TRUE)
          RETURNING id
        `, [publication.rows[0]!.id, hash]);
        const originUrl = 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91';
        const origin = await client.query<{ id: string }>(`
          INSERT INTO public.publication_origins
            (publication_id, source_id, official_url)
          VALUES ($1::uuid, $2::uuid, $3) RETURNING id
        `, [publication.rows[0]!.id, source.rows[0]!.id, originUrl]);
        const attestation = await client.query<{ id: string }>(`
          INSERT INTO public.publication_legal_scope_attestations
            (publication_version_id, source_id, publication_origin_id,
             official_url, html_sha256, valid_as_of, verified_at,
             recheck_on, coverage, manifest, attestor_kind, attestor_ref)
          VALUES
            ($1::uuid,$2::uuid,$3::uuid,$4,$5,'2026-10-08',
             now()-interval '1 minute','2099-01-01','UNVERIFIED',
             '{"version":1,"segments":[]}'::jsonb,'HUMAN_REVIEW','tax13-b4-ci')
          RETURNING id
        `, [version.rows[0]!.id, source.rows[0]!.id, origin.rows[0]!.id, originUrl, hash]);
        assert.ok(attestation.rows[0]?.id);

        for (const [label, command] of [
          ['update', 'UPDATE public.publication_legal_scope_attestations SET coverage=\'PARTIAL\' WHERE id=$1::uuid'],
          ['delete', 'DELETE FROM public.publication_legal_scope_attestations WHERE id=$1::uuid'],
        ] as const) {
          await client.query('SAVEPOINT evidence_immutable');
          await assert.rejects(
            client.query(command, [attestation.rows[0]!.id]),
            /TAX13_LEGAL_SCOPE_APPEND_ONLY/,
            label,
          );
          await client.query('ROLLBACK TO SAVEPOINT evidence_immutable');
        }
        await client.query('SAVEPOINT evidence_provenance');
        await assert.rejects(
          client.query(`
            INSERT INTO public.publication_legal_scope_attestations
              (publication_version_id, source_id, publication_origin_id,
               official_url, html_sha256, valid_as_of, verified_at,
               recheck_on, coverage, manifest, attestor_kind, attestor_ref)
            VALUES ($1::uuid, $2::uuid, gen_random_uuid(),
                    $3, $4, '2026-10-08', now()-interval '1 minute',
                    '2099-01-01','UNVERIFIED','{"version":1,"segments":[]}'::jsonb,
                    'HUMAN_REVIEW','tax13-b4-ci')
          `, [version.rows[0]!.id, source.rows[0]!.id, originUrl, hash]),
          /violates foreign key constraint/,
        );
        await client.query('ROLLBACK TO SAVEPOINT evidence_provenance');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('app runtime is taxonomy read-only', async () => {
      await withRole(client, 'radar_app_runtime', async () => {
        await client.query('SELECT count(*) FROM taxonomy_releases');

        await assert.rejects(
          client.query(
            `
              INSERT INTO taxonomy_dimensions (code)
              VALUES ($1)
            `,
            [`app_denied_${randomUUID().replaceAll('-', '').slice(0, 10)}`],
          ),
          /permission denied/,
        );
      });
    });

    await t.test('worker runtime is taxonomy read-only', async () => {
      await withRole(client, 'radar_worker_runtime', async () => {
        await client.query('SELECT count(*) FROM taxonomy_releases');

        await assert.rejects(
          client.query(
            `
              INSERT INTO taxonomy_dimensions (code)
              VALUES ($1)
            `,
            [`worker_denied_${randomUUID().replaceAll('-', '').slice(0, 10)}`],
          ),
          /permission denied/,
        );
      });
    });

    await t.test('runtime roles are not curator members', async () => {
      const result = await client.query<{
        app_member: boolean;
        worker_member: boolean;
      }>(`
        SELECT
          pg_has_role(
            'radar_app_runtime',
            'radar_taxonomy_curator',
            'MEMBER'
          ) AS app_member,
          pg_has_role(
            'radar_worker_runtime',
            'radar_taxonomy_curator',
            'MEMBER'
          ) AS worker_member
      `);

      assert.equal(result.rows[0]?.app_member, false);
      assert.equal(result.rows[0]?.worker_member, false);
    });

    await t.test('curator role is NOLOGIN and least privilege', async () => {
      const role = await client.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(`
        SELECT
          rolcanlogin,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolreplication,
          rolbypassrls
        FROM pg_roles
        WHERE rolname = 'radar_taxonomy_curator'
      `);

      assert.deepEqual(role.rows[0], {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });

      const privileges = await client.query<{
        can_delete_release: boolean;
        can_update_revision: boolean;
        can_delete_revision: boolean;
      }>(`
        SELECT
          has_table_privilege(
            'radar_taxonomy_curator',
            'taxonomy_releases',
            'DELETE'
          ) AS can_delete_release,
          has_table_privilege(
            'radar_taxonomy_curator',
            'taxonomy_concept_revisions',
            'UPDATE'
          ) AS can_update_revision,
          has_table_privilege(
            'radar_taxonomy_curator',
            'taxonomy_concept_revisions',
            'DELETE'
          ) AS can_delete_revision
      `);

      assert.equal(privileges.rows[0]?.can_delete_release, false);
      assert.equal(privileges.rows[0]?.can_update_revision, false);
      assert.equal(privileges.rows[0]?.can_delete_revision, false);
    });

    await t.test(
      'curator cannot rewrite identity or creation audit columns',
      async () => {
        const seed = randomUUID().replaceAll('-', '').slice(0, 10);
        const releaseId = randomUUID();
        const dimensionId = randomUUID();
        const otherDimensionId = randomUUID();
        const conceptId = randomUUID();

        await client.query(
          `
            INSERT INTO taxonomy_releases (
              id,
              version_major,
              version_minor,
              version_patch,
              created_by_actor
            )
            VALUES ($1, $2, 0, 1, 'immutable-test')
          `,
          [
            releaseId,
            910000 + Number.parseInt(seed.slice(0, 5), 16) % 50000,
          ],
        );

        await client.query(
          `
            INSERT INTO taxonomy_dimensions (id, code)
            VALUES ($1, $2), ($3, $4)
          `,
          [
            dimensionId,
            `immut_${seed}`,
            otherDimensionId,
            `immut_other_${seed}`,
          ],
        );

        await client.query(
          `
            INSERT INTO taxonomy_concepts (id, code, dimension_id)
            VALUES ($1, $2, $3)
          `,
          [conceptId, `immut_${seed}.concept`, dimensionId],
        );

        const forbiddenStatements: Array<{
          sql: string;
          params: unknown[];
        }> = [
          {
            sql: 'UPDATE taxonomy_releases SET id = $2 WHERE id = $1',
            params: [releaseId, randomUUID()],
          },
          {
            sql: 'UPDATE taxonomy_releases SET created_at = now() + interval \'1 second\' WHERE id = $1',
            params: [releaseId],
          },
          {
            sql: 'UPDATE taxonomy_releases SET created_by_actor = \'rewritten\' WHERE id = $1',
            params: [releaseId],
          },
          {
            sql: 'UPDATE taxonomy_dimensions SET id = $2 WHERE id = $1',
            params: [dimensionId, randomUUID()],
          },
          {
            sql: 'UPDATE taxonomy_dimensions SET code = $2 WHERE id = $1',
            params: [dimensionId, `changed_${seed}`],
          },
          {
            sql: 'UPDATE taxonomy_dimensions SET created_at = now() + interval \'1 second\' WHERE id = $1',
            params: [dimensionId],
          },
          {
            sql: 'UPDATE taxonomy_concepts SET id = $2 WHERE id = $1',
            params: [conceptId, randomUUID()],
          },
          {
            sql: 'UPDATE taxonomy_concepts SET code = $2 WHERE id = $1',
            params: [conceptId, `immut_${seed}.changed`],
          },
          {
            sql: 'UPDATE taxonomy_concepts SET dimension_id = $2 WHERE id = $1',
            params: [conceptId, otherDimensionId],
          },
          {
            sql: 'UPDATE taxonomy_concepts SET created_at = now() + interval \'1 second\' WHERE id = $1',
            params: [conceptId],
          },
        ];

        for (const statement of forbiddenStatements) {
          await assert.rejects(
            withRole(client, 'radar_taxonomy_curator', async () => {
              await client.query(statement.sql, statement.params);
            }),
            /permission denied/,
          );
        }

        await withRole(client, 'radar_taxonomy_curator', async () => {
          await client.query(
            `
              UPDATE taxonomy_dimensions
              SET identity_status = 'RETIRED',
                  retired_at = now()
              WHERE id = $1
            `,
            [dimensionId],
          );

          await client.query(
            `
              UPDATE taxonomy_concepts
              SET identity_status = 'RETIRED',
                  retired_at = now()
              WHERE id = $1
            `,
            [conceptId],
          );

          await client.query(
            `
              UPDATE taxonomy_releases
              SET status = 'APPROVED',
                  approved_at = now()
              WHERE id = $1
            `,
            [releaseId],
          );
        });
      },
    );

    await t.test(
      'curator governs official catalog edition lifecycle only',
      async () => {
        const seed = randomUUID().replaceAll('-', '').slice(0, 10);
        const catalogId = randomUUID();
        const supersededEditionId = randomUUID();
        const withdrawnEditionId = randomUUID();

        await client.query(
          `
            INSERT INTO official_catalogs (id, code, name, maintainer)
            VALUES ($1, $2, 'Lifecycle Catalog', 'TriBusca Test')
          `,
          [catalogId, `LIFE_${seed.toUpperCase()}`],
        );

        await client.query(
          `
            INSERT INTO official_catalog_editions (
              id, catalog_id, edition_code
            )
            VALUES
              ($1, $3, 'CURRENT-A'),
              ($2, $3, 'CURRENT-B')
          `,
          [supersededEditionId, withdrawnEditionId, catalogId],
        );

        await withRole(client, 'radar_taxonomy_curator', async () => {
          await client.query(
            `
              UPDATE official_catalog_editions
              SET status = 'SUPERSEDED',
                  valid_to = current_date
              WHERE id = $1
            `,
            [supersededEditionId],
          );

          await client.query(
            `
              UPDATE official_catalog_editions
              SET status = 'WITHDRAWN',
                  valid_to = current_date
              WHERE id = $1
            `,
            [withdrawnEditionId],
          );

          await client.query(
            `
              UPDATE official_catalog_editions
              SET status = 'WITHDRAWN'
              WHERE id = $1
            `,
            [supersededEditionId],
          );
        });

        await assert.rejects(
          withRole(client, 'radar_taxonomy_curator', async () => {
            await client.query(
              `
                UPDATE official_catalog_editions
                SET status = 'CURRENT',
                    valid_to = NULL
                WHERE id = $1
              `,
              [supersededEditionId],
            );
          }),
          /cannot return to CURRENT|immutable/,
        );

        await assert.rejects(
          withRole(client, 'radar_taxonomy_curator', async () => {
            await client.query(
              `
                UPDATE official_catalog_editions
                SET edition_code = 'REWRITTEN'
                WHERE id = $1
              `,
              [withdrawnEditionId],
            );
          }),
          /permission denied/,
        );

        await assert.rejects(
          withRole(client, 'radar_taxonomy_curator', async () => {
            await client.query(
              `
                DELETE FROM official_catalog_editions
                WHERE id = $1
              `,
              [withdrawnEditionId],
            );
          }),
          /permission denied/,
        );
      },
    );

    await t.test('curator can write global audit but not tenant audit', async () => {
      const tenantId = randomUUID();
      const globalAuditId = randomUUID();
      const tenantAuditId = randomUUID();

      await client.query(
        `
          INSERT INTO tenants (id, name, slug, status)
          VALUES ($1, 'Taxonomy Privilege Tenant', $2, 'ACTIVE')
        `,
        [tenantId, `taxonomy-priv-${tenantId}`],
      );

      await client.query(
        `
          INSERT INTO audit_log (
            id, tenant_id, actor_type, action, entity_type
          )
          VALUES (
            $1, $2, 'ADMIN', 'TENANT_PRIVATE_TEST', 'taxonomy_test'
          )
        `,
        [tenantAuditId, tenantId],
      );

      await withRole(client, 'radar_taxonomy_curator', async () => {
        await client.query(
          `
            INSERT INTO audit_log (
              id, tenant_id, actor_type, action, entity_type
            )
            VALUES (
              $1, NULL, 'ADMIN', 'TAXONOMY_TEST', 'taxonomy_release'
            )
          `,
          [globalAuditId],
        );

        const visible = await client.query<{ id: string }>(
          `
            SELECT id
            FROM audit_log
            WHERE id = ANY($1::uuid[])
            ORDER BY id
          `,
          [[globalAuditId, tenantAuditId]],
        );

        assert.deepEqual(
          visible.rows.map((row) => row.id),
          [globalAuditId],
        );

        await assert.rejects(
          client.query(
            `
              INSERT INTO audit_log (
                tenant_id, actor_type, action, entity_type
              )
              VALUES (
                $1, 'ADMIN', 'FORBIDDEN_TENANT_AUDIT', 'taxonomy_test'
              )
            `,
            [tenantId],
          ),
        );

        await assert.rejects(
          client.query(
            `
              INSERT INTO audit_log (
                tenant_id, actor_type, action, entity_type
              )
              VALUES (
                NULL, 'USER', 'FORBIDDEN_USER_AUDIT', 'taxonomy_test'
              )
            `,
          ),
        );
      });

      await client.query(
        'DELETE FROM audit_log WHERE id = ANY($1::uuid[])',
        [[globalAuditId, tenantAuditId]],
      );
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });

    await t.test(
      'curator cannot delete a published release membership',
      async () => {
        const seed = randomUUID().replaceAll('-', '').slice(0, 10);
        const dimensionId = randomUUID();
        const dimensionRevisionId = randomUUID();
        const releaseId = randomUUID();
        const versionMajor =
          800000 + Number.parseInt(seed.slice(0, 5), 16) % 100000;

        await client.query(
          `
            INSERT INTO taxonomy_dimensions (id, code)
            VALUES ($1, $2)
          `,
          [dimensionId, `priv_${seed}`],
        );

        await client.query(
          `
            INSERT INTO taxonomy_dimension_revisions (
              id, dimension_id, revision_no, name
            )
            VALUES ($1, $2, 1, 'Privilege Dimension')
          `,
          [dimensionRevisionId, dimensionId],
        );

        await client.query(
          `
            INSERT INTO taxonomy_releases (
              id,
              version_major,
              version_minor,
              version_patch,
              created_by_actor
            )
            VALUES ($1, $2, 0, 1, 'privilege-test')
          `,
          [releaseId, versionMajor],
        );

        await client.query(
          `
            INSERT INTO taxonomy_release_dimensions (
              release_id, dimension_id, dimension_revision_id
            )
            VALUES ($1, $2, $3)
          `,
          [releaseId, dimensionId, dimensionRevisionId],
        );

        await client.query(
          `
            UPDATE taxonomy_releases
            SET
              status = 'PUBLISHED',
              approved_at = now(),
              published_at = now(),
              artifact_repository = 'test/repo',
              artifact_path = 'taxonomy.md',
              artifact_git_sha = repeat('c', 40),
              artifact_sha256 = repeat('d', 64)
            WHERE id = $1
          `,
          [releaseId],
        );

        await assert.rejects(
          withRole(client, 'radar_taxonomy_curator', async () => {
            await client.query(
              `
                DELETE FROM taxonomy_release_dimensions
                WHERE release_id = $1
                  AND dimension_id = $2
              `,
              [releaseId, dimensionId],
            );
          }),
          /snapshot is immutable/,
        );
      },
    );
  } finally {
    client.release();
    await pool.end();
  }
});
