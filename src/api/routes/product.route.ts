import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  TenantAccessDeniedError,
  withTenantContext,
} from '../../infrastructure/database/tenant-context.js';
import { isValidCnpj } from '../../modules/auth/public-signup.service.js';

const companyBodySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(200).optional(),
  cnpj: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine(isValidCnpj, 'invalid_cnpj'),
});

const establishmentBodySchema = z.object({
  companyId: z.string().uuid(),
  cnpj: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine(isValidCnpj, 'invalid_cnpj'),
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
  }),
});

const companyIdParamsSchema = z.object({
  companyId: z.string().uuid(),
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
              .orderBy('legal_name')
              .execute();

            const companyItems: Array<{
              id: string;
              legalName: string;
              tradeName: string | null;
              cnpj: string;
              isActive: boolean;
              establishmentCount: number;
            }> = [];

            for (const company of companies) {
              const establishments = await trx
                .selectFrom('establishments')
                .select(({ fn }) => fn.countAll<number>().as('count'))
                .where('company_id', '=', company.id)
                .where('is_active', '=', true)
                .executeTakeFirst();

              companyItems.push({
                id: company.id,
                legalName: company.legal_name,
                tradeName: company.trade_name,
                cnpj: company.head_office_cnpj,
                isActive: company.is_active,
                establishmentCount: Number(establishments?.count ?? 0),
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
        const rows = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) =>
            trx
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
                'is_active',
              ])
              .where('company_id', '=', request.params.companyId)
              .orderBy('is_head_office', 'desc')
              .orderBy('name')
              .execute(),
        );

        return reply.status(200).send({
          items: rows.map((row) => ({
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
            isActive: row.is_active,
          })),
        });
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

            return trx
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
}
