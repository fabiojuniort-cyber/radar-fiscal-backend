import type { Pool } from 'pg';

// Synthetic reference fixture, strictly for disposable CI databases.
// Production catalogue remains sourced exclusively from IBGE/CONCLA.
export async function ensureCnaeFixture(admin: Pool): Promise<void> {
  await admin.query(`
    INSERT INTO official_catalogs(code, name, maintainer)
    VALUES ('CNAE', 'CNAE', 'IBGE')
    ON CONFLICT (code) DO NOTHING;
    INSERT INTO official_catalog_editions(
      catalog_id, edition_code, source_url, status
    )
    SELECT id, 'onb01-ci-only', 'https://concla.ibge.gov.br/', 'CURRENT'
      FROM official_catalogs
     WHERE code = 'CNAE'
       AND NOT EXISTS (
         SELECT 1 FROM official_catalog_editions e
          WHERE e.catalog_id = official_catalogs.id
            AND e.status = 'CURRENT'
       )
    ON CONFLICT (catalog_id, edition_code) DO NOTHING;
    INSERT INTO official_catalog_entries(
      catalog_edition_id, official_code, description, metadata
    )
    SELECT e.id, fixtures.code, fixtures.description,
           '{"level":"SUBCLASSE","assignable":true}'::jsonb
    FROM official_catalog_editions e
    JOIN official_catalogs c ON c.id = e.catalog_id
    CROSS JOIN (
      VALUES
        ('6201-5/01', 'Desenvolvimento de programas de computador sob encomenda'),
        ('4632-0/01', 'Comércio atacadista de cereais e leguminosas beneficiados')
    ) AS fixtures(code, description)
    WHERE c.code = 'CNAE' AND e.status = 'CURRENT'
    ON CONFLICT (catalog_edition_id, official_code) DO NOTHING;
  `);
}
