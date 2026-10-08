import { readRegistrationEstablishment } from '../../modules/company/registration-response.service.js';
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
import { CompanyIdentityError } from '../../modules/company/company-identity.guard.js';
import { ManualCnaeValidationError } from '../../modules/company/manual-cnae-validation.service.js';
import {
  createOrReactivateManualEstablishment,
  ManualEstablishmentConflictError,
} from '../../modules/company/manual-establishment-registration.service.js';

const cnpjValueSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine(isValidCnpj, 'invalid_cnpj');

const optionalText = (max: number) =>
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

const businessLocationCodeSchema = z
  .union([
    z.string().trim().max(80),
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
      if (item.isPrimary) primaryCount += 1;
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

const bodySchema = z.object({
  companyId: z.string().uuid(),
  cnpj: cnpjValueSchema,
  name: z.string().trim().min(2).max(200),
  typeCode: z.string().trim().min(1).max(50),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  municipalityName: optionalText(160),
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
  street: optionalText(200),
  streetNumber: optionalText(30),
  complement: optionalText(160),
  district: optionalText(160),
  stateRegistration: optionalText(30),
  businessLocationCode:
    businessLocationCodeSchema,
  cnaes: cnaesSchema,
  reactivateInactive: z.boolean().default(false),
});

function tenantIdFromRequest(
  request: FastifyRequest,
): string | null {
  const raw = request.headers['x-tenant-id'];

  if (typeof raw !== 'string') return null;

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

  const constraint =
    (error as { constraint?: unknown })
      .constraint;

  return typeof constraint === 'string'
    ? constraint
    : undefined;
}

export async function establishmentManualRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed =
    app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/api/v1/establishments/manual',
    {
      preHandler: app.authenticate,
      schema: { body: bodySchema },
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
              return 'ADMIN_REQUIRED' as const;
            }

            const company = await trx
              .selectFrom('companies')
              .select('id')
              .where('id', '=', request.body.companyId)
              .where('is_active', '=', true)
              .executeTakeFirst();

            if (!company) {
              return 'COMPANY_NOT_FOUND' as const;
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

            const registered = await createOrReactivateManualEstablishment(
              trx,
              request.body,
            );
            return readRegistrationEstablishment(trx, registered.establishmentId);
          },
        );

        if (result === 'ADMIN_REQUIRED') {
          return reply.status(403).send({
            error: 'admin_required',
          });
        }

        if (result === 'COMPANY_NOT_FOUND') {
          return reply.status(404).send({
            error: 'company_not_found',
          });
        }

        if (result === 'TYPE_NOT_FOUND') {
          return reply.status(400).send({
            error: 'invalid_establishment_type',
          });
        }

        return reply.status(201).send({
          establishment: result,
        });
      } catch (error) {
        if (error instanceof CompanyIdentityError) {
          return reply.status(409).send({ error: error.code });
        }
        if (error instanceof ManualCnaeValidationError) {
          return reply.status(error.code === 'cnae_catalog_unavailable' ? 503 : 400)
            .send({ error: error.code });
        }
        if (
          error instanceof
          TenantAccessDeniedError
        ) {
          return reply.status(403).send({
            error: 'tenant_access_denied',
          });
        }

        if (
          error instanceof
          ManualEstablishmentConflictError
        ) {
          return reply.status(409).send({
            error: error.code,
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
          'uq_establishment_company_cnpj'
        ) {
          return reply.status(409).send({
            error: 'establishment_conflict',
          });
        }

        throw error;
      }
    },
  );
}
