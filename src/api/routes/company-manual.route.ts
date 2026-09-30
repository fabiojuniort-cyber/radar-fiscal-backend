import type {
  FastifyInstance,
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
import { createManualCompanyRegistration } from '../../modules/company/manual-company-registration.service.js';

const cnpjValueSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine(isValidCnpj, 'invalid_cnpj');

const nullableText = (max: number) =>
  z
    .union([
      z.string().trim().max(max),
      z.null(),
    ])
    .optional()
    .transform((value) =>
      typeof value === 'string'
        ? value.length > 0
          ? value
          : null
        : value,
    );

const cnaeSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine(
      (value) => /^\d{7}$/.test(value),
      'invalid_cnae',
    ),
  description: z.string().trim().min(1).max(300),
  isPrimary: z.boolean().default(false),
});

const cnaesSchema = z
  .array(cnaeSchema)
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
  })
  .optional();

const manualCompanyBodySchema = z.object({
  cnpj: cnpjValueSchema,
  legalName: z.string().trim().min(2).max(200),
  establishmentName: nullableText(200),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  municipalityName: nullableText(160),
  municipalityIbgeCode: z
    .union([
      z.string().trim().regex(/^\d{7}$/),
      z.null(),
    ])
    .optional(),
  postalCode: z
    .union([
      z
        .string()
        .trim()
        .transform((value) =>
          value.replace(/\D/g, ''),
        )
        .refine(
          (value) =>
            value.length === 0 ||
            /^\d{8}$/.test(value),
          'invalid_postal_code',
        )
        .transform((value) =>
          value.length > 0 ? value : null,
        ),
      z.null(),
    ])
    .optional(),
  street: nullableText(200),
  streetNumber: nullableText(30),
  complement: nullableText(160),
  district: nullableText(160),
  stateRegistration: nullableText(30),
  businessLocationCode: nullableText(80),
  cnaes: cnaesSchema,
});

function tenantIdFromRequest(
  request: FastifyRequest,
): string | null {
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

  return membership?.role === 'OWNER' ||
    membership?.role === 'ADMIN';
}

function databaseConstraint(
  error: unknown,
): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('constraint' in error)
  ) {
    return undefined;
  }

  const value =
    (error as { constraint?: unknown })
      .constraint;

  return typeof value === 'string'
    ? value
    : undefined;
}

export async function companyManualRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed =
    app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/api/v1/companies/manual',
    {
      preHandler: app.authenticate,
      schema: {
        body: manualCompanyBodySchema,
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
        const created =
          await withTenantContext(
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

              return createManualCompanyRegistration(
                trx,
                tenantId,
                request.body,
              );
            },
          );

        if (!created) {
          return reply.status(403).send({
            error: 'admin_required',
          });
        }

        const cnaes =
          request.body.cnaes ?? [];

        return reply.status(201).send({
          company: {
            id: created.companyId,
            legalName:
              request.body.legalName,
            tradeName: null,
            cnpj: request.body.cnpj,
            businessLocationCode:
              created.businessLocationCode,
          },
          establishment: {
            id: created.establishmentId,
            companyId: created.companyId,
            cnpj: request.body.cnpj,
            name:
              created.establishmentName,
            typeCode: 'HEAD_OFFICE',
            isHeadOffice: true,
            uf: request.body.uf,
            municipalityName:
              request.body.municipalityName ?? null,
            municipalityIbgeCode:
              request.body.municipalityIbgeCode ?? null,
            postalCode:
              request.body.postalCode ?? null,
            street:
              request.body.street ?? null,
            streetNumber:
              request.body.streetNumber ?? null,
            complement:
              request.body.complement ?? null,
            district:
              request.body.district ?? null,
            businessLocationCode:
              created.businessLocationCode,
            stateRegistration:
              created.stateRegistration,
            stateRegistrationStatus: null,
            stateRegistrationLookupStatus: null,
            stateRegistrationSource:
              created.stateRegistrationSource,
            stateRegistrationCheckedAt: null,
            cnaes,
          },
          registry: {
            source: 'MANUAL',
            consultedAt:
              new Date().toISOString(),
            registrationStatus: null,
            openedOn: null,
          },
        });
      } catch (error) {
        if (
          error instanceof
          TenantAccessDeniedError
        ) {
          return reply.status(403).send({
            error: 'tenant_access_denied',
          });
        }

        const constraint =
          databaseConstraint(error);

        if (
          constraint ===
          'uq_establishment_business_location_per_company'
        ) {
          return reply.status(409).send({
            error:
              'business_location_code_exists',
          });
        }

        if (
          constraint ===
            'uq_company_cnpj_per_tenant' ||
          constraint ===
            'uq_company_head_office' ||
          constraint ===
            'uq_establishment_company_cnpj'
        ) {
          return reply.status(409).send({
            error: 'company_cnpj_exists',
          });
        }

        throw error;
      }
    },
  );
}
