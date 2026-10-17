import assert from 'node:assert/strict';
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { ensureCnaeFixture } from './onboarding-cnae-fixture.js';

const PASSWORD = 'Launch-Seguro-2026!';

function cnpjFromSeed(seed: string): string {
  const digits = seed
    .replace(/\D/g, '')
    .padEnd(12, '7')
    .slice(0, 12);

  const calculate = (
    value: string,
    weights: number[],
  ): number => {
    const sum = weights.reduce(
      (total, weight, index) =>
        total +
        Number(value[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2
      ? 0
      : 11 - remainder;
  };

  const first = calculate(
    digits,
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  const second = calculate(
    digits + String(first),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );

  return digits + String(first) + String(second);
}

async function registerAndLogin(
  app: FastifyInstance,
  suffix: string,
) {
  const email =
    'launch-' + suffix + '@example.test';
  const company =
    'Launch Company ' + suffix;

  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Launch Owner',
      email,
      company,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      acceptedTerms: true,
    },
  });

  assert.equal(register.statusCode, 201);

  const registered = register.json<{
    tenant: { id: string };
    user: { id: string };
  }>();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email,
      password: PASSWORD,
    },
  });

  assert.equal(login.statusCode, 200);

  const body = login.json<{
    accessToken: string;
  }>();

  return {
    email,
    userId: registered.user.id,
    tenantId: registered.tenant.id,
    accessToken: body.accessToken,
  };
}

test(
  'launch product API keeps tenant data isolated and supports account setup',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for integration tests.',
    );

    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });
    const app = await buildApp();
    const users: string[] = [];
    const tenants: string[] = [];
    const publications: string[] = [];

    try {
      await app.ready();
      await ensureCnaeFixture(admin);

      const first = await registerAndLogin(
        app,
        randomUUID(),
      );
      const second = await registerAndLogin(
        app,
        randomUUID(),
      );

      users.push(first.userId, second.userId);
      tenants.push(first.tenantId, second.tenantId);

      const firstHeaders = {
        authorization:
          'Bearer ' + first.accessToken,
        'x-tenant-id': first.tenantId,
      };

      const initial = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: firstHeaders,
      });

      assert.equal(initial.statusCode, 200);

      const initialBody = initial.json<{
        tenant: { id: string };
        onboarding: {
          companyName: string;
        } | null;
        companies: unknown[];
      }>();

      assert.equal(
        initialBody.tenant.id,
        first.tenantId,
      );
      assert.ok(initialBody.onboarding);
      assert.deepEqual(
        initialBody.companies,
        [],
      );

      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: {
          authorization:
            'Bearer ' + second.accessToken,
          'x-tenant-id': first.tenantId,
        },
      });

      assert.equal(
        forbidden.statusCode,
        403,
      );

      await admin.query(
        `
          INSERT INTO tenant_memberships (
            tenant_id,
            user_id,
            role
          )
          VALUES ($1, $2, 'ANALYST')
          ON CONFLICT (tenant_id, user_id)
          DO UPDATE SET role = EXCLUDED.role
        `,
        [
          first.tenantId,
          second.userId,
        ],
      );

      const analystHeaders = {
        authorization:
          'Bearer ' + second.accessToken,
        'x-tenant-id': first.tenantId,
      };

      const analystRead =
        await app.inject({
          method: 'GET',
          url: '/api/v1/account',
          headers: analystHeaders,
        });

      assert.equal(
        analystRead.statusCode,
        200,
      );

      const analystWrite =
        await app.inject({
          method: 'POST',
          url: '/api/v1/companies',
          headers: analystHeaders,
          payload: {
            legalName:
              'Empresa não autorizada',
            cnpj: cnpjFromSeed(
              '987650000001',
            ),
          },
        });

      assert.equal(
        analystWrite.statusCode,
        403,
      );

      const companyCnpj = cnpjFromSeed(
        '123450000001',
      );

      const companyResponse =
        await app.inject({
          method: 'POST',
          url: '/api/v1/companies',
          headers: firstHeaders,
          payload: {
            legalName:
              'Empresa Real de Teste Ltda',
            tradeName:
              'Empresa Real',
            cnpj: companyCnpj,
          },
        });

      assert.equal(
        companyResponse.statusCode,
        201,
      );

      const company =
        companyResponse.json<{
          company: {
            id: string;
            cnpj: string;
          };
        }>().company;

      assert.equal(
        company.cnpj,
        companyCnpj,
      );

      const establishmentResponse =
        await app.inject({
          method: 'POST',
          url: '/api/v1/establishments',
          headers: firstHeaders,
          payload: {
            companyId: company.id,
            cnpj: companyCnpj,
            name: 'Matriz Goiânia',
            typeCode: 'HEAD_OFFICE',
            isHeadOffice: true,
            uf: 'GO',
            municipalityName: 'Goiânia',
            postalCode: '74000000',
          },
        });

      assert.equal(
        establishmentResponse.statusCode,
        201,
      );

      const profileResponse =
        await app.inject({
          method: 'PUT',
          url:
            '/api/v1/companies/' +
            company.id +
            '/tax-profile',
          headers: firstHeaders,
          payload: {
            taxRegime: 'LUCRO_REAL',
            segments: ['AGRONEGOCIO'],
            activities: [
              'Comércio de insumos',
            ],
            personalization: {
              taxes: [
                'ICMS',
                'IBS',
                'CBS',
              ],
              products: [
                'Fertilizantes',
              ],
              operations: [
                'Venda interestadual',
              ],
              documents: ['NF-e'],
              obligations: ['EFD'],
              keywords: [
                'crédito presumido',
              ],
            },
          },
        });

      assert.equal(
        profileResponse.statusCode,
        200,
      );

      const establishments =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/companies/' +
            company.id +
            '/establishments',
          headers: firstHeaders,
        });

      assert.equal(
        establishments.statusCode,
        200,
      );
      assert.equal(
        establishments.json<{
          items: unknown[];
        }>().items.length,
        1,
      );

      const profile = await app.inject({
        method: 'GET',
        url:
          '/api/v1/companies/' +
          company.id +
          '/tax-profile',
        headers: firstHeaders,
      });

      assert.equal(profile.statusCode, 200);
      assert.equal(
        profile.json<{
          profile: {
            taxRegime: string;
          } | null;
        }>().profile?.taxRegime,
        'LUCRO_REAL',
      );

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: firstHeaders,
      });

      assert.equal(after.statusCode, 200);
      assert.equal(
        after.json<{
          companies: Array<{
            id: string;
            establishmentCount: number;
          }>;
        }>().companies[0]
          ?.establishmentCount,
        1,
      );

      const archivePublication =
        await admin.query<{
          id: string;
        }>(
          `
            INSERT INTO publications (
              identity_hash,
              identity_strength,
              identity_basis,
              jurisdiction_level,
              title,
              published_on,
              primary_official_url
            )
            VALUES (
              $1,
              'STRONG',
              '{}'::jsonb,
              'FEDERAL',
              'Ato oficial para busca do Acervo',
              DATE '2026-09-30',
              'https://example.test/ato-oficial'
            )
            RETURNING id
          `,
          [
            randomBytes(32).toString(
              'hex',
            ),
          ],
        );

      const archivePublicationId =
        archivePublication.rows[0]?.id;

      assert.ok(archivePublicationId);
      publications.push(
        archivePublicationId,
      );

      await admin.query(
        `
          INSERT INTO publication_versions (
            publication_id,
            version_no,
            content_hash,
            content_text,
            relevant_excerpt,
            source_metadata,
            is_current
          )
          VALUES (
            $1,
            1,
            $2,
            $3,
            $4,
            $5::jsonb,
            true
          )
        `,
        [
          archivePublicationId,
          randomBytes(32).toString(
            'hex',
          ),
          [
            'CAPÍTULO I',
            '',
            'Art. 1º  Norma sobre crédito presumido aplicável a fertilizantes.',
            '    I - primeiro item;',
            '    II - segundo item.',
          ].join('\n'),
          'Crédito presumido para fertilizantes.',
          JSON.stringify({
            effectiveUntil: '2027-12-31',
            effectiveUntilBasis: 'CURRENT_VALIDITY_CLAUSE',
            effectiveUntilAmendedBy: 'Conv. ICMS 79/25',
            presentation: {
              version: 1,
              format: 'SANITIZED_HTML',
              preservesWhitespace: true,
              html: [
                '<script>alert(1)</script>',
                '<h2 onclick="evil()">CAPÍTULO I</h2>',
                '<p>Art. 1º Texto oficial.</p>',
                '<table><tr><th>Tributo</th></tr><tr><td>ICMS</td></tr></table>',
              ].join(''),
            },
          }),
        ],
      );

      const archiveSearch =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/archive?q=fertilizantes&page=1&limit=1',
          headers: {
            authorization:
              'Bearer ' +
              first.accessToken,
          },
        });

      assert.equal(
        archiveSearch.statusCode,
        200,
      );

      const archiveBody =
        archiveSearch.json<{
          page: number;
          limit: number;
          hasMore: boolean;
          items: Array<{
            id: string;
            title: string;
            excerpt: string | null;
          }>;
        }>();

      assert.equal(
        archiveBody.page,
        1,
      );
      assert.equal(
        archiveBody.limit,
        1,
      );
      assert.equal(
        archiveBody.items[0]?.id,
        archivePublicationId,
      );
      assert.match(
        archiveBody.items[0]?.excerpt ??
          '',
        /fertilizantes/i,
      );

      const detail =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/publications/' +
            archivePublicationId,
          headers: {
            authorization:
              'Bearer ' +
              first.accessToken,
          },
        });

      assert.equal(
        detail.statusCode,
        200,
      );

      const detailBody =
        detail.json<{
          publication: {
            id: string;
            officialUrl: string | null;
            effectiveUntil: {
              date: string;
              basis: string;
              amendedBy: string | null;
            } | null;
          };
          version: {
            contentText: string | null;
            presentation: {
              format: string;
              preservesWhitespace: boolean;
              html?: string;
            };
          } | null;
        }>();

      assert.equal(
        detailBody.publication.id,
        archivePublicationId,
      );
      assert.equal(
        detailBody.publication.officialUrl,
        'https://example.test/ato-oficial',
      );
      assert.deepEqual(
        detailBody.publication.effectiveUntil,
        {
          date: '2027-12-31',
          basis: 'CURRENT_VALIDITY_CLAUSE',
          amendedBy: 'Conv. ICMS 79/25',
        },
      );
      assert.match(
        detailBody.version?.contentText ?? '',
        /CAPÍTULO I\n\nArt\. 1º/,
      );
      assert.match(
        detailBody.version?.contentText ?? '',
        /    I - primeiro item;/,
      );
      assert.equal(
        detailBody.version?.presentation.preservesWhitespace,
        true,
      );
      assert.equal(
        detailBody.version?.presentation.format,
        'SANITIZED_HTML',
      );
      assert.match(
        detailBody.version?.presentation.html ?? '',
        /<h2>CAPÍTULO I<\/h2>/,
      );
      assert.match(
        detailBody.version?.presentation.html ?? '',
        /<table>/,
      );
      assert.doesNotMatch(
        detailBody.version?.presentation.html ?? '',
        /script|onclick/i,
      );

      const crossTenantCompanyRead =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/companies/' +
            company.id +
            '/establishments',
          headers: {
            authorization:
              'Bearer ' +
              second.accessToken,
            'x-tenant-id':
              second.tenantId,
          },
        });

      assert.equal(
        crossTenantCompanyRead.statusCode,
        200,
      );
      assert.deepEqual(
        crossTenantCompanyRead.json(),
        { items: [] },
      );

      const taxonomyOptions =
        await app.inject({
          method: 'GET',
          url: '/api/v1/taxonomy/profile-options',
          headers: firstHeaders,
        });

      assert.equal(
        taxonomyOptions.statusCode,
        200,
      );
      assert.ok(
        Array.isArray(
          taxonomyOptions.json<{
            dimensions: unknown[];
          }>().dimensions,
        ),
      );

      const registryCnpj =
        cnpjFromSeed('887760000001');
      const branchRegistryCnpj =
        cnpjFromSeed('887760000002');
      const invalidRegistryCnpj = cnpjFromSeed('776650000001');
      const originalFetch =
        globalThis.fetch;

      try {
        globalThis.fetch =
          async (input, init) => {
            const url = String(input);

            if (url.includes('brasilapi.com.br/api/cnpj/v1/')) {
              const requestedCnpj =
                url.split('/').pop() ??
                registryCnpj;

              return new Response(
                JSON.stringify({
                  cnpj: requestedCnpj,
                  razao_social: 'Empresa Registry de Teste S.A.',
                  nome_fantasia: 'Registry Teste',
                  uf: 'GO',
                  municipio: 'Rio Verde',
                  codigo_municipio_ibge: 5218805,
                  cep: '75900000',
                  logradouro: 'Avenida das Empresas',
                  numero: '100',
                  bairro: 'Centro',
                  cnae_fiscal: requestedCnpj === invalidRegistryCnpj ? 9999999 : 4683400,
                  cnae_fiscal_descricao: 'DESCRIÇÃO FALSA DO PROVEDOR — NÃO PROPAGAR',
                  cnaes_secundarios: [
                    {
                      codigo: 4623108,
                      descricao: 'Comércio atacadista de matérias-primas agrícolas',
                    },
                    {
                      codigo: 4632001,
                      descricao: 'Comércio atacadista de cereais',
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: {
                    'content-type': 'application/json',
                  },
                },
              );
            }

            if (
              url.includes('appasp.sefaz.go.gov.br/Sintegra/Consulta/default.html') ||
              url.includes('appasp.sefaz.go.gov.br/Sintegra/Consulta/default.asp')
            ) {
              return new Response(
                '<html>Consulta SINTEGRA Goiás</html>',
                {
                  status: 200,
                  headers: {
                    'content-type': 'text/html',
                  },
                },
              );
            }

            if (
              url.includes('appasp.sefaz.go.gov.br/Sintegra/Consulta/consultar.asp') &&
              init?.method === 'POST'
            ) {
              return new Response(
                '<td>Inscrição Estadual</td><td>10.999.888-7</td>' +
                  '<td>Situação Cadastral Vigente</td><td>Ativo - HABILITADO</td>',
                {
                  status: 200,
                  headers: {
                    'content-type': 'text/html',
                  },
                },
              );
            }

            return new Response('unexpected request', { status: 500 });
          };

        // An invalid registry CNAE must not create a company or poison global cnaes.
        const rejectedRegistry = await app.inject({
          method: 'POST',
          url: '/api/v1/companies/from-cnpj',
          headers: firstHeaders,
          payload: { cnpj: invalidRegistryCnpj },
        });
        assert.equal(rejectedRegistry.statusCode, 400, rejectedRegistry.body);
        assert.equal(rejectedRegistry.json<{ error: string }>().error, 'invalid_cnae');
        const fakeRegistryCnae = await admin.query(
          "SELECT code FROM cnaes WHERE code = '9999999'",
        );
        assert.equal(fakeRegistryCnae.rowCount, 0);
        const rolledBackCompany = await admin.query(
          'SELECT id FROM companies WHERE head_office_cnpj = $1',
          [invalidRegistryCnpj],
        );
        assert.equal(rolledBackCompany.rowCount, 0);

        // Integrated recovery: after the provider's bad CNAE is rejected,
        // the same authorized user can select a CURRENT official CNAE and
        // create the matrix through the real API with PostgreSQL persistence.
        const officialOptions = await app.inject({
          method: 'GET',
          url: '/api/v1/cnae-catalog?search=6201501',
          headers: firstHeaders,
        });
        assert.equal(officialOptions.statusCode, 200, officialOptions.body);
        const available = officialOptions.json<{ items: Array<{ code: string; description: string }> }>().items;
        const selected = available.find((item) => item.code === '6201501');
        assert.ok(selected, 'Official fallback options should include eligible CNAE');

        const recoveredManually = await app.inject({
          method: 'POST',
          url: '/api/v1/companies/manual',
          headers: firstHeaders,
          payload: {
            cnpj: invalidRegistryCnpj,
            legalName: 'Matriz recuperada com CNAE oficial',
            uf: 'GO',
            cnaes: [{ ...selected, isPrimary: true }],
          },
        });
        assert.equal(recoveredManually.statusCode, 201, recoveredManually.body);
        const manuallyCreatedId = recoveredManually.json<{ company: { id: string } }>().company.id;
        const recoveredFromDb = await admin.query<{ head_office_cnpj: string }>(
          'SELECT head_office_cnpj FROM companies WHERE id = $1',
          [manuallyCreatedId],
        );
        assert.equal(recoveredFromDb.rows[0]?.head_office_cnpj, invalidRegistryCnpj);

        const registryCreate =
          await app.inject({
            method: 'POST',
            url: '/api/v1/companies/from-cnpj',
            headers: firstHeaders,
            payload: {
              cnpj: registryCnpj,
              businessLocationCode: 'MATRIZ-001',
            },
          });

        assert.equal(
          registryCreate.statusCode,
          201,
        );

        const assertRegistryReadback = async (response: { establishment: Record<string, unknown> }) => {
          const est = response.establishment;
          const sql = await admin.query('SELECT company_id, name, uf, business_location_code FROM establishments WHERE id = $1', [est.id]);
          assert.equal(est.name, sql.rows[0].name);
          assert.equal(est.uf, sql.rows[0].uf);
          assert.equal(est.businessLocationCode, sql.rows[0].business_location_code);
          const get = await app.inject({ method: 'GET',
            url: '/api/v1/companies/' + sql.rows[0].company_id + '/establishments', headers: firstHeaders });
          assert.equal(get.statusCode, 200, get.body);
          const stored = get.json<{ items: Array<Record<string, unknown>> }>().items.find((item) => item.id === est.id);
          assert.ok(stored);
          for (const [key, value] of Object.entries(est)) assert.deepEqual(value, stored[key], 'POST/GET mismatch: ' + key);
          const cnaes = await admin.query('SELECT c.code, c.description, ec.is_primary FROM establishment_cnaes ec JOIN cnaes c ON c.code = ec.cnae_code WHERE ec.establishment_id = $1 ORDER BY ec.is_primary DESC, c.code', [est.id]);
          assert.deepEqual(est.cnaes, cnaes.rows.map((row) => ({ code: row.code, description: row.description, isPrimary: row.is_primary })));
        };
        await assertRegistryReadback(registryCreate.json());

        const registryBody =
          registryCreate.json<{
            company: {
              id: string;
              cnpj: string;
            };
            establishment: {
              id: string;
              stateRegistration: string | null;
              stateRegistrationStatus: string | null;
              stateRegistrationLookupStatus: string | null;
              businessLocationCode: string | null;
              cnaes: Array<{
                code: string;
                isPrimary: boolean;
              }>;
            };
          }>();

        assert.equal(
          registryBody.company.cnpj,
          registryCnpj,
        );
        assert.equal(
          registryBody.establishment
            .businessLocationCode,
          'MATRIZ-001',
        );
        assert.equal(
          registryBody.establishment
            .stateRegistration,
          '10.999.888-7',
        );
        assert.equal(
          registryBody.establishment
            .stateRegistrationStatus,
          'Ativo - HABILITADO',
        );
        assert.equal(
          registryBody.establishment
            .stateRegistrationLookupStatus,
          'SUCCESS',
        );
        assert.equal(
          registryBody.establishment
            .cnaes.length,
          3,
        );
        assert.equal(
          registryBody.establishment
            .cnaes[0]?.isPrimary,
          true,
        );

        const registryEstablishments =
          await app.inject({
            method: 'GET',
            url:
              '/api/v1/companies/' +
              registryBody.company.id +
              '/establishments',
            headers: firstHeaders,
          });

        assert.equal(
          registryEstablishments.statusCode,
          200,
        );
        const persisted =
          registryEstablishments.json<{
            items: Array<{
              municipalityName:
                string | null;
              stateRegistration:
                string | null;
              stateRegistrationLookupStatus:
                string | null;
              businessLocationCode:
                string | null;
              cnaes: unknown[];
            }>;
          }>().items[0];

        assert.equal(
          persisted?.municipalityName,
          'Rio Verde',
        );
        assert.equal(
          persisted?.businessLocationCode,
          'MATRIZ-001',
        );
        assert.equal(
          persisted?.stateRegistration,
          '10.999.888-7',
        );
        assert.equal(
          persisted?.stateRegistrationLookupStatus,
          'SUCCESS',
        );
        assert.equal(
          persisted?.cnaes.length,
          3,
        );


        const canonicalCnaes = await admin.query<{ code: string; description: string; official_description: string }>(`
          SELECT c.code, c.description, entry.description AS official_description
          FROM cnaes c
          JOIN official_catalogs cat ON cat.code = 'CNAE'
          JOIN official_catalog_editions ed ON ed.catalog_id = cat.id AND ed.status = 'CURRENT'
          JOIN official_catalog_entries entry ON entry.catalog_edition_id = ed.id
            AND regexp_replace(entry.official_code, '[^0-9]', '', 'g') = c.code
          WHERE c.code IN ('4683400', '4623108', '4632001')
        `);
        assert.equal(canonicalCnaes.rowCount, 3);
        for (const row of canonicalCnaes.rows) {
          assert.equal(row.description, row.official_description);
        }

        const branchRegistryCreate =
          await app.inject({
            method: 'POST',
            url:
              '/api/v1/companies/' +
              registryBody.company.id +
              '/establishments/from-cnpj',
            headers: firstHeaders,
            payload: {
              cnpj: branchRegistryCnpj,
              typeCode: 'OTHER',
              businessLocationCode: 'FILIAL-003',
            },
          });

        assert.equal(
          branchRegistryCreate.statusCode,
          201,
        );

        await assertRegistryReadback(branchRegistryCreate.json());
        const branchBody =
          branchRegistryCreate.json<{
            establishment: {
              cnpj: string;
              businessLocationCode:
                string | null;
              stateRegistration:
                string | null;
              cnaes: unknown[];
            };
          }>();

        assert.equal(
          branchBody.establishment.cnpj,
          branchRegistryCnpj,
        );
        assert.equal(
          branchBody.establishment
            .businessLocationCode,
          'FILIAL-003',
        );
        assert.equal(
          branchBody.establishment
            .stateRegistration,
          '10.999.888-7',
        );
        assert.equal(
          branchBody.establishment
            .cnaes.length,
          3,
        );

        const afterAutomaticBranch = await admin.query<{ code: string; description: string }>(
          "SELECT code, description FROM cnaes WHERE code IN ('4683400', '4623108', '4632001') ORDER BY code",
        );
        assert.deepEqual(
          afterAutomaticBranch.rows,
          canonicalCnaes.rows.map(({ code, description }) => ({ code, description }))
            .sort((a, b) => a.code.localeCompare(b.code)),
          'New automatic branch must never rewrite global CNAE descriptions',
        );

        const branchId = branchRegistryCreate.json().establishment.id;
        const deletedBranch = await app.inject({ method: 'DELETE', url: '/api/v1/establishments/' + branchId, headers: firstHeaders });
        assert.equal(deletedBranch.statusCode, 204, deletedBranch.body);
        const reactivatedBranch = await app.inject({ method: 'POST',
          url: '/api/v1/companies/' + registryBody.company.id + '/establishments/from-cnpj',
          headers: firstHeaders, payload: { cnpj: branchRegistryCnpj, typeCode: 'OTHER',
            businessLocationCode: 'NÃO-REESCREVER', reactivateInactive: true } });
        assert.equal(reactivatedBranch.statusCode, 201, reactivatedBranch.body);
        assert.equal(reactivatedBranch.json().establishment.id, branchId);
        assert.equal(reactivatedBranch.json().establishment.businessLocationCode, 'FILIAL-003');
        await assertRegistryReadback(reactivatedBranch.json());

        const deleteRegistryCompany =
          await app.inject({
            method: 'DELETE',
            url:
              '/api/v1/companies/' +
              registryBody.company.id,
            headers: firstHeaders,
          });

        assert.equal(
          deleteRegistryCompany.statusCode,
          204,
        );

        // After deleting a company, its CNPJ must be available for a clean
        // new registration with fresh IDs and no inherited Local Negócio.
        const previousCompanyId = registryBody.company.id;
        const previousEstablishmentId = registryBody.establishment.id;
        const registryRecreate = await app.inject({
          method: 'POST',
          url: '/api/v1/companies/from-cnpj',
          headers: firstHeaders,
          payload: { cnpj: registryCnpj },
        });
        assert.equal(registryRecreate.statusCode, 201, registryRecreate.body);
        await assertRegistryReadback(registryRecreate.json());

        const recreatedBody = registryRecreate.json<{
          company: { id: string; businessLocationCode: string | null };
          establishment: {
            id: string;
            businessLocationCode: string | null;
            stateRegistration: string | null;
            cnaes: unknown[];
          };
        }>();
        assert.notEqual(recreatedBody.company.id, previousCompanyId);
        assert.notEqual(recreatedBody.establishment.id, previousEstablishmentId);
        assert.equal(recreatedBody.company.businessLocationCode, null);
        assert.equal(recreatedBody.establishment.businessLocationCode, null);
        assert.equal(recreatedBody.establishment.stateRegistration, '10.999.888-7');
        assert.equal(recreatedBody.establishment.cnaes.length, 3);

        const oldCompanyRows = await admin.query(
          'SELECT id FROM companies WHERE id = $1', [previousCompanyId],
        );
        assert.equal(oldCompanyRows.rowCount, 0);
        const oldEstablishmentRows = await admin.query(
          'SELECT id FROM establishments WHERE id = $1', [previousEstablishmentId],
        );
        assert.equal(oldEstablishmentRows.rowCount, 0);

        const accountAfterRecreate = await app.inject({
          method: 'GET', url: '/api/v1/account', headers: firstHeaders,
        });
        assert.equal(accountAfterRecreate.statusCode, 200);
        assert.ok(accountAfterRecreate.json<{
          companies: Array<{ id: string; cnpj: string }>;
        }>().companies.some(
          (item) => item.id === recreatedBody.company.id && item.cnpj === registryCnpj,
        ));
      } finally {
        globalThis.fetch =
          originalFetch;
      }
    } finally {
      await app.close();

      if (publications.length > 0) {
        await admin.query(
          'DELETE FROM publications WHERE id = ANY($1::uuid[])',
          [publications],
        );
      }

      if (users.length > 0) {
        await admin.query(
          'DELETE FROM app_users WHERE id = ANY($1::uuid[])',
          [users],
        );
      }

      if (tenants.length > 0) {
        await admin.query(
          'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
          [tenants],
        );
      }

      await admin.end();
    }
  },
);
