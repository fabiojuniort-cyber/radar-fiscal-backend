import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  TenantAccessDeniedError,
  withTenantContext,
} from '../../infrastructure/database/tenant-context.js';
import { isValidCnpj } from '../../modules/auth/public-signup.service.js';
import { sanitizeLegalPresentationHtml } from '../../modules/collection/legal-presentation.js';
import {
  CnpjRegistryError,
  lookupCnpjRegistry,
} from '../../modules/company/cnpj-registry.service.js';
import {
  createCompanyFromRegistry,
  createEstablishmentFromRegistry,
  rebuildCompanyCnaes,
  replaceManualEstablishmentCnaes,
} from '../../modules/company/company-registration.service.js';
import {
  lookupStateRegistration,
} from '../../modules/company/state-registration.service.js';

const cnpjValueSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine(isValidCnpj, 'invalid_cnpj');

const companyBodySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(200).optional(),
  cnpj: cnpjValueSchema,
});

const businessLocationCodeSchema = z
  .string()
  .trim()
  .max(80)
  .transform((value) =>
    value.length > 0 ? value : null,
  )
  .nullable()
  .optional();

const companyFromCnpjBodySchema = z.object({
  cnpj: cnpjValueSchema,
  businessLocationCode:
    businessLocationCodeSchema,
});

const companyUpdateBodySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(200).nullable().optional(),
  businessLocationCode:
    businessLocationCodeSchema,
});

const establishmentFromCnpjBodySchema = z.object({
  cnpj: cnpjValueSchema,
  typeCode: z.string().trim().min(1).max(50).default('OTHER'),
  businessLocationCode:
    businessLocationCodeSchema,
});

const cnaeBodySchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine((value) => /^\d{7}$/.test(value), 'invalid_cnae'),
  description: z.string().trim().min(1).max(300),
  isPrimary: z.boolean().default(false),
});

const cnaesBodySchema = z
  .array(cnaeBodySchema)
  .max(100)
  .superRefine((items, ctx) => {
    const codes = new Set<string>();
    let primaryCount = 0;

    for (const item of items) {
      if (codes.has(item.code)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate_cnae',
        });
      }

      codes.add(item.code);

      if (item.isPrimary) {
        primaryCount += 1;
      }
    }

    if (
      items.length > 0 &&
      primaryCount !== 1
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'one_primary_cnae_required',
      });
    }
  });

const establishmentUpdateBodySchema = z.object({
  name: z.string().trim().min(2).max(200),
  typeCode: z.string().trim().min(1).max(50),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  municipalityName: z.string().trim().max(160).nullable().optional(),
  municipalityIbgeCode: z.string().trim().regex(/^\d{7}$/).nullable().optional(),
  postalCode: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine(
      (value) => value.length === 0 || /^\d{8}$/.test(value),
      'invalid_postal_code',
    )
    .nullable()
    .optional(),
  street: z.string().trim().max(200).nullable().optional(),
  streetNumber: z.string().trim().max(30).nullable().optional(),
  complement: z.string().trim().max(160).nullable().optional(),
  district: z.string().trim().max(160).nullable().optional(),
  stateRegistration: z.string().trim().max(30).nullable().optional(),
  businessLocationCode:
    businessLocationCodeSchema,
  cnaes: cnaesBodySchema.default([]),
});

const establishmentBodySchema = z.object({
  companyId: z.string().uuid(),
  cnpj: cnpjValueSchema,
  name: z.string().trim().min(2).max(200),
  typeCode: z.string().trim().min(1).max(50),
  isHeadOffice: z.boolean().default(false),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  municipalityName: z.string().trim().min(2).max(160).optional(),
  municipalityIbgeCode: z.string().trim().regex(/^\d{7}$/).optional(),
  postalCode: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine(
      (value) => value.length === 0 || /^\d{8}$/.test(value),
      'invalid_postal_code',
    )
    .optional(),
  street: z.string().trim().max(200).optional(),
  streetNumber: z.string().trim().max(30).optional(),
  complement: z.string().trim().max(160).optional(),
  district: z.string().trim().max(160).optional(),
  stateRegistration: z.string().trim().max(30).optional(),
  businessLocationCode:
    businessLocationCodeSchema,
  cnaes: cnaesBodySchema.default([]),
});

const taxProfileBodySchema = z.object({
  taxRegime: z.enum([
    'SIMPLES_NACIONAL',
    'LUCRO_PRESUMIDO',
    'LUCRO_REAL',
    'IMUNE_ISENTA',
    'OUTRO',
    'NAO_INFORMADO',
  ]),
  segments: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  activities: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  personalization: z.object({
    taxes: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
    products: z.array(z.string().trim().min(1).max(120)).max(80).default([]),
    operations: z.array(z.string().trim().min(1).max(120)).max(80).default([]),
    documents: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
    obligations: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
    keywords: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    taxonomy: z
      .object({
        releaseId: z.string().uuid(),
        releaseVersion: z.string().trim().min(1).max(30),
        conceptCodes: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
          )
          .max(500),
      })
      .nullable()
      .default(null),
  }),
});

function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function publicationPresentation(
  sourceMetadata: unknown,
): {
  version: 1;
  format: 'SANITIZED_HTML' | 'PRESERVED_TEXT';
  preservesWhitespace: boolean;
  html?: string;
} {
  const rawPresentation = recordValue(
    recordValue(sourceMetadata)?.presentation,
  );

  if (
    rawPresentation?.format === 'SANITIZED_HTML' &&
    typeof rawPresentation.html === 'string'
  ) {
    const sanitized =
      sanitizeLegalPresentationHtml(
        rawPresentation.html,
      );

    if (sanitized) {
      return {
        version: 1,
        format: 'SANITIZED_HTML',
        preservesWhitespace: true,
        html: sanitized,
      };
    }
  }

  return {
    version: 1,
    format: 'PRESERVED_TEXT',
    preservesWhitespace: true,
  };
}

const companyIdParamsSchema = z.object({
  companyId: z.string().uuid(),
});

const establishmentIdParamsSchema = z.object({
  establishmentId: z.string().uuid(),
});

const publicationIdParamsSchema = z.object({
  publicationId: z.string().uuid(),
});

const monitoringRunsQuerySchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),
});

const archiveQuerySchema = z.object({
  q: z.string().trim().min(2).max(200).optional(),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  jurisdiction: z.enum(['FEDERAL', 'STATE']).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

function tenantIdFromRequest(request: FastifyRequest): string | null {
  const raw = request.headers['x-tenant-id'];

  if (typeof raw !== 'string') {
    return null;
  }

  return z.string().uuid().safeParse(raw).success
    ? raw
    : null;
}

async function requireTenantAdmin(
  trx: Transaction<DB>,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const membership = await trx
    .selectFrom('tenant_memberships')
    .select('role')
    .where('tenant_id', '=', tenantId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  return membership?.role === 'OWNER' || membership?.role === 'ADMIN';
}

function handleTenantError(
  error: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (error instanceof TenantAccessDeniedError) {
    return reply.status(403).send({
      error: 'tenant_access_denied',
    });
  }

  return null;
}

function databaseConstraint(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('constraint' in error)
  ) {
    return undefined;
  }

  const value = (error as { constraint?: unknown }).constraint;
  return typeof value === 'string' ? value : undefined;
}

function handleCnpjRegistryError(
  error: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (!(error instanceof CnpjRegistryError)) {
    return null;
  }

  if (error.code === 'cnpj_not_found') {
    return reply.status(404).send({
      error: error.code,
    });
  }

  if (
    error.code === 'cnpj_provider_invalid_response'
  ) {
    return reply.status(502).send({
      error: error.code,
    });
  }

  return reply.status(503).send({
    error: error.code,
  });
}

export async function productRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/account',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const tenant = await trx
              .selectFrom('tenants')
              .select(['id', 'name', 'slug', 'status'])
              .where('id', '=', tenantId)
              .executeTakeFirstOrThrow();

            const onboarding = await trx
              .selectFrom('tenant_onboarding_profiles')
              .select(['company_name', 'cnpj', 'created_at'])
              .where('tenant_id', '=', tenantId)
              .executeTakeFirst();

            const companies = await trx
              .selectFrom('companies')
              .select([
                'id',
                'legal_name',
                'trade_name',
                'head_office_cnpj',
                'is_active',
              ])
              .where('tenant_id', '=', tenantId)
              .where('is_active', '=', true)
              .orderBy('legal_name')
              .execute();

            const companyItems: Array<{
              id: string;
              legalName: string;
              tradeName: string | null;
              cnpj: string;
              isActive: boolean;
              establishmentCount: number;
              businessLocationCode: string | null;
            }> = [];

            for (const company of companies) {
              const establishments = await trx
                .selectFrom('establishments')
                .select(({ fn }) => fn.countAll<number>().as('count'))
                .where('company_id', '=', company.id)
                .where('is_active', '=', true)
                .executeTakeFirst();

              const headOffice = await trx
                .selectFrom('establishments')
                .select('business_location_code')
                .where('company_id', '=', company.id)
                .where('is_head_office', '=', true)
                .where('is_active', '=', true)
                .executeTakeFirst();

              companyItems.push({
                id: company.id,
                legalName: company.legal_name,
                tradeName: company.trade_name,
                cnpj: company.head_office_cnpj,
                isActive: company.is_active,
                establishmentCount: Number(establishments?.count ?? 0),
                businessLocationCode:
                  headOffice?.business_location_code ?? null,
              });
            }

            return {
              tenant: {
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                status: tenant.status,
              },
              onboarding: onboarding
                ? {
                    companyName: onboarding.company_name,
                    cnpj: onboarding.cnpj,
                    createdAt: new Date(onboarding.created_at).toISOString(),
                  }
                : null,
              companies: companyItems,
            };
          },
        );

        return reply.status(200).send(result);
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/monitoring/runs',
    {
      preHandler: app.authenticate,
      schema: {
        querystring:
          monitoringRunsQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({
          error: 'unauthorized',
        });
      }

      const tenantId =
        tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({
          error: 'tenant_required',
        });
      }

      try {
        const items =
          await withTenantContext(
            app.db,
            request.auth.userId,
            tenantId,
            async (trx) => {
              const membership =
                await trx
                  .selectFrom(
                    'tenant_memberships',
                  )
                  .select('tenant_id')
                  .where(
                    'tenant_id',
                    '=',
                    tenantId,
                  )
                  .where(
                    'user_id',
                    '=',
                    request.auth!.userId,
                  )
                  .executeTakeFirst();

              if (!membership) {
                throw new TenantAccessDeniedError();
              }

              const sourceCode =
                request.query.source ??
                null;

              const result = await sql<{
                id: string;
                source_code: string;
                source_name: string;
                jurisdiction_level: string;
                uf: string | null;
                status: string;
                trigger_type: string;
                scheduled_for:
                  | Date
                  | string;
                started_at:
                  | Date
                  | string
                  | null;
                finished_at:
                  | Date
                  | string
                  | null;
                duration_ms: number | null;
                attempt_count: number;
                found_items: number;
                imported_documents: number;
              }>`
                SELECT
                  cr.id,
                  s.code AS source_code,
                  s.name AS source_name,
                  s.jurisdiction_level,
                  s.uf,
                  cr.status,
                  cr.trigger_type,
                  cr.scheduled_for,
                  cr.started_at,
                  cr.finished_at,
                  CASE
                    WHEN
                      cr.started_at IS NOT NULL
                      AND cr.finished_at IS NOT NULL
                    THEN round(
                      extract(
                        epoch
                        FROM (
                          cr.finished_at -
                          cr.started_at
                        )
                      ) * 1000
                    )::int
                    ELSE NULL
                  END AS duration_ms,
                  (
                    SELECT count(*)::int
                    FROM collection_attempts ca
                    WHERE
                      ca.collection_run_id =
                      cr.id
                  ) AS attempt_count,
                  (
                    SELECT count(*)::int
                    FROM collection_items ci
                    WHERE
                      ci.collection_run_id =
                      cr.id
                  ) AS found_items,
                  (
                    SELECT count(*)::int
                    FROM collection_run_publications crp
                    WHERE
                      crp.collection_run_id =
                      cr.id
                      AND crp.disposition IN (
                        'NEW_PUBLICATION',
                        'NEW_VERSION'
                      )
                  ) AS imported_documents
                FROM collection_runs cr
                JOIN sources s
                  ON s.id = cr.source_id
                WHERE
                  coalesce(
                    cr.started_at,
                    cr.scheduled_for,
                    cr.created_at
                  ) >=
                    now() -
                    interval '24 hours'
                  AND (
                    ${sourceCode}::text
                      IS NULL
                    OR s.code =
                      ${sourceCode}
                  )
                ORDER BY
                  coalesce(
                    cr.started_at,
                    cr.scheduled_for,
                    cr.created_at
                  ) DESC,
                  cr.id DESC
                LIMIT 500
              `.execute(trx);

              return result.rows;
            },
          );

        return reply.status(200).send({
          generatedAt:
            new Date().toISOString(),
          windowHours: 24,
          items: items.map((row) => ({
            id: row.id,
            sourceCode:
              row.source_code,
            sourceName:
              row.source_name,
            jurisdictionLevel:
              row.jurisdiction_level,
            uf: row.uf,
            status: row.status,
            triggerType:
              row.trigger_type,
            scheduledFor:
              new Date(
                row.scheduled_for,
              ).toISOString(),
            startedAt:
              row.started_at
                ? new Date(
                    row.started_at,
                  ).toISOString()
                : null,
            finishedAt:
              row.finished_at
                ? new Date(
                    row.finished_at,
                  ).toISOString()
                : null,
            durationMs:
              row.duration_ms,
            attemptCount:
              row.attempt_count,
            foundItems:
              row.found_items,
            importedDocuments:
              row.imported_documents,
          })),
        });
      } catch (error) {
        const handled =
          handleTenantError(
            error,
            reply,
          );
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/companies',
    {
      preHandler: app.authenticate,
      schema: {
        body: companyBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const company = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            return trx
              .insertInto('companies')
              .values({
                tenant_id: tenantId,
                legal_name: request.body.legalName,
                trade_name: request.body.tradeName ?? null,
                head_office_cnpj: request.body.cnpj,
                is_active: true,
              })
              .returning([
                'id',
                'legal_name',
                'trade_name',
                'head_office_cnpj',
              ])
              .executeTakeFirstOrThrow();
          },
        );

        if (!company) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        return reply.status(201).send({
          company: {
            id: company.id,
            legalName: company.legal_name,
            tradeName: company.trade_name,
            cnpj: company.head_office_cnpj,
            businessLocationCode: null,
          },
        });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;

        if (databaseConstraint(error) === 'uq_company_cnpj_per_tenant') {
          return reply.status(409).send({ error: 'company_cnpj_exists' });
        }

        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/companies/from-cnpj',
    {
      preHandler: app.authenticate,
      schema: {
        body: companyFromCnpjBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const registry = await lookupCnpjRegistry(
          request.body.cnpj,
        );
        const stateRegistration =
          await lookupStateRegistration(
            registry.cnpj,
            registry.uf,
          );

        const created = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            return createCompanyFromRegistry(
              trx,
              tenantId,
              registry,
              stateRegistration,
              request.body.businessLocationCode,
            );
          },
        );

        if (!created) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        return reply.status(201).send({
          company: {
            id: created.companyId,
            legalName: registry.legalName,
            tradeName: registry.tradeName,
            cnpj: registry.cnpj,
            businessLocationCode:
              request.body.businessLocationCode ?? null,
          },
          establishment: {
            id: created.establishmentId,
            cnpj: registry.cnpj,
            name:
              registry.tradeName ??
              registry.legalName,
            typeCode: 'HEAD_OFFICE',
            isHeadOffice: true,
            uf: registry.uf,
            municipalityName:
              registry.municipalityName,
            municipalityIbgeCode:
              registry.municipalityIbgeCode,
            postalCode:
              registry.postalCode,
            street: registry.street,
            streetNumber:
              registry.streetNumber,
            complement:
              registry.complement,
            district: registry.district,
            businessLocationCode:
              request.body.businessLocationCode ?? null,
            stateRegistration:
              stateRegistration.registration,
            stateRegistrationStatus:
              stateRegistration.registrationStatus,
            stateRegistrationLookupStatus:
              stateRegistration.lookupStatus,
            stateRegistrationSource:
              stateRegistration.source,
            stateRegistrationCheckedAt:
              stateRegistration.checkedAt,
            cnaes: registry.cnaes,
          },
          registry: {
            source: registry.source,
            consultedAt:
              registry.consultedAt,
            registrationStatus:
              registry.registrationStatus,
            openedOn:
              registry.openedOn,
          },
        });
      } catch (error) {
        const handledTenant =
          handleTenantError(error, reply);
        if (handledTenant) return handledTenant;

        const handledRegistry =
          handleCnpjRegistryError(
            error,
            reply,
          );
        if (handledRegistry) return handledRegistry;

        const constraint =
          databaseConstraint(error);

        if (
          constraint ===
          'uq_company_cnpj_per_tenant'
        ) {
          return reply.status(409).send({
            error: 'company_cnpj_exists',
          });
        }

        if (
          constraint ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error: 'business_location_code_exists',
          });
        }

        throw error;
      }
    },
  );

  typed.put(
    '/api/v1/companies/:companyId',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
        body: companyUpdateBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const company = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const company = await trx
              .updateTable('companies')
              .set({
                legal_name: request.body.legalName,
                ...(request.body.tradeName !== undefined
                  ? {
                      trade_name:
                        request.body.tradeName,
                    }
                  : {}),
              })
              .where('id', '=', request.params.companyId)
              .where('is_active', '=', true)
              .returning([
                'id',
                'legal_name',
                'trade_name',
                'head_office_cnpj',
              ])
              .executeTakeFirst();

            if (
              company &&
              request.body.businessLocationCode !== undefined
            ) {
              await trx
                .updateTable('establishments')
                .set({
                  business_location_code:
                    request.body.businessLocationCode,
                })
                .where(
                  'company_id',
                  '=',
                  request.params.companyId,
                )
                .where('is_head_office', '=', true)
                .where('is_active', '=', true)
                .execute();
            }

            return company;
          },
        );

        if (company === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (!company) {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        return reply.status(200).send({
          company: {
            id: company.id,
            legalName: company.legal_name,
            tradeName: company.trade_name,
            cnpj: company.head_office_cnpj,
          },
        });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;

        if (
          databaseConstraint(error) ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error: 'business_location_code_exists',
          });
        }

        throw error;
      }
    },
  );

  typed.delete(
    '/api/v1/companies/:companyId',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.params.companyId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
            }

            await trx
              .updateTable('establishments')
              .set({ is_active: false })
              .where('company_id', '=', request.params.companyId)
              .execute();

            await trx
              .updateTable('companies')
              .set({ is_active: false })
              .where('id', '=', request.params.companyId)
              .execute();

            return 'DELETED' as const;
          },
        );

        if (result === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (result === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        return reply.status(204).send();
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/establishment-types',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const rows = await app.db
        .selectFrom('establishment_types')
        .select(['code', 'name'])
        .where('is_active', '=', true)
        .orderBy('sort_order')
        .execute();

      return reply.status(200).send({ items: rows });
    },
  );

  typed.get(
    '/api/v1/companies/:companyId/establishments',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const items = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const rows = await trx
              .selectFrom('establishments')
              .select([
                'id',
                'company_id',
                'cnpj',
                'name',
                'establishment_type_code',
                'is_head_office',
                'uf',
                'municipality_name',
                'municipality_ibge_code',
                'postal_code',
                'street',
                'street_number',
                'complement',
                'district',
                'business_location_code',
                'state_registration',
                'state_registration_status',
                'state_registration_source',
                'state_registration_checked_at',
                'state_registration_lookup_status',
                'is_active',
              ])
              .where('company_id', '=', request.params.companyId)
              .where('is_active', '=', true)
              .orderBy('is_head_office', 'desc')
              .orderBy('name')
              .execute();

            const result = [];

            for (const row of rows) {
              const cnaes = await trx
                .selectFrom('establishment_cnaes as ec')
                .innerJoin('cnaes as c', 'c.code', 'ec.cnae_code')
                .select([
                  'c.code',
                  'c.description',
                  'ec.is_primary',
                ])
                .where('ec.establishment_id', '=', row.id)
                .orderBy('ec.is_primary', 'desc')
                .orderBy('c.code')
                .execute();

              result.push({
                id: row.id,
                companyId: row.company_id,
                cnpj: row.cnpj,
                name: row.name,
                typeCode: row.establishment_type_code,
                isHeadOffice: row.is_head_office,
                uf: row.uf,
                municipalityName: row.municipality_name,
                municipalityIbgeCode: row.municipality_ibge_code,
                postalCode: row.postal_code,
                street: row.street,
                streetNumber: row.street_number,
                complement: row.complement,
                district: row.district,
                businessLocationCode:
                  row.business_location_code,
                stateRegistration: row.state_registration,
                stateRegistrationStatus:
                  row.state_registration_status,
                stateRegistrationSource:
                  row.state_registration_source,
                stateRegistrationCheckedAt:
                  row.state_registration_checked_at
                    ? new Date(
                        row.state_registration_checked_at,
                      ).toISOString()
                    : null,
                stateRegistrationLookupStatus:
                  row.state_registration_lookup_status,
                isActive: row.is_active,
                cnaes: cnaes.map((cnae) => ({
                  code: cnae.code,
                  description: cnae.description,
                  isPrimary: cnae.is_primary,
                })),
              });
            }

            return result;
          },
        );

        return reply.status(200).send({ items });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/establishments',
    {
      preHandler: app.authenticate,
      schema: {
        body: establishmentBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const establishment = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.body.companyId)
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
            }

            const establishmentType = await trx
              .selectFrom('establishment_types')
              .select('code')
              .where('code', '=', request.body.typeCode)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!establishmentType) {
              return 'TYPE_NOT_FOUND' as const;
            }

            const created = await trx
              .insertInto('establishments')
              .values({
                company_id: request.body.companyId,
                cnpj: request.body.cnpj,
                name: request.body.name,
                establishment_type_code: request.body.typeCode,
                is_head_office: request.body.isHeadOffice,
                uf: request.body.uf,
                municipality_name: request.body.municipalityName ?? null,
                municipality_ibge_code:
                  request.body.municipalityIbgeCode ?? null,
                postal_code: request.body.postalCode || null,
                street: request.body.street ?? null,
                street_number: request.body.streetNumber ?? null,
                complement: request.body.complement ?? null,
                district: request.body.district ?? null,
                business_location_code:
                  request.body.businessLocationCode ?? null,
                state_registration: request.body.stateRegistration ?? null,
                state_registration_status: null,
                state_registration_source:
                  request.body.stateRegistration
                    ? 'MANUAL'
                    : null,
                state_registration_checked_at: null,
                state_registration_lookup_status: null,
                is_active: true,
              })
              .returning([
                'id',
                'company_id',
                'cnpj',
                'name',
                'establishment_type_code',
                'is_head_office',
                'uf',
                'municipality_name',
              ])
              .executeTakeFirstOrThrow();

            await replaceManualEstablishmentCnaes(
              trx,
              request.body.companyId,
              created.id,
              request.body.cnaes,
            );

            return created;
          },
        );

        if (establishment === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (establishment === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        if (establishment === 'TYPE_NOT_FOUND') {
          return reply
            .status(400)
            .send({ error: 'invalid_establishment_type' });
        }

        return reply.status(201).send({
          establishment: {
            id: establishment.id,
            companyId: establishment.company_id,
            cnpj: establishment.cnpj,
            name: establishment.name,
            typeCode: establishment.establishment_type_code,
            isHeadOffice: establishment.is_head_office,
            uf: establishment.uf,
            municipalityName: establishment.municipality_name,
          },
        });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;

        const constraint = databaseConstraint(error);

        if (
          constraint === 'uq_establishment_company_cnpj' ||
          constraint === 'uq_company_head_office'
        ) {
          return reply.status(409).send({ error: 'establishment_conflict' });
        }

        if (
          constraint ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error: 'business_location_code_exists',
          });
        }

        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/companies/:companyId/establishments/from-cnpj',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
        body: establishmentFromCnpjBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const registry = await lookupCnpjRegistry(request.body.cnpj);
        const stateRegistration =
          await lookupStateRegistration(
            registry.cnpj,
            registry.uf,
          );

        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.params.companyId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
            }

            const establishmentType = await trx
              .selectFrom('establishment_types')
              .select('code')
              .where('code', '=', request.body.typeCode)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!establishmentType) {
              return 'TYPE_NOT_FOUND' as const;
            }

            const establishmentId =
              await createEstablishmentFromRegistry(
                trx,
                request.params.companyId,
                registry,
                request.body.typeCode,
                stateRegistration,
                request.body.businessLocationCode,
              );

            return { establishmentId };
          },
        );

        if (result === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (result === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        if (result === 'TYPE_NOT_FOUND') {
          return reply.status(400).send({ error: 'invalid_establishment_type' });
        }

        return reply.status(201).send({
          establishment: {
            id: result.establishmentId,
            companyId: request.params.companyId,
            cnpj: registry.cnpj,
            name: registry.tradeName ?? registry.legalName,
            typeCode: request.body.typeCode,
            isHeadOffice: false,
            uf: registry.uf,
            municipalityName: registry.municipalityName,
            municipalityIbgeCode: registry.municipalityIbgeCode,
            postalCode: registry.postalCode,
            street: registry.street,
            streetNumber: registry.streetNumber,
            complement: registry.complement,
            district: registry.district,
            businessLocationCode:
              request.body.businessLocationCode ?? null,
            stateRegistration:
              stateRegistration.registration,
            stateRegistrationStatus:
              stateRegistration.registrationStatus,
            stateRegistrationLookupStatus:
              stateRegistration.lookupStatus,
            stateRegistrationSource:
              stateRegistration.source,
            stateRegistrationCheckedAt:
              stateRegistration.checkedAt,
            cnaes: registry.cnaes,
          },
          registry: {
            source: registry.source,
            consultedAt: registry.consultedAt,
            registrationStatus: registry.registrationStatus,
            openedOn: registry.openedOn,
          },
        });
      } catch (error) {
        const handledTenant = handleTenantError(error, reply);
        if (handledTenant) return handledTenant;

        const handledRegistry = handleCnpjRegistryError(error, reply);
        if (handledRegistry) return handledRegistry;

        const constraint =
          databaseConstraint(error);

        if (
          constraint ===
          'uq_establishment_company_cnpj'
        ) {
          return reply.status(409).send({ error: 'establishment_conflict' });
        }

        if (
          constraint ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error: 'business_location_code_exists',
          });
        }

        throw error;
      }
    },
  );

  typed.put(
    '/api/v1/establishments/:establishmentId',
    {
      preHandler: app.authenticate,
      schema: {
        params: establishmentIdParamsSchema,
        body: establishmentUpdateBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const existing = await trx
              .selectFrom('establishments')
              .select(['id', 'company_id', 'is_head_office'])
              .where('id', '=', request.params.establishmentId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!existing) {
              return 'ESTABLISHMENT_NOT_FOUND' as const;
            }

            const type = await trx
              .selectFrom('establishment_types')
              .select('code')
              .where('code', '=', request.body.typeCode)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!type) {
              return 'TYPE_NOT_FOUND' as const;
            }

            await trx
              .updateTable('establishments')
              .set({
                name: request.body.name,
                establishment_type_code: request.body.typeCode,
                uf: request.body.uf,
                municipality_name: request.body.municipalityName ?? null,
                municipality_ibge_code: request.body.municipalityIbgeCode ?? null,
                postal_code: request.body.postalCode || null,
                street: request.body.street ?? null,
                street_number: request.body.streetNumber ?? null,
                complement: request.body.complement ?? null,
                district: request.body.district ?? null,
                business_location_code:
                  request.body.businessLocationCode ?? null,
                state_registration: request.body.stateRegistration ?? null,
                state_registration_status: null,
                state_registration_source:
                  request.body.stateRegistration
                    ? 'MANUAL'
                    : null,
                state_registration_checked_at: null,
                state_registration_lookup_status: null,
              })
              .where('id', '=', existing.id)
              .execute();

            await replaceManualEstablishmentCnaes(
              trx,
              existing.company_id,
              existing.id,
              request.body.cnaes,
            );

            return {
              companyId: existing.company_id,
            };
          },
        );

        if (result === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (result === 'ESTABLISHMENT_NOT_FOUND') {
          return reply.status(404).send({ error: 'establishment_not_found' });
        }

        if (result === 'TYPE_NOT_FOUND') {
          return reply.status(400).send({ error: 'invalid_establishment_type' });
        }

        return reply.status(200).send({ ok: true });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;

        if (
          databaseConstraint(error) ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error: 'business_location_code_exists',
          });
        }

        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/establishments/:establishmentId/refresh-cnpj',
    {
      preHandler: app.authenticate,
      schema: {
        params: establishmentIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const target = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const row = await trx
              .selectFrom('establishments')
              .select(['id', 'company_id', 'cnpj', 'is_head_office'])
              .where('id', '=', request.params.establishmentId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            return row ?? 'ESTABLISHMENT_NOT_FOUND' as const;
          },
        );

        if (target === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (target === 'ESTABLISHMENT_NOT_FOUND') {
          return reply.status(404).send({ error: 'establishment_not_found' });
        }

        const registry = await lookupCnpjRegistry(target.cnpj);
        const stateRegistration =
          await lookupStateRegistration(
            registry.cnpj,
            registry.uf,
          );

        await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            await trx
              .updateTable('establishments')
              .set({
                name: registry.tradeName ?? registry.legalName,
                uf: registry.uf,
                municipality_name: registry.municipalityName,
                municipality_ibge_code: registry.municipalityIbgeCode,
                postal_code: registry.postalCode,
                street: registry.street,
                street_number: registry.streetNumber,
                complement: registry.complement,
                district: registry.district,
                state_registration:
                  stateRegistration.registration,
                state_registration_status:
                  stateRegistration.registrationStatus,
                state_registration_source:
                  stateRegistration.source,
                state_registration_checked_at:
                  stateRegistration.checkedAt,
                state_registration_lookup_status:
                  stateRegistration.lookupStatus,
              })
              .where('id', '=', target.id)
              .execute();

            if (target.is_head_office) {
              await trx
                .updateTable('companies')
                .set({
                  legal_name: registry.legalName,
                  trade_name: registry.tradeName,
                })
                .where('id', '=', target.company_id)
                .execute();
            }

            await replaceManualEstablishmentCnaes(
              trx,
              target.company_id,
              target.id,
              registry.cnaes,
            );
          },
        );

        return reply.status(200).send({
          ok: true,
          registry: {
            source: registry.source,
            consultedAt: registry.consultedAt,
          },
          stateRegistration: {
            registration:
              stateRegistration.registration,
            status:
              stateRegistration.registrationStatus,
            lookupStatus:
              stateRegistration.lookupStatus,
            source:
              stateRegistration.source,
            checkedAt:
              stateRegistration.checkedAt,
          },
        });
      } catch (error) {
        const handledTenant = handleTenantError(error, reply);
        if (handledTenant) return handledTenant;

        const handledRegistry = handleCnpjRegistryError(error, reply);
        if (handledRegistry) return handledRegistry;

        throw error;
      }
    },
  );

  typed.delete(
    '/api/v1/establishments/:establishmentId',
    {
      preHandler: app.authenticate,
      schema: {
        params: establishmentIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const row = await trx
              .selectFrom('establishments')
              .select(['id', 'company_id', 'is_head_office'])
              .where('id', '=', request.params.establishmentId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!row) {
              return 'ESTABLISHMENT_NOT_FOUND' as const;
            }

            if (row.is_head_office) {
              return 'HEAD_OFFICE' as const;
            }

            await trx
              .updateTable('establishments')
              .set({ is_active: false })
              .where('id', '=', row.id)
              .execute();

            await rebuildCompanyCnaes(
              trx,
              row.company_id,
            );

            return 'DELETED' as const;
          },
        );

        if (result === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (result === 'ESTABLISHMENT_NOT_FOUND') {
          return reply.status(404).send({ error: 'establishment_not_found' });
        }

        if (result === 'HEAD_OFFICE') {
          return reply.status(409).send({ error: 'head_office_requires_company_delete' });
        }

        return reply.status(204).send();
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/taxonomy/profile-options',
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const release = await trx
              .selectFrom('taxonomy_releases')
              .select([
                'id',
                'version',
                'published_at',
              ])
              .where('status', '=', 'PUBLISHED')
              .orderBy('version_major', 'desc')
              .orderBy('version_minor', 'desc')
              .orderBy('version_patch', 'desc')
              .executeTakeFirst();

            if (!release) {
              return {
                release: null,
                dimensions: [],
              };
            }

            const allowedDimensions = [
              'tax',
              'theme',
              'treatment',
              'regime',
              'operation',
              'operation_scope',
              'operation_purpose',
              'operation_channel',
              'document',
              'obligation',
              'sector',
              'product',
              'subject',
              'event',
              'impact_operational',
              'impact_system',
            ];

            const dimensions = await trx
              .selectFrom('taxonomy_release_dimensions as rd')
              .innerJoin(
                'taxonomy_dimensions as d',
                'd.id',
                'rd.dimension_id',
              )
              .innerJoin(
                'taxonomy_dimension_revisions as dr',
                'dr.id',
                'rd.dimension_revision_id',
              )
              .select([
                'd.id',
                'd.code',
                'dr.name',
                'dr.description',
              ])
              .where('rd.release_id', '=', release.id)
              .where('rd.membership_status', '=', 'INCLUDED')
              .where('d.code', 'in', allowedDimensions)
              .orderBy('dr.name')
              .execute();

            const concepts = await trx
              .selectFrom('taxonomy_release_concepts as rc')
              .innerJoin(
                'taxonomy_concepts as c',
                'c.id',
                'rc.concept_id',
              )
              .innerJoin(
                'taxonomy_concept_revisions as cr',
                'cr.id',
                'rc.concept_revision_id',
              )
              .innerJoin(
                'taxonomy_dimensions as d',
                'd.id',
                'c.dimension_id',
              )
              .select([
                'd.code as dimension_code',
                'c.code',
                'cr.label',
                'cr.definition',
              ])
              .where('rc.release_id', '=', release.id)
              .where('rc.membership_status', '=', 'INCLUDED')
              .where('d.code', 'in', allowedDimensions)
              .orderBy('d.code')
              .orderBy('cr.label')
              .execute();

            return {
              release: {
                id: release.id,
                version: release.version,
                publishedAt: release.published_at
                  ? new Date(release.published_at).toISOString()
                  : null,
              },
              dimensions: dimensions.map((dimension) => ({
                code: dimension.code,
                name: dimension.name,
                description: dimension.description,
                concepts: concepts
                  .filter(
                    (concept) =>
                      concept.dimension_code === dimension.code,
                  )
                  .map((concept) => ({
                    code: concept.code,
                    label: concept.label,
                    definition: concept.definition,
                  })),
              })),
            };
          },
        );

        return reply.status(200).send(result);
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/companies/:companyId/tax-profile',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const profile = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) =>
            trx
              .selectFrom('company_tax_profiles')
              .select([
                'id',
                'company_id',
                'version_no',
                'tax_regime',
                'segments',
                'activities',
                'personalization',
                'valid_from',
                'created_at',
              ])
              .where('company_id', '=', request.params.companyId)
              .where('is_current', '=', true)
              .executeTakeFirst(),
        );

        return reply.status(200).send({
          profile: profile
            ? {
                id: profile.id,
                companyId: profile.company_id,
                versionNo: profile.version_no,
                taxRegime: profile.tax_regime,
                segments: profile.segments,
                activities: profile.activities,
                personalization: profile.personalization,
                validFrom: profile.valid_from
                  ? new Date(profile.valid_from).toISOString().slice(0, 10)
                  : null,
                createdAt: new Date(profile.created_at).toISOString(),
              }
            : null,
        });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.put(
    '/api/v1/companies/:companyId/tax-profile',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyIdParamsSchema,
        body: taxProfileBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);

      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }

      try {
        const profile = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (
              !(await requireTenantAdmin(
                trx,
                request.auth!.userId,
                tenantId,
              ))
            ) {
              return null;
            }

            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.params.companyId)
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
            }

            const taxonomy =
              request.body.personalization.taxonomy;

            if (taxonomy) {
              const release = await trx
                .selectFrom('taxonomy_releases')
                .select(['id', 'version'])
                .where('id', '=', taxonomy.releaseId)
                .where('version', '=', taxonomy.releaseVersion)
                .where('status', '=', 'PUBLISHED')
                .executeTakeFirst();

              if (!release) {
                return 'INVALID_TAXONOMY_RELEASE' as const;
              }

              if (taxonomy.conceptCodes.length > 0) {
                const concepts = await trx
                  .selectFrom('taxonomy_release_concepts as rc')
                  .innerJoin(
                    'taxonomy_concepts as c',
                    'c.id',
                    'rc.concept_id',
                  )
                  .select('c.code')
                  .where('rc.release_id', '=', taxonomy.releaseId)
                  .where('rc.membership_status', '=', 'INCLUDED')
                  .where('c.code', 'in', taxonomy.conceptCodes)
                  .execute();

                if (
                  new Set(concepts.map((concept) => concept.code)).size !==
                  new Set(taxonomy.conceptCodes).size
                ) {
                  return 'INVALID_TAXONOMY_SELECTION' as const;
                }
              }
            }

            const current = await trx
              .selectFrom('company_tax_profiles')
              .select(['id', 'version_no'])
              .where('company_id', '=', request.params.companyId)
              .where('is_current', '=', true)
              .executeTakeFirst();

            const today = new Date().toISOString().slice(0, 10);

            if (current) {
              await trx
                .updateTable('company_tax_profiles')
                .set({
                  is_current: false,
                  valid_to: today,
                })
                .where('id', '=', current.id)
                .execute();
            }

            return trx
              .insertInto('company_tax_profiles')
              .values({
                company_id: request.params.companyId,
                version_no: (current?.version_no ?? 0) + 1,
                tax_regime: request.body.taxRegime,
                segments: request.body.segments,
                activities: JSON.stringify(request.body.activities),
                personalization: JSON.stringify(request.body.personalization),
                valid_from: today,
                valid_to: null,
                is_current: true,
              })
              .returning([
                'id',
                'company_id',
                'version_no',
                'tax_regime',
                'segments',
                'activities',
                'personalization',
                'valid_from',
              ])
              .executeTakeFirstOrThrow();
          },
        );

        if (profile === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (profile === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        if (profile === 'INVALID_TAXONOMY_RELEASE') {
          return reply.status(409).send({ error: 'taxonomy_release_not_available' });
        }

        if (profile === 'INVALID_TAXONOMY_SELECTION') {
          return reply.status(400).send({ error: 'invalid_taxonomy_selection' });
        }

        return reply.status(200).send({
          profile: {
            id: profile.id,
            companyId: profile.company_id,
            versionNo: profile.version_no,
            taxRegime: profile.tax_regime,
            segments: profile.segments,
            activities: profile.activities,
            personalization: profile.personalization,
            validFrom: profile.valid_from
              ? new Date(profile.valid_from).toISOString().slice(0, 10)
              : null,
          },
        });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/publications/:publicationId',
    {
      preHandler: app.authenticate,
      schema: {
        params: publicationIdParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const row = await app.db
        .selectFrom('publications as p')
        .leftJoin(
          'publication_versions as pv',
          (join) =>
            join
              .onRef('pv.publication_id', '=', 'p.id')
              .on('pv.is_current', '=', true),
        )
        .select([
          'p.id',
          'p.title',
          'p.act_type',
          'p.act_number',
          'p.agency',
          'p.jurisdiction_level',
          'p.uf',
          'p.published_on',
          'p.effective_on',
          'p.primary_official_url',
          'p.first_collected_at',
          'p.last_seen_at',
          'pv.id as version_id',
          'pv.version_no',
          'pv.content_text',
          'pv.relevant_excerpt',
          'pv.source_metadata',
          'pv.captured_at',
        ])
        .where('p.id', '=', request.params.publicationId)
        .executeTakeFirst();

      if (!row) {
        return reply.status(404).send({ error: 'publication_not_found' });
      }

      const origins = await app.db
        .selectFrom('publication_origins as po')
        .innerJoin('sources as s', 's.id', 'po.source_id')
        .select([
          's.code as source_code',
          's.name as source_name',
          'po.official_url',
          'po.external_id',
          'po.first_seen_at',
          'po.last_seen_at',
        ])
        .where('po.publication_id', '=', row.id)
        .orderBy('po.first_seen_at')
        .execute();

      const versions = await app.db
        .selectFrom('publication_versions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('publication_id', '=', row.id)
        .executeTakeFirst();

      const officialUrl =
        row.primary_official_url ??
        origins[0]?.official_url ??
        null;

      return reply.status(200).send({
        publication: {
          id: row.id,
          title: row.title,
          actType: row.act_type,
          actNumber: row.act_number,
          agency: row.agency,
          jurisdictionLevel: row.jurisdiction_level,
          uf: row.uf,
          publishedOn: row.published_on
            ? new Date(row.published_on).toISOString().slice(0, 10)
            : null,
          effectiveOn: row.effective_on
            ? new Date(row.effective_on).toISOString().slice(0, 10)
            : null,
          officialUrl,
          firstCollectedAt: new Date(row.first_collected_at).toISOString(),
          lastSeenAt: new Date(row.last_seen_at).toISOString(),
        },
        version: row.version_id
          ? {
              id: row.version_id,
              versionNo: row.version_no,
              versionCount: Number(versions?.count ?? 0),
              contentText: row.content_text,
              excerpt: row.relevant_excerpt,
              capturedAt: row.captured_at
                ? new Date(row.captured_at).toISOString()
                : null,
              presentation:
                publicationPresentation(
                  row.source_metadata,
                ),
            }
          : null,
        origins: origins.map((origin) => ({
          sourceCode: origin.source_code,
          sourceName: origin.source_name,
          officialUrl: origin.official_url,
          externalId: origin.external_id,
          firstSeenAt: new Date(origin.first_seen_at).toISOString(),
          lastSeenAt: new Date(origin.last_seen_at).toISOString(),
        })),
      });
    },
  );

  typed.get(
    '/api/v1/archive',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: archiveQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      let query = app.db
        .selectFrom('publications as p')
        .leftJoin(
          'publication_versions as pv',
          (join) =>
            join
              .onRef('pv.publication_id', '=', 'p.id')
              .on('pv.is_current', '=', true),
        )
        .select([
          'p.id',
          'p.title',
          'p.act_type',
          'p.act_number',
          'p.agency',
          'p.jurisdiction_level',
          'p.uf',
          'p.published_on',
          'p.effective_on',
          'p.primary_official_url',
          'pv.relevant_excerpt',
        ]);

      if (request.query.uf) {
        query = query.where('p.uf', '=', request.query.uf);
      }

      if (request.query.jurisdiction) {
        query = query.where(
          'p.jurisdiction_level',
          '=',
          request.query.jurisdiction,
        );
      }

      if (request.query.source) {
        const sourceCode = request.query.source;

        query = query.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('publication_origins as po_filter')
              .innerJoin(
                'sources as s_filter',
                's_filter.id',
                'po_filter.source_id',
              )
              .select('po_filter.id')
              .whereRef(
                'po_filter.publication_id',
                '=',
                'p.id',
              )
              .where('s_filter.code', '=', sourceCode),
          ),
        );
      }

      if (request.query.q) {
        const pattern = '%' + request.query.q + '%';

        query = query.where((eb) =>
          eb.or([
            eb('p.title', 'ilike', pattern),
            eb('p.act_type', 'ilike', pattern),
            eb('p.act_number', 'ilike', pattern),
            eb('p.agency', 'ilike', pattern),
            eb('pv.relevant_excerpt', 'ilike', pattern),
            eb('pv.content_text', 'ilike', pattern),
          ]),
        );
      }

      const offset =
        (request.query.page - 1) * request.query.limit;

      const rows = await query
        .orderBy('p.published_on', 'desc')
        .orderBy('p.first_collected_at', 'desc')
        .limit(request.query.limit + 1)
        .offset(offset)
        .execute();

      const hasMore = rows.length > request.query.limit;
      const pageRows = rows.slice(0, request.query.limit);

      const items = [];

      for (const row of pageRows) {
        const origin = await app.db
          .selectFrom('publication_origins as po')
          .innerJoin('sources as s', 's.id', 'po.source_id')
          .select([
            'po.official_url',
            's.code as source_code',
            's.name as source_name',
          ])
          .where('po.publication_id', '=', row.id)
          .orderBy('po.first_seen_at')
          .executeTakeFirst();

        items.push({
          id: row.id,
          title: row.title,
          actType: row.act_type,
          actNumber: row.act_number,
          agency: row.agency,
          jurisdictionLevel: row.jurisdiction_level,
          uf: row.uf,
          publishedOn: row.published_on
            ? new Date(row.published_on).toISOString().slice(0, 10)
            : null,
          effectiveOn: row.effective_on
            ? new Date(row.effective_on).toISOString().slice(0, 10)
            : null,
          officialUrl: row.primary_official_url ?? origin?.official_url ?? null,
          sourceCode: origin?.source_code ?? null,
          sourceName: origin?.source_name ?? null,
          excerpt: row.relevant_excerpt,
        });
      }

      return reply.status(200).send({
        page: request.query.page,
        limit: request.query.limit,
        hasMore,
        items,
      });
    },
  );

}
