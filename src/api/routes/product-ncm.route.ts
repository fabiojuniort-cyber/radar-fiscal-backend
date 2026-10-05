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

const companyParamsSchema = z.object({ companyId: z.string().uuid() });
const productParamsSchema = z.object({
  companyId: z.string().uuid(),
  profileId: z.string().uuid(),
});
const publicationParamsSchema = z.object({ publicationId: z.string().uuid() });
const ncmQuerySchema = z.object({
  q: z.string().trim().max(160).default(''),
  // NCM codes of a product of the taxonomy (any level): lists the assignable
  // NCMs under them, so the profile only offers the product's own NCMs.
  prefixes: z
    .string()
    .trim()
    .max(2000)
    .default('')
    .transform((value) => [...new Set(value.split(',').map((item) => item.replace(/\D/g, '')).filter((item) => item.length >= 2))].slice(0, 100)),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const cnaeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => /^\d{7}$/.test(value), 'invalid_cnae');

const ncmCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => /^\d{8}$/.test(value), 'invalid_ncm');

const productProfileBodySchema = z
  .object({
    cnaeCode: cnaeSchema.nullable().default(null),
    productLabel: z.string().trim().min(1).max(160),
    // Item of the taxonomy Produtos table (published release).
    productConceptCode: z
      .string()
      .trim()
      .regex(/^product\.[a-z0-9_]+$/)
      .nullable()
      .default(null),
    ncmCodes: z.array(ncmCodeSchema).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.ncmCodes).size !== value.ncmCodes.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate_ncm', path: ['ncmCodes'] });
    }
  });

// NCMs a company declares for one of its CNAEs, independent of products.
const cnaeNcmBodySchema = z.object({
  cnaeCode: cnaeSchema,
  ncmCodes: z.array(ncmCodeSchema).min(1).max(100),
});
const cnaeNcmParamsSchema = z.object({
  companyId: z.string().uuid(),
  ncmId: z.string().uuid(),
});

interface CnaeNcmRow {
  id: string;
  cnae_code: string;
  entry_id: string;
  official_code: string;
  description: string;
}

interface ProfileRow {
  id: string;
  company_id: string;
  cnae_code: string | null;
  cnae_description: string | null;
  taxonomy_release_id: string | null;
  sector_release_concept_id: string | null;
  product_release_concept_id: string | null;
  product_concept_code: string | null;
  product_label: string;
  created_at: Date | string;
  updated_at: Date | string;
  ncms: unknown;
}

interface NcmEntryRow {
  id: string;
  official_code: string;
  code: string;
  description: string;
  edition_code: string;
  valid_from: Date | string | null;
}

interface PublicationNcmRow {
  ncm_code: string;
  description: string | null;
  verification_status: string;
  method_type: string;
  detector_key: string;
  detector_version: string;
  confidence: string | number | null;
  excerpt: string | null;
}

function tenantIdFromRequest(request: FastifyRequest): string | null {
  const value = request.headers['x-tenant-id'];
  if (typeof value !== 'string') return null;
  return z.string().uuid().safeParse(value).success ? value : null;
}

function handleTenantError(error: unknown, reply: FastifyReply): FastifyReply | null {
  return error instanceof TenantAccessDeniedError
    ? reply.status(403).send({ error: 'tenant_access_denied' })
    : null;
}

function databaseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeNcms(value: unknown): Array<{
  entryId: string;
  code: string;
  officialCode: string;
  description: string;
  isPrimary: boolean;
  assignmentSource: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.entryId !== 'string' ||
      typeof row.code !== 'string' ||
      typeof row.officialCode !== 'string' ||
      typeof row.description !== 'string' ||
      typeof row.isPrimary !== 'boolean' ||
      typeof row.assignmentSource !== 'string'
    ) {
      return [];
    }
    return [{
      entryId: row.entryId,
      code: row.code,
      officialCode: row.officialCode,
      description: row.description,
      isPrimary: row.isPrimary,
      assignmentSource: row.assignmentSource,
    }];
  });
}

function profileResponse(row: ProfileRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    cnaeCode: row.cnae_code,
    cnaeDescription: row.cnae_description,
    productLabel: row.product_label,
    taxonomy: {
      releaseId: row.taxonomy_release_id,
      sectorConceptId: row.sector_release_concept_id,
      productConceptId: row.product_release_concept_id,
    },
    productConceptCode: row.product_concept_code,
    ncms: normalizeNcms(row.ncms),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function assertCompany(
  trx: Transaction<DB>,
  companyId: string,
  tenantId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('companies')
    .select('id')
    .where('id', '=', companyId)
    .where('tenant_id', '=', tenantId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  return Boolean(row);
}

async function assertCompanyCnae(
  trx: Transaction<DB>,
  companyId: string,
  cnaeCode: string | null,
): Promise<boolean> {
  if (!cnaeCode) return true;
  const result = await sql<{ ok: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM company_cnaes cc
      WHERE cc.company_id = ${companyId}::uuid
        AND cc.cnae_code = ${cnaeCode}
      UNION ALL
      SELECT 1
      FROM establishment_cnaes ec
      INNER JOIN establishments e ON e.id = ec.establishment_id
      WHERE e.company_id = ${companyId}::uuid
        AND e.is_active = TRUE
        AND ec.cnae_code = ${cnaeCode}
    ) AS ok
  `.execute(trx);
  return result.rows[0]?.ok === true;
}

async function resolveNcmEntries(
  trx: Transaction<DB>,
  codes: string[],
): Promise<NcmEntryRow[]> {
  if (codes.length === 0) return [];
  return (
    await sql<NcmEntryRow>`
      SELECT
        e.id,
        e.official_code,
        regexp_replace(e.official_code, '[^0-9]', '', 'g') AS code,
        e.description,
        ed.edition_code,
        ed.valid_from
      FROM official_catalog_entries e
      INNER JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
      INNER JOIN official_catalogs c ON c.id = ed.catalog_id
      WHERE c.code = 'NCM'
        AND ed.status = 'CURRENT'
        AND COALESCE((e.metadata ->> 'assignable')::boolean, FALSE) = TRUE
        AND regexp_replace(e.official_code, '[^0-9]', '', 'g') = ANY(${codes}::text[])
    `.execute(trx)
  ).rows;
}

async function readProfiles(
  trx: Transaction<DB>,
  companyId: string,
): Promise<ProfileRow[]> {
  return (
    await sql<ProfileRow>`
      SELECT
        cpp.id,
        cpp.company_id,
        cpp.cnae_code::text AS cnae_code,
        c.description AS cnae_description,
        cpp.taxonomy_release_id,
        cpp.sector_release_concept_id,
        cpp.product_release_concept_id,
        pc.code AS product_concept_code,
        cpp.product_label,
        cpp.created_at,
        cpp.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'entryId', e.id,
              'code', regexp_replace(e.official_code, '[^0-9]', '', 'g'),
              'officialCode', e.official_code,
              'description', e.description,
              'isPrimary', cpn.is_primary,
              'assignmentSource', cpn.assignment_source
            )
            ORDER BY cpn.is_primary DESC, e.official_code
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::jsonb
        ) AS ncms
      FROM company_product_profiles cpp
      LEFT JOIN cnaes c ON c.code = cpp.cnae_code
      LEFT JOIN taxonomy_release_concepts prc ON prc.id = cpp.product_release_concept_id
      LEFT JOIN taxonomy_concepts pc ON pc.id = prc.concept_id
      LEFT JOIN company_product_ncms cpn ON cpn.company_product_profile_id = cpp.id
      LEFT JOIN official_catalog_entries e ON e.id = cpn.official_catalog_entry_id
      WHERE cpp.company_id = ${companyId}::uuid
        AND cpp.is_active = TRUE
      GROUP BY
        cpp.id,
        cpp.company_id,
        cpp.cnae_code,
        c.description,
        cpp.taxonomy_release_id,
        cpp.sector_release_concept_id,
        cpp.product_release_concept_id,
        pc.code,
        cpp.product_label,
        cpp.created_at,
        cpp.updated_at
      ORDER BY cpp.cnae_code NULLS LAST, lower(cpp.product_label), cpp.id
    `.execute(trx)
  ).rows;
}

/** Product of the current published taxonomy release, by canonical code. */
async function resolveProductConcept(
  trx: Transaction<DB>,
  code: string | null,
): Promise<{ releaseId: string; releaseConceptId: string } | null | 'invalid'> {
  if (!code) return null;
  const result = await sql<{ release_id: string; id: string }>`
    SELECT rc.release_id, rc.id
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c ON c.id = rc.concept_id
    JOIN taxonomy_dimensions d ON d.id = c.dimension_id
    WHERE rc.release_id = (
        SELECT id FROM taxonomy_releases
        WHERE status = 'PUBLISHED'
        ORDER BY version_major DESC, version_minor DESC, version_patch DESC
        LIMIT 1
      )
      AND rc.membership_status = 'INCLUDED'
      AND d.code = 'product'
      AND c.code = ${code}
  `.execute(trx);
  const row = result.rows[0];
  return row ? { releaseId: row.release_id, releaseConceptId: row.id } : 'invalid';
}

async function readCnaeNcms(
  trx: Transaction<DB>,
  companyId: string,
): Promise<CnaeNcmRow[]> {
  return (
    await sql<CnaeNcmRow>`
      SELECT
        ccn.id,
        ccn.cnae_code::text AS cnae_code,
        e.id AS entry_id,
        e.official_code,
        e.description
      FROM company_cnae_ncms ccn
      JOIN official_catalog_entries e ON e.id = ccn.official_catalog_entry_id
      WHERE ccn.company_id = ${companyId}::uuid
      ORDER BY ccn.cnae_code, e.official_code
    `.execute(trx)
  ).rows;
}

function cnaeNcmResponse(row: CnaeNcmRow) {
  return {
    id: row.id,
    cnaeCode: row.cnae_code,
    entryId: row.entry_id,
    code: row.official_code.replace(/\D/g, ''),
    officialCode: row.official_code,
    description: row.description,
  };
}

async function replaceNcms(
  trx: Transaction<DB>,
  profileId: string,
  entries: NcmEntryRow[],
): Promise<void> {
  await sql`
    DELETE FROM company_product_ncms
    WHERE company_product_profile_id = ${profileId}::uuid
  `.execute(trx);
  for (const entry of entries) {
    await sql`
      INSERT INTO company_product_ncms (
        company_product_profile_id,
        official_catalog_entry_id,
        is_primary,
        assignment_source
      ) VALUES (${profileId}::uuid, ${entry.id}::uuid, FALSE, 'MANUAL')
    `.execute(trx);
  }
}

export async function productNcmRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/ncm',
    {
      preHandler: app.authenticate,
      schema: { querystring: ncmQuerySchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const q = request.query.q.trim();
      const digits = q.replace(/\D/g, '');
      const prefixes = request.query.prefixes;
      const prefixPatterns = prefixes.map((prefix) => `${prefix}%`);
      const result = await sql<NcmEntryRow>`
        SELECT
          e.id,
          e.official_code,
          regexp_replace(e.official_code, '[^0-9]', '', 'g') AS code,
          e.description,
          ed.edition_code,
          ed.valid_from
        FROM official_catalog_entries e
        INNER JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
        INNER JOIN official_catalogs c ON c.id = ed.catalog_id
        WHERE c.code = 'NCM'
          AND ed.status = 'CURRENT'
          AND COALESCE((e.metadata ->> 'assignable')::boolean, FALSE) = TRUE
          AND (
            ${prefixes.length === 0}
            OR regexp_replace(e.official_code, '[^0-9]', '', 'g') LIKE ANY(${prefixPatterns}::text[])
          )
          AND (
            ${q.length === 0}
            OR e.description ILIKE ${`%${q}%`}
            OR regexp_replace(e.official_code, '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
          )
        ORDER BY e.official_code
        LIMIT ${request.query.limit}
      `.execute(app.db);

      return reply.status(200).send({
        items: result.rows.map((row) => ({
          entryId: row.id,
          code: row.code,
          officialCode: row.official_code,
          description: row.description,
        })),
        edition: result.rows[0]
          ? {
              code: result.rows[0].edition_code,
              validFrom: iso(result.rows[0].valid_from)?.slice(0, 10) ?? null,
            }
          : null,
      });
    },
  );

  typed.get(
    '/api/v1/companies/:companyId/product-profiles',
    {
      preHandler: app.authenticate,
      schema: { params: companyParamsSchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const rows = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (!(await assertCompany(trx, request.params.companyId, tenantId))) return null;
            return readProfiles(trx, request.params.companyId);
          },
        );
        if (rows === null) return reply.status(404).send({ error: 'company_not_found' });
        return reply.status(200).send({ items: rows.map(profileResponse) });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/companies/:companyId/product-profiles',
    {
      preHandler: app.authenticate,
      schema: { params: companyParamsSchema, body: productProfileBodySchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const created = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (!(await assertCompany(trx, request.params.companyId, tenantId))) {
              return { kind: 'company_not_found' as const };
            }
            if (!(await assertCompanyCnae(trx, request.params.companyId, request.body.cnaeCode))) {
              return { kind: 'cnae_not_linked' as const };
            }
            const product = await resolveProductConcept(trx, request.body.productConceptCode);
            if (product === 'invalid') return { kind: 'invalid_product' as const };
            const entries = await resolveNcmEntries(trx, request.body.ncmCodes);
            const resolved = new Set(entries.map((entry) => entry.code));
            const invalidCodes = request.body.ncmCodes.filter((code) => !resolved.has(code));
            if (invalidCodes.length > 0) {
              return { kind: 'invalid_ncm_codes' as const, invalidCodes };
            }
            const inserted = await sql<{ id: string }>`
              INSERT INTO company_product_profiles (
                company_id, cnae_code, product_label, taxonomy_release_id, product_release_concept_id
              )
              VALUES (
                ${request.params.companyId}::uuid,
                ${request.body.cnaeCode},
                ${request.body.productLabel},
                ${product?.releaseId ?? null}::uuid,
                ${product?.releaseConceptId ?? null}::uuid
              )
              RETURNING id
            `.execute(trx);
            const profileId = inserted.rows[0]?.id;
            if (!profileId) throw new Error('product_profile_insert_failed');
            await replaceNcms(trx, profileId, entries);
            const row = (await readProfiles(trx, request.params.companyId))
              .find((candidate) => candidate.id === profileId);
            if (!row) throw new Error('product_profile_readback_failed');
            return { kind: 'ok' as const, row };
          },
        );
        if (created.kind === 'company_not_found') {
          return reply.status(404).send({ error: created.kind });
        }
        if (created.kind === 'cnae_not_linked' || created.kind === 'invalid_product') {
          return reply.status(400).send({ error: created.kind });
        }
        if (created.kind === 'invalid_ncm_codes') {
          return reply.status(400).send({ error: created.kind, invalidCodes: created.invalidCodes });
        }
        return reply.status(201).send(profileResponse(created.row));
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        if (databaseCode(error) === '23505') {
          return reply.status(409).send({ error: 'product_profile_exists' });
        }
        throw error;
      }
    },
  );

  typed.put(
    '/api/v1/companies/:companyId/product-profiles/:profileId',
    {
      preHandler: app.authenticate,
      schema: { params: productParamsSchema, body: productProfileBodySchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const updated = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (!(await assertCompany(trx, request.params.companyId, tenantId))) {
              return { kind: 'company_not_found' as const };
            }
            if (!(await assertCompanyCnae(trx, request.params.companyId, request.body.cnaeCode))) {
              return { kind: 'cnae_not_linked' as const };
            }
            const existing = await sql<{ id: string }>`
              SELECT id
              FROM company_product_profiles
              WHERE id = ${request.params.profileId}::uuid
                AND company_id = ${request.params.companyId}::uuid
                AND is_active = TRUE
              FOR UPDATE
            `.execute(trx);
            if (!existing.rows[0]) return { kind: 'profile_not_found' as const };
            const product = await resolveProductConcept(trx, request.body.productConceptCode);
            if (product === 'invalid') return { kind: 'invalid_product' as const };
            const entries = await resolveNcmEntries(trx, request.body.ncmCodes);
            const resolved = new Set(entries.map((entry) => entry.code));
            const invalidCodes = request.body.ncmCodes.filter((code) => !resolved.has(code));
            if (invalidCodes.length > 0) {
              return { kind: 'invalid_ncm_codes' as const, invalidCodes };
            }
            await sql`
              UPDATE company_product_profiles
              SET
                cnae_code = ${request.body.cnaeCode},
                product_label = ${request.body.productLabel},
                taxonomy_release_id = ${product?.releaseId ?? null}::uuid,
                product_release_concept_id = ${product?.releaseConceptId ?? null}::uuid,
                updated_at = now()
              WHERE id = ${request.params.profileId}::uuid
            `.execute(trx);
            await replaceNcms(trx, request.params.profileId, entries);
            const row = (await readProfiles(trx, request.params.companyId))
              .find((candidate) => candidate.id === request.params.profileId);
            if (!row) throw new Error('product_profile_readback_failed');
            return { kind: 'ok' as const, row };
          },
        );
        if (updated.kind === 'company_not_found' || updated.kind === 'profile_not_found') {
          return reply.status(404).send({ error: updated.kind });
        }
        if (updated.kind === 'cnae_not_linked' || updated.kind === 'invalid_product') {
          return reply.status(400).send({ error: updated.kind });
        }
        if (updated.kind === 'invalid_ncm_codes') {
          return reply.status(400).send({ error: updated.kind, invalidCodes: updated.invalidCodes });
        }
        return reply.status(200).send(profileResponse(updated.row));
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        if (databaseCode(error) === '23505') {
          return reply.status(409).send({ error: 'product_profile_exists' });
        }
        throw error;
      }
    },
  );

  typed.delete(
    '/api/v1/companies/:companyId/product-profiles/:profileId',
    {
      preHandler: app.authenticate,
      schema: { params: productParamsSchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const outcome = await withTenantContext(
          app.db,
          request.auth.userId,
          tenantId,
          async (trx) => {
            if (!(await assertCompany(trx, request.params.companyId, tenantId))) {
              return 'company_not_found' as const;
            }
            const result = await sql`
              UPDATE company_product_profiles
              SET is_active = FALSE, updated_at = now()
              WHERE id = ${request.params.profileId}::uuid
                AND company_id = ${request.params.companyId}::uuid
                AND is_active = TRUE
            `.execute(trx);
            return (result.numAffectedRows ?? 0n) > 0n
              ? 'ok' as const
              : 'profile_not_found' as const;
          },
        );
        if (outcome !== 'ok') return reply.status(404).send({ error: outcome });
        return reply.status(204).send();
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/companies/:companyId/cnae-ncms',
    {
      preHandler: app.authenticate,
      schema: { params: companyParamsSchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const rows = await withTenantContext(app.db, request.auth.userId, tenantId, async (trx) => {
          if (!(await assertCompany(trx, request.params.companyId, tenantId))) return null;
          return readCnaeNcms(trx, request.params.companyId);
        });
        if (rows === null) return reply.status(404).send({ error: 'company_not_found' });
        return reply.status(200).send({ items: rows.map(cnaeNcmResponse) });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.post(
    '/api/v1/companies/:companyId/cnae-ncms',
    {
      preHandler: app.authenticate,
      schema: { params: companyParamsSchema, body: cnaeNcmBodySchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const outcome = await withTenantContext(app.db, request.auth.userId, tenantId, async (trx) => {
          if (!(await assertCompany(trx, request.params.companyId, tenantId))) {
            return { kind: 'company_not_found' as const };
          }
          if (!(await assertCompanyCnae(trx, request.params.companyId, request.body.cnaeCode))) {
            return { kind: 'cnae_not_linked' as const };
          }
          const codes = [...new Set(request.body.ncmCodes)];
          const entries = await resolveNcmEntries(trx, codes);
          const resolved = new Set(entries.map((entry) => entry.code));
          const invalidCodes = codes.filter((code) => !resolved.has(code));
          if (invalidCodes.length > 0) return { kind: 'invalid_ncm_codes' as const, invalidCodes };
          for (const entry of entries) {
            await sql`
              INSERT INTO company_cnae_ncms (company_id, cnae_code, official_catalog_entry_id)
              VALUES (${request.params.companyId}::uuid, ${request.body.cnaeCode}, ${entry.id}::uuid)
              ON CONFLICT ON CONSTRAINT uq_company_cnae_ncm DO NOTHING
            `.execute(trx);
          }
          return { kind: 'ok' as const, rows: await readCnaeNcms(trx, request.params.companyId) };
        });
        if (outcome.kind === 'company_not_found') return reply.status(404).send({ error: outcome.kind });
        if (outcome.kind === 'cnae_not_linked') return reply.status(400).send({ error: outcome.kind });
        if (outcome.kind === 'invalid_ncm_codes') {
          return reply.status(400).send({ error: outcome.kind, invalidCodes: outcome.invalidCodes });
        }
        return reply.status(201).send({ items: outcome.rows.map(cnaeNcmResponse) });
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.delete(
    '/api/v1/companies/:companyId/cnae-ncms/:ncmId',
    {
      preHandler: app.authenticate,
      schema: { params: cnaeNcmParamsSchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) return reply.status(400).send({ error: 'tenant_required' });
      try {
        const outcome = await withTenantContext(app.db, request.auth.userId, tenantId, async (trx) => {
          if (!(await assertCompany(trx, request.params.companyId, tenantId))) return 'company_not_found' as const;
          const result = await sql`
            DELETE FROM company_cnae_ncms
            WHERE id = ${request.params.ncmId}::uuid
              AND company_id = ${request.params.companyId}::uuid
          `.execute(trx);
          return (result.numAffectedRows ?? 0n) > 0n ? ('ok' as const) : ('ncm_not_found' as const);
        });
        if (outcome !== 'ok') return reply.status(404).send({ error: outcome });
        return reply.status(204).send();
      } catch (error) {
        const handled = handleTenantError(error, reply);
        if (handled) return handled;
        throw error;
      }
    },
  );

  typed.get(
    '/api/v1/publications/:publicationId/ncms',
    {
      preHandler: app.authenticate,
      schema: { params: publicationParamsSchema },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const result = await sql<PublicationNcmRow>`
        SELECT DISTINCT ON (pnm.ncm_code)
          pnm.ncm_code,
          e.description,
          pnm.verification_status,
          pnm.method_type,
          pnm.detector_key,
          pnm.detector_version,
          pnm.confidence,
          pnm.excerpt
        FROM publication_versions pv
        INNER JOIN publication_ncm_mentions pnm
          ON pnm.publication_version_id = pv.id
        LEFT JOIN official_catalog_entries e
          ON e.id = pnm.official_catalog_entry_id
        WHERE pv.publication_id = ${request.params.publicationId}::uuid
          AND pv.is_current = TRUE
          AND pnm.verification_status <> 'REJECTED'
        ORDER BY
          pnm.ncm_code,
          (pnm.verification_status = 'CATALOG_MATCHED') DESC,
          pnm.confidence DESC NULLS LAST,
          pnm.created_at DESC
      `.execute(app.db);
      return reply.status(200).send({
        items: result.rows.map((row) => ({
          code: row.ncm_code,
          description: row.description,
          verificationStatus: row.verification_status,
          method: {
            type: row.method_type,
            detectorKey: row.detector_key,
            detectorVersion: row.detector_version,
          },
          confidence: row.confidence === null ? null : Number(row.confidence),
          excerpt: row.excerpt,
        })),
      });
    },
  );
}
