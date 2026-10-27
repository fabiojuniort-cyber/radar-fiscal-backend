import { purgeCompany } from '../../modules/company/company-purge.service.js';
import { readCompanyRegistration, readRegistrationEstablishment } from '../../modules/company/registration-response.service.js';
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
import { CompanyIdentityError, ensureHeadOfficeCnpj } from '../../modules/company/company-identity.guard.js';
import { ManualCnaeValidationError } from '../../modules/company/manual-cnae-validation.service.js';
import { computePublicationAffinity, type ProfileTerm } from '../../modules/taxonomy/affinity/publication-affinity.js';
import { loadPublicationTaxonomy } from '../../modules/taxonomy/curation/curation.tags.js';
import {
  DISPLAY_TITLE_CONTENT_CHARS,
  publicationDisplayTitle,
} from '../../modules/catalog/display-title.js';
import {
  kyselyRunner,
  loadReleaseView,
} from '../../modules/taxonomy/curation/curation.read.js';
import { isCnaeActivity } from '../../modules/taxonomy/curation/curation.constants.js';
import { suggestSegmentsForCompany } from '../../modules/taxonomy/curation/curation.suggestions.js';
import {
  canonicalizeTaxonomyConceptCodes,
  loadTaxonomyCodeCompatibility,
  type TaxonomyCodeCompatibility,
} from '../../modules/taxonomy/taxonomy-code-compatibility.js';
import { notSupersededNcmMention } from '../../modules/taxonomy/ncm/publication-ncm.detector.js';
import { currentWordingText, sanitizeLegalPresentationHtml } from '../../modules/collection/legal-presentation.js';
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
  reactivateInactive: z.boolean().optional(),
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
  reactivateInactive: z.boolean().optional(),
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

/** Names of the tax regime, matched against the act (tags and text). */
const REGIME_LABELS: Record<string, string[]> = {
  SIMPLES_NACIONAL: ['Simples Nacional'],
  LUCRO_PRESUMIDO: ['Lucro Presumido'],
  LUCRO_REAL: ['Lucro Real'],
};

const taxProfileBodySchema = z.object({
  expectedVersion: z.number().int().min(0).optional(),
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
    // NCMs the company works with (card NCM), compared with the NCMs that
    // legislation mentions.
    ncmCodes: z
      .array(z.string().trim().transform((value) => value.replace(/\D/g, '')).refine((value) => /^\d{1,8}$/.test(value)))
      .max(500)
      .default([]),
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
        // Segment of each company CNAE: suggested from the Segmento table,
        // changeable by the user (TAX-11).
        cnaeSegments: z
          .array(
            z.object({
              cnaeCode: z.string().trim().regex(/^\d{7}$/),
              // null: the user removed the CNAE's segment.
              segmentCode: z.string().trim().regex(/^sector\.[a-z0-9_]+$/).nullable(),
            }),
          )
          .max(200)
          .default([]),
      })
      .nullable()
      .default(null),
    // Scoped per establishment; persisted in the same versioned company profile.
    // Old clients may omit this field without erasing previously configured units.
    establishmentOverrides: z.array(z.object({
      establishmentId: z.string().uuid(),
      taxRegime: z.enum([
        'SIMPLES_NACIONAL', 'LUCRO_PRESUMIDO', 'LUCRO_REAL',
        'IMUNE_ISENTA', 'OUTRO', 'NAO_INFORMADO',
      ]),
      conceptCodes: z.array(z.string().trim()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)).max(500).default([]),
      ncmCodes: z.array(z.string().trim()
        .transform((value) => value.replace(/\D/g, ''))
        .refine((value) => /^\d{1,8}$/.test(value))).max(500).default([]),
    })).max(250).optional(),
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

function currentTaxonomyPersonalization(
  personalization: unknown,
  release: { id: string; version: string | null } | null,
  compatibility: TaxonomyCodeCompatibility | null,
): unknown {
  if (!release?.version || !compatibility) return personalization;
  const root = recordValue(personalization);
  const taxonomy = recordValue(root?.taxonomy);
  if (!root || !taxonomy) return personalization;
  const rawCodes = Array.isArray(taxonomy.conceptCodes)
    ? taxonomy.conceptCodes.filter((code): code is string => typeof code === 'string')
    : [];
  return {
    ...root,
    taxonomy: {
      ...taxonomy,
      releaseId: release.id,
      releaseVersion: release.version,
      conceptCodes: canonicalizeTaxonomyConceptCodes(rawCodes, compatibility),
    },
  };
}

/** Last day in force read from the act's current wording (CONFAZ). */
function publicationEffectiveUntil(
  sourceMetadata: unknown,
): { date: string; basis: string; amendedBy: string | null } | null {
  const metadata = recordValue(sourceMetadata);
  const date = metadata?.effectiveUntil;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  return {
    date,
    basis: typeof metadata?.effectiveUntilBasis === 'string' ? metadata.effectiveUntilBasis : 'UNKNOWN',
    amendedBy: typeof metadata?.effectiveUntilAmendedBy === 'string' ? metadata.effectiveUntilAmendedBy : null,
  };
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

const companyPublicationParamsSchema = z.object({
  companyId: z.string().uuid(),
  publicationId: z.string().uuid(),
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
  if (error instanceof ManualCnaeValidationError) {
    return reply.status(error.code === 'cnae_catalog_unavailable' ? 503 : 400)
      .send({ error: error.code });
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
                    // R4: account identity/consent is retained, but the legacy
                    // onboarding identity is NEVER offered as a new company's preset.
                    companyName: null,
                    cnpj: null,
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
        ensureHeadOfficeCnpj(request.body.cnpj);
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
        if (error instanceof CompanyIdentityError) {
          return reply.status(409).send({ error: error.code });
        }
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

      // R4: a retired reactivation request must never touch a legacy inactive record.
      if (request.body.reactivateInactive === true) {
        return reply.status(410).send({ error: 'reactivation_removed' });
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

            const registered = await createCompanyFromRegistry(
              trx,
              tenantId,
              registry,
              stateRegistration,
              request.body.businessLocationCode,
            );
            return readCompanyRegistration(trx, registered.companyId, registered.establishmentId);
          },
        );

        if (!created) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        return reply.status(201).send({
          ...created,
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
        if (error instanceof CompanyIdentityError) {
          return reply.status(409).send({ error: error.code });
        }
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

            // Reject old browser tabs that still promise a soft-delete.
            if (request.headers['x-company-delete-intent'] !== 'permanent-v1') {
              return 'CONFIRMATION_REQUIRED' as const;
            }
            // ONB-02-R3: the SECURITY DEFINER function rechecks tenant/admin
            // authorization and atomically removes all company-owned records.
            // No direct companies DELETE grant is added to radar_app.
            const removed = await purgeCompany(trx, request.params.companyId);
            return removed
              ? 'DELETED' as const
              : 'COMPANY_NOT_FOUND' as const;
          },
        );

        if (result === null) {
          return reply.status(403).send({ error: 'admin_required' });
        }

        if (result === 'CONFIRMATION_REQUIRED') {
          return reply.status(409).send({ error: 'permanent_delete_confirmation_required' });
        }

        if (result === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        return reply.status(204).send();
      } catch (error) {
        // Inconsistent references or ambiguous legacy ownership are a
        // recoverable business conflict, never a silent partial deletion.
        // Do not leak internal identifiers or CNPJ to the client.
        if (error instanceof Error && (
          error.message === 'company_purge_audit_backfill_required' ||
          error.message === 'company_purge_cross_company_link' ||
          error.message === 'company_purge_legacy_identity_ambiguous' ||
          error.message === 'company_purge_historical_identity_ambiguous'
        )) {
          return reply.status(409).send({ error: 'company_purge_review_required' });
        }
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  // ONB-01: only the CURRENT official IBGE/CONCLA catalog is eligible
  // for manual CNAE selection. Never synthesize options from tenant data.
  typed.get(
    '/api/v1/cnae-catalog',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: z.object({
          search: z.string().trim().max(80).default(''),
        }),
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
        const catalog = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const current = await sql<{ id: string; source_url: string | null }>`
              SELECT edition.id, edition.source_url
              FROM official_catalog_editions AS edition
              JOIN official_catalogs AS catalog ON catalog.id = edition.catalog_id
              WHERE catalog.code = 'CNAE' AND edition.status = 'CURRENT'
              ORDER BY edition.created_at DESC
              LIMIT 1
            `.execute(trx);
            const edition = current.rows[0];
            if (!edition) return null;

            const search = request.query.search.trim();
            const numeric = search.replace(/\D/g, '');
            const pattern = `%${search}%`;
            const numericPattern = `%${numeric}%`;
            const entries = await sql<{ official_code: string; description: string }>`
              SELECT entry.official_code, entry.description
              FROM official_catalog_entries AS entry
              WHERE entry.catalog_edition_id = ${edition.id}::uuid
                AND entry.metadata->>'level' = 'SUBCLASSE'
                AND entry.metadata->>'assignable' = 'true'
                AND (
                  ${search} = ''
                  OR entry.description ILIKE ${pattern}
                  OR entry.official_code ILIKE ${pattern}
                  OR (
                    ${numeric} <> ''
                    AND regexp_replace(entry.official_code, '[^0-9]', '', 'g')
                        LIKE ${numericPattern}
                  )
                )
              ORDER BY entry.official_code
              LIMIT 40
            `.execute(trx);

            return {
              source: edition.source_url,
              items: entries.rows.map((row) => ({
                code: row.official_code.replace(/\D/g, ''),
                description: row.description,
              })),
            };
          },
        );
        if (!catalog) {
          return reply.status(503).send({ error: 'cnae_catalog_unavailable' });
        }
        return reply.status(200).send(catalog);
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
              true, // Legacy generic route may clear CNAEs; ONB-01 manual requires one.
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

      // R4: a retired reactivation request must never touch a legacy inactive record.
      if (request.body.reactivateInactive === true) {
        return reply.status(410).send({ error: 'reactivation_removed' });
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

            return readRegistrationEstablishment(trx, establishmentId);
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
          establishment: result,
          registry: {
            source: registry.source,
            consultedAt: registry.consultedAt,
            registrationStatus: registry.registrationStatus,
            openedOn: registry.openedOn,
          },
        });
      } catch (error) {
        if (error instanceof CompanyIdentityError) {
          return reply.status(409).send({ error: error.code });
        }
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
              true, // Legacy generic route may clear CNAEs; ONB-01 manual requires one.
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
              true, // Legacy generic route may clear CNAEs; ONB-01 manual requires one.
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
                conceptCodes: [],
                conceptIndex: [],
                segments: [],
                products: [],
              };
            }

            // TAX-11: presentation comes from the curated release settings
            // (legacy defaults for releases published before curation).
            const view = await loadReleaseView(kyselyRunner(trx), release.id);
            if (!view) {
              return { release: null, dimensions: [], conceptCodes: [], conceptIndex: [], segments: [], products: [] };
            }

            const sectorDimension = view.dimensions.find((dimension) => dimension.officialCodeType === 'CNAE');
            const groupById = new Map(view.groups.map((group) => [group.id, group]));
            return {
              // Segmento table (not CNAE activities): segment per CNAE.
              segments: view.concepts
                .filter(
                  (concept) =>
                    concept.dimensionCode === sectorDimension?.code && !isCnaeActivity(concept.officialCodes),
                )
                .map((concept) => ({ code: concept.code, label: concept.label }))
                .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR')),
              // Produtos table: what a company can parametrize per CNAE.
              products: view.concepts
                .filter((concept) => concept.dimensionCode === 'product' && concept.profileVisible)
                .map((concept) => {
                  const group = concept.groupId ? groupById.get(concept.groupId) : undefined;
                  return {
                    code: concept.code,
                    label: concept.label,
                    groupLabel: group?.label ?? null,
                    segmentCodes: group?.segmentCodes ?? [],
                    officialCodes: concept.officialCodes,
                  };
                })
                .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR')),
              release: {
                id: release.id,
                version: release.version,
                publishedAt: release.published_at
                  ? new Date(release.published_at).toISOString()
                  : null,
              },
              // Every INCLUDED code of the release, visible or not: the profile
              // keeps hidden selections and drops only codes no longer offered.
              conceptCodes: view.concepts.map((concept) => concept.code),
              // Labels of every included concept, so saving a profile keeps the
              // legacy label fields complete for hidden selections too.
              conceptIndex: view.concepts.map((concept) => ({
                code: concept.code,
                label: concept.label,
                dimensionCode: concept.dimensionCode,
              })),
              dimensions: view.dimensions
                .filter((dimension) => dimension.profileVisible)
                .map((dimension) => {
                  const groups = view.groups
                    .filter((group) => group.dimensionCode === dimension.code)
                    .sort(
                      (left, right) =>
                        left.displayOrder - right.displayOrder ||
                        left.label.localeCompare(right.label, 'pt-BR'),
                    );
                  const groupCode = new Map(
                    groups.map((group) => [group.id, group.code]),
                  );
                  return {
                    code: dimension.code,
                    name: dimension.name,
                    description: dimension.description,
                    helpText: dimension.helpText,
                    profileOrder: dimension.profileOrder,
                    usesGroups: dimension.usesGroups,
                    officialCodeType: dimension.officialCodeType,
                    groups: dimension.usesGroups
                      ? groups.map((group) => ({
                          code: group.code,
                          label: group.label,
                          helpText: group.helpText,
                          segmentCodes: group.segmentCodes,
                        }))
                      : [],
                    concepts: view.concepts
                      .filter(
                        (concept) =>
                          concept.dimensionCode === dimension.code &&
                          concept.profileVisible,
                      )
                      .sort(
                        (left, right) =>
                          (left.displayOrder ?? 100000) -
                            (right.displayOrder ?? 100000) ||
                          left.label.localeCompare(right.label, 'pt-BR'),
                      )
                      .map((concept) => ({
                        code: concept.code,
                        label: concept.label,
                        definition: concept.definition,
                        helpText: concept.helpText,
                        groupCode: dimension.usesGroups && concept.groupId
                          ? groupCode.get(concept.groupId) ?? null
                          : null,
                        officialCodes: concept.officialCodes,
                      })),
                  };
                }),
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
    '/api/v1/companies/:companyId/taxonomy-suggestions',
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
        const suggestions = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.params.companyId)
              .where('tenant_id', '=', tenantId)
              .executeTakeFirst();
            if (!company) return null;

            const release = await trx
              .selectFrom('taxonomy_releases')
              .select('id')
              .where('status', '=', 'PUBLISHED')
              .orderBy('version_major', 'desc')
              .orderBy('version_minor', 'desc')
              .orderBy('version_patch', 'desc')
              .executeTakeFirst();
            if (!release) return { segments: [], cnaes: [] };

            return suggestSegmentsForCompany(
              kyselyRunner(trx),
              release.id,
              request.params.companyId,
            );
          },
        );

        if (suggestions === null) {
          return reply.status(404).send({ error: 'company_not_found' });
        }
        return reply.status(200).send(suggestions);
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
        const result = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            const profile = await trx
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
              .executeTakeFirst();

            if (!profile) {
              return { profile: null, release: null, compatibility: null };
            }

            const release = await trx
              .selectFrom('taxonomy_releases')
              .select(['id', 'version'])
              .where('status', '=', 'PUBLISHED')
              .orderBy('version_major', 'desc')
              .orderBy('version_minor', 'desc')
              .orderBy('version_patch', 'desc')
              .executeTakeFirst();
            const compatibility = release
              ? await loadTaxonomyCodeCompatibility(kyselyRunner(trx), release.id)
              : null;
            return { profile, release: release ?? null, compatibility };
          },
        );

        return reply.status(200).send({
          profile: result.profile
            ? {
                id: result.profile.id,
                companyId: result.profile.company_id,
                versionNo: result.profile.version_no,
                taxRegime: result.profile.tax_regime,
                segments: result.profile.segments,
                activities: result.profile.activities,
                personalization: currentTaxonomyPersonalization(
                  result.profile.personalization,
                  result.release,
                  result.compatibility,
                ),
                validFrom: result.profile.valid_from
                  ? new Date(result.profile.valid_from).toISOString().slice(0, 10)
                  : null,
                createdAt: new Date(result.profile.created_at).toISOString(),
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

  // Affinity between a legislation and the company's tax profile: the act's
  // taxonomy tags against the canonical codes chosen in the profile.
  typed.get(
    '/api/v1/companies/:companyId/publications/:publicationId/affinity',
    {
      preHandler: app.authenticate,
      schema: {
        params: companyPublicationParamsSchema,
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
            const row = await trx
              .selectFrom('companies')
              .select(['id', 'legal_name', 'trade_name'])
              .where('id', '=', request.params.companyId)
              .where('is_active', '=', true)
              .executeTakeFirst();
            if (!row) return null;
            const profile = await trx
              .selectFrom('company_tax_profiles')
              .select(['personalization', 'tax_regime'])
              .where('company_id', '=', row.id)
              .where('is_current', '=', true)
              .executeTakeFirst();
            const productCount = await sql<{ count: number }>`
              SELECT count(*)::int AS count FROM company_product_profiles
              WHERE company_id = ${row.id}::uuid AND is_active = TRUE
            `.execute(trx);
            // Products the user typed (not in the Produtos table): by name.
            const manualProducts = await sql<{ label: string }>`
              SELECT DISTINCT product_label AS label FROM company_product_profiles
              WHERE company_id = ${row.id}::uuid AND is_active = TRUE
                AND product_release_concept_id IS NULL
            `.execute(trx);
            // Segment of each CNAE from the Segmento table: counts even before
            // the profile is saved (the user's choice per CNAE wins).
            const release = await trx
              .selectFrom('taxonomy_releases')
              .select('id')
              .where('status', '=', 'PUBLISHED')
              .orderBy('version_major', 'desc')
              .orderBy('version_minor', 'desc')
              .orderBy('version_patch', 'desc')
              .executeTakeFirst();
            const suggested = release
              ? await suggestSegmentsForCompany(kyselyRunner(trx), release.id, row.id)
              : { segments: [], cnaes: [] };
            // Products the company parametrized per CNAE, linked to the
            // taxonomy Produtos table, also describe its profile.
            const products = await sql<{ code: string }>`
              SELECT DISTINCT pc.code
              FROM company_product_profiles cpp
              JOIN taxonomy_release_concepts prc ON prc.id = cpp.product_release_concept_id
              JOIN taxonomy_concepts pc ON pc.id = prc.concept_id
              WHERE cpp.company_id = ${row.id}::uuid
                AND cpp.is_active = TRUE
            `.execute(trx);
            // NCMs of the company: card NCM, CNAE NCMs and product NCMs.
            const cnaeNcms = await sql<{ code: string }>`
              SELECT DISTINCT regexp_replace(e.official_code, '[^0-9]', '', 'g') AS code
              FROM official_catalog_entries e
              WHERE e.id IN (
                SELECT ccn.official_catalog_entry_id FROM company_cnae_ncms ccn WHERE ccn.company_id = ${row.id}::uuid
                UNION
                SELECT cpn.official_catalog_entry_id
                FROM company_product_ncms cpn
                JOIN company_product_profiles cpp ON cpp.id = cpn.company_product_profile_id
                WHERE cpp.company_id = ${row.id}::uuid AND cpp.is_active = TRUE
              )
            `.execute(trx);
            return {
              ...row,
              profile,
              productCount: productCount.rows[0]?.count ?? 0,
              manualProducts: manualProducts.rows.map((item) => item.label),
              cnaeSuggestions: suggested.cnaes,
              productCodes: products.rows.map((item) => item.code),
              ncmCodes: cnaeNcms.rows.map((item) => item.code),
            };
          },
        );
        if (!company) {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        const taxonomy = recordValue(recordValue(company.profile?.personalization)?.taxonomy);
        // Saved choice per CNAE (null = segment removed by the user); CNAEs
        // without a saved choice keep the Segmento table suggestion.
        const savedCnaeSegments = new Map<string, string | null>();
        for (const item of Array.isArray(taxonomy?.cnaeSegments) ? taxonomy.cnaeSegments : []) {
          const entry = recordValue(item);
          if (typeof entry?.cnaeCode !== 'string') continue;
          savedCnaeSegments.set(entry.cnaeCode, typeof entry.segmentCode === 'string' ? entry.segmentCode : null);
        }
        const cnaeSegmentCodes = [
          ...[...savedCnaeSegments.values()].filter((code): code is string => Boolean(code)),
          ...company.cnaeSuggestions
            .filter((cnae) => !savedCnaeSegments.has(cnae.cnaeCode))
            .flatMap((cnae) => cnae.segments.map((segment) => segment.code)),
        ];
        const regimeCodes = company.profile?.tax_regime === 'SIMPLES_NACIONAL' ? ['regime.simples_nacional'] : [];
        // The company's own CNAE activities match the act's CNAE activity tags.
        const cnaeActivityCodes = company.cnaeSuggestions.flatMap((cnae) => cnae.activityCodes ?? []);
        const rawProfileCodes = [
          ...new Set([
            ...(Array.isArray(taxonomy?.conceptCodes)
              ? taxonomy.conceptCodes.filter((code): code is string => typeof code === 'string')
              : []),
            ...cnaeSegmentCodes,
            ...regimeCodes,
            ...cnaeActivityCodes,
            ...company.productCodes,
          ]),
        ];

        const view = await loadPublicationTaxonomy(
          kyselyRunner(app.db),
          request.params.publicationId,
        );
        if (view.status === 'NOT_FOUND') {
          return reply.status(404).send({ error: 'publication_not_found' });
        }
        const compatibility = view.release
          ? await loadTaxonomyCodeCompatibility(kyselyRunner(app.db), view.release.id)
          : null;
        const profileCodes = compatibility
          ? canonicalizeTaxonomyConceptCodes(rawProfileCodes, compatibility)
          : rawProfileCodes;

        const personalization = recordValue(company.profile?.personalization);
        const profileNcms = [
          ...new Set([
            ...(Array.isArray(personalization?.ncmCodes)
              ? personalization.ncmCodes.filter((code): code is string => typeof code === 'string')
              : []),
            ...company.ncmCodes,
          ]),
        ];
        const publicationNcms = profileNcms.length
          ? (
              await sql<{ code: string; description: string | null }>`
                SELECT DISTINCT ON (pnm.ncm_code) pnm.ncm_code AS code, e.description
                FROM publication_versions pv
                JOIN publication_ncm_mentions pnm ON pnm.publication_version_id = pv.id
                LEFT JOIN official_catalog_entries e ON e.id = pnm.official_catalog_entry_id
                WHERE pv.publication_id = ${request.params.publicationId}::uuid
                  AND pv.is_current = TRUE
                  AND pnm.verification_status <> 'REJECTED'
                  AND pnm.ncm_code = ANY(${profileNcms}::text[])
                  AND ${notSupersededNcmMention('pnm')}
                ORDER BY pnm.ncm_code, (pnm.verification_status = 'CATALOG_MATCHED') DESC
              `.execute(app.db)
            ).rows
          : [];

        const profileProductGroups = new Map<string, string>();
        if (view.release && profileCodes.length > 0) {
          const rows = await sql<{ concept_code: string; group_code: string }>`
            SELECT c.code AS concept_code, g.code AS group_code
            FROM taxonomy_release_concepts rc
            JOIN taxonomy_concepts c ON c.id = rc.concept_id
            JOIN taxonomy_release_groups g ON g.id = rc.group_id
            WHERE rc.release_id = ${view.release.id}::uuid
              AND c.code = ANY(${profileCodes}::text[])
          `.execute(app.db);
          for (const item of rows.rows) {
            profileProductGroups.set(item.concept_code, item.group_code);
          }
        }

        // Free-text items of the profile, matched against the act by name.
        const profileTerms: ProfileTerm[] = [
          ...(Array.isArray(personalization?.keywords) ? personalization.keywords : [])
            .filter((term): term is string => typeof term === 'string')
            .map((term) => ({ term, kind: 'keyword' as const })),
          ...company.manualProducts.map((term) => ({ term, kind: 'product' as const })),
          ...(REGIME_LABELS[company.profile?.tax_regime ?? ''] ?? []).map((term) => ({ term, kind: 'regime' as const })),
        ];
        let actText: string | null = null;
        if (profileTerms.length > 0) {
          const current = await sql<{ content_text: string | null; presentation_html: string | null }>`
            SELECT pv.content_text, pv.source_metadata -> 'presentation' ->> 'html' AS presentation_html
            FROM publication_versions pv
            WHERE pv.publication_id = ${request.params.publicationId}::uuid AND pv.is_current = TRUE
          `.execute(app.db);
          const row = current.rows[0];
          actText = row ? currentWordingText(row.presentation_html) ?? row.content_text : null;
        }

        const affinity = computePublicationAffinity({
          view,
          profileTerms,
          actText,
          // Any parameter (saved profile, product or CNAE) starts the comparison.
          hasProfile: Boolean(company.profile) || company.productCount > 0 || company.cnaeSuggestions.length > 0,
          profileCodes,
          profileProductGroups,
          profileNcms,
          publicationNcms,
        });
        return reply.status(200).send({
          company: {
            id: company.id,
            name: company.trade_name || company.legal_name,
          },
          ...affinity,
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
              .forUpdate()
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
            }

            const current = await trx
              .selectFrom('company_tax_profiles')
              .select(['id', 'version_no', 'personalization'])
              .where('company_id', '=', request.params.companyId)
              .where('is_current', '=', true)
              .executeTakeFirst();

            if (request.body.expectedVersion !== (current?.version_no ?? 0)) return 'PROFILE_VERSION_CONFLICT' as const;
            const storedOverrides = recordValue(current?.personalization)?.establishmentOverrides;
            const overrides = request.body.personalization.establishmentOverrides ??
              (Array.isArray(storedOverrides)
                ? storedOverrides as Array<{
                    establishmentId: string; taxRegime: string;
                    conceptCodes: string[]; ncmCodes: string[];
                  }>
                : []);
            if (overrides) {
              const ids = overrides.map((item) => item.establishmentId);
              const unique = [...new Set(ids)];
              if (unique.length !== ids.length) {
                return 'INVALID_ESTABLISHMENT_OVERRIDES' as const;
              }
              if (unique.length > 0) {
                const activeUnits = await trx
                  .selectFrom('establishments')
                  .select('id')
                  .where('company_id', '=', request.params.companyId)
                  .where('is_active', '=', true)
                  .where('id', 'in', unique)
                  .forShare()
                  .execute();
                if (activeUnits.length !== unique.length) {
                  return 'INVALID_ESTABLISHMENT_OVERRIDES' as const;
                }
              }
            }

            const taxonomy =
              request.body.personalization.taxonomy;
            const unitCodes = (overrides ?? [])
              .flatMap((item) => item.conceptCodes);
            if (!taxonomy && unitCodes.length > 0) {
              return 'INVALID_TAXONOMY_RELEASE' as const;
            }

            if (taxonomy) {
              const release = await trx
                .selectFrom('taxonomy_releases')
                .select(['id', 'version'])
                .where('status', '=', 'PUBLISHED')
                .orderBy('version_major', 'desc')
                .orderBy('version_minor', 'desc')
                .orderBy('version_patch', 'desc')
                .executeTakeFirst();

              if (
                !release ||
                release.id !== taxonomy.releaseId ||
                release.version !== taxonomy.releaseVersion
              ) {
                return 'INVALID_TAXONOMY_RELEASE' as const;
              }

              const allConceptCodes = [...new Set([
                ...taxonomy.conceptCodes,
                ...unitCodes,
              ])];
              if (allConceptCodes.length > 0) {
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
                  .where('c.code', 'in', allConceptCodes)
                  .execute();

                if (
                  new Set(concepts.map((concept) => concept.code)).size !==
                  allConceptCodes.length
                ) {
                  return 'INVALID_TAXONOMY_SELECTION' as const;
                }
              }

              const segmentCodes = [
                ...new Set(
                  taxonomy.cnaeSegments.flatMap((item) => (item.segmentCode ? [item.segmentCode] : [])),
                ),
              ];
              if (segmentCodes.length > 0) {
                const segments = await sql<{ code: string; official_codes: string[] | null }>`
                  SELECT c.code, rc.official_codes
                  FROM taxonomy_release_concepts rc
                  JOIN taxonomy_concepts c ON c.id = rc.concept_id
                  JOIN taxonomy_dimensions d ON d.id = c.dimension_id
                  WHERE rc.release_id = ${taxonomy.releaseId}::uuid
                    AND rc.membership_status = 'INCLUDED'
                    AND d.code = 'sector'
                    AND c.code = ANY(${segmentCodes}::text[])
                `.execute(trx);
                const valid = new Set(
                  segments.rows
                    .filter((segment) => !isCnaeActivity(segment.official_codes ?? []))
                    .map((segment) => segment.code),
                );
                if (segmentCodes.some((code) => !valid.has(code))) {
                  return 'INVALID_TAXONOMY_SELECTION' as const;
                }
              }
            }

            // NCMs of the card NCM: assignable entries of the current catalog.
            const ncmCodes = [...new Set([
              ...request.body.personalization.ncmCodes,
              ...(overrides ?? []).flatMap((item) => item.ncmCodes),
            ])];
            if (ncmCodes.length > 0) {
              const found = await sql<{ code: string }>`
                SELECT DISTINCT input.code FROM unnest(${ncmCodes}::text[]) input(code)
                WHERE EXISTS (
                  SELECT 1 FROM official_catalog_entries e
                  JOIN official_catalog_editions ed ON ed.id=e.catalog_edition_id
                  JOIN official_catalogs c ON c.id=ed.catalog_id
                  WHERE c.code='NCM' AND ed.status='CURRENT'
                    AND regexp_replace(e.official_code,'[^0-9]','','g') LIKE input.code || '%'
                )
              `.execute(trx);
              if (found.rows.length !== ncmCodes.length) return 'INVALID_NCM_CODES' as const;
            }

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
                personalization: JSON.stringify({
                  ...request.body.personalization,
                  establishmentOverrides: overrides,
                }),
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

        if (profile === 'PROFILE_VERSION_CONFLICT') return reply.status(409).send({ error: 'profile_version_conflict' });

        if (profile === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({ error: 'company_not_found' });
        }

        if (profile === 'INVALID_TAXONOMY_RELEASE') {
          return reply.status(409).send({ error: 'taxonomy_release_not_available' });
        }

        if (profile === 'INVALID_TAXONOMY_SELECTION') {
          return reply.status(400).send({ error: 'invalid_taxonomy_selection' });
        }

        if (profile === 'INVALID_ESTABLISHMENT_OVERRIDES') {
          return reply.status(400).send({ error: 'invalid_establishment_overrides' });
        }

        if (profile === 'INVALID_NCM_CODES') {
          return reply.status(400).send({ error: 'invalid_ncm_codes' });
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
          title: publicationDisplayTitle(row.title, row.content_text),
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
          effectiveUntil: publicationEffectiveUntil(row.source_metadata),
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
        ])
        .select(
          sql<string | null>`left(pv.content_text, ${DISPLAY_TITLE_CONTENT_CHARS})`.as('content_head'),
        );

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
          title: publicationDisplayTitle(row.title, row.content_head),
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
