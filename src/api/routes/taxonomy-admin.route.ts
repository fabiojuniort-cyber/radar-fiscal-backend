import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import {
  CCLASSTRIB_CATALOG,
  parseCclasstribCsv,
  parseCsv,
} from '../../modules/taxonomy/catalogs/cclasstrib-catalog.source.js';
import {
  CNAE_CATALOG,
  CNAE_SOURCE_URL,
  downloadCnaeCatalog,
} from '../../modules/taxonomy/catalogs/cnae-catalog.source.js';
import {
  diffAgainstCurrentEdition,
  importOfficialCatalog,
  type CatalogEntryInput,
} from '../../modules/taxonomy/catalogs/official-catalog.importer.js';
import {
  CURATED_ENGINE_KEY,
  CURATED_ENGINE_VERSION,
} from '../../modules/taxonomy/classification/classification.curated.js';
import { resetClassificationConceptCache } from '../../modules/taxonomy/classification/classification.worker.js';
import {
  formatOfficialCode,
  OFFICIAL_CODE_TYPES,
} from '../../modules/taxonomy/curation/curation.constants.js';
import {
  ALIAS_TYPES,
  CurationError,
  createConcept,
  createDraft,
  createGroup,
  deleteGroup,
  diffReleaseViews,
  importDimensionRows,
  saveDimensionRows,
  publishDraft,
  assertCuratorSession,
  setRuntimeSetting,
  updateConcept,
  updateDimension,
  updateGroup,
  validateReleaseView,
  withCuratorTransaction,
  type CuratorActor,
  type ImportRow,
} from '../../modules/taxonomy/curation/curation.draft.js';
import {
  findLatestPublishedRelease,
  findOpenDraft,
  kyselyRunner,
  loadReleaseView,
  loadRuntimeSettings,
  pgRunner,
} from '../../modules/taxonomy/curation/curation.read.js';
import { loadPublicationTaxonomy } from '../../modules/taxonomy/curation/curation.tags.js';
import { PROTECTED_EXCLUDED_SOURCES } from '../../modules/taxonomy/curation/curation.constants.js';
import { importNcmCatalog } from '../../modules/taxonomy/ncm/ncm-catalog.importer.js';
import {
  NCM_SOURCE_URL,
  parseNcmCatalogPayload,
} from '../../modules/taxonomy/ncm/ncm-catalog.source.js';
import { createHash } from 'node:crypto';

const justification = z.string().trim().min(3).max(1000);

const dimensionParams = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const conceptParams = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
});
const groupParams = z.object({ groupId: z.string().uuid() });
const releaseParams = z.object({ releaseId: z.string().uuid() });
const publicationParams = z.object({ publicationId: z.string().uuid() });
const catalogParams = z.object({ catalog: z.enum(['NCM', 'CNAE', 'CCLASSTRIB']) });

const nullableText = z.string().max(4000).nullable().optional();
const codes = z.array(z.string().trim().min(1).max(30)).max(200);

const dimensionBody = z.object({
  justification,
  name: z.string().trim().min(1).max(120).optional(),
  description: nullableText,
  profileVisible: z.boolean().optional(),
  profileOrder: z.number().int().min(0).max(1000).optional(),
  helpText: nullableText,
  detailSection: z.string().max(80).nullable().optional(),
  detailOrder: z.number().int().min(0).max(1000).optional(),
  usesGroups: z.boolean().optional(),
  officialCodeType: z.enum(OFFICIAL_CODE_TYPES).nullable().optional(),
});

const groupBody = z.object({
  justification,
  label: z.string().trim().min(1).max(160).optional(),
  code: z.string().regex(/^[a-z0-9][a-z0-9_]*$/).max(60).optional(),
  displayOrder: z.number().int().min(0).max(10000).optional(),
  helpText: nullableText,
  detailSection: z.string().max(80).nullable().optional(),
  officialCodes: codes.optional(),
  segmentCodes: z.array(z.string().regex(/^sector\.[a-z0-9_]+$/)).max(100).optional(),
});

const conceptBody = z.object({
  justification,
  code: z.string().max(120).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  definition: z.string().trim().min(1).max(4000).optional(),
  positiveExample: nullableText,
  negativeExample: nullableText,
  governanceStatus: z.enum(['PROPOSED', 'UNDER_REVIEW', 'APPROVED', 'DEPRECATED', 'REJECTED']).optional(),
  evidenceStatus: z.enum(['DOCUMENTED', 'NEEDS_EVIDENCE', 'NOT_ASSESSED']).optional(),
  notes: nullableText,
  groupId: z.string().uuid().nullable().optional(),
  profileVisible: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(10000).nullable().optional(),
  helpText: nullableText,
  classifyByLabel: z.boolean().optional(),
  officialCodes: codes.optional(),
  aliases: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(200),
        aliasType: z.enum(ALIAS_TYPES),
      }),
    )
    .max(100)
    .optional(),
  membershipStatus: z.enum(['INCLUDED', 'RETIRED']).optional(),
});

const justificationBody = z.object({ justification });

class NotCuratorError extends Error {}

async function isTaxonomyCurator(
  app: FastifyInstance,
  userId: string,
): Promise<boolean> {
  return withUserContext(app.db, userId, async (trx) => {
    const result = await sql<{ ok: number }>`
      SELECT 1 AS ok
      FROM platform_user_roles r
      JOIN app_users u ON u.id = r.user_id
      WHERE r.user_id = ${userId}::uuid
        AND r.role = 'TAXONOMY_CURATOR'
        AND r.revoked_at IS NULL
        AND u.status = 'ACTIVE'
      LIMIT 1
    `.execute(trx);
    return result.rows.length > 0;
  });
}

function actorFrom(request: FastifyRequest, text: string): CuratorActor {
  return { userId: request.auth!.userId, justification: text };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CurationError) {
    return reply.status(error.status).send({
      error: error.code.toLowerCase(),
      message: error.message !== error.code ? error.message : undefined,
    });
  }
  throw error;
}

export function parseImportCsv(text: string): ImportRow[] {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => /^item$/i.test(cell.trim())),
  );
  if (headerIndex < 0) {
    throw new CurationError('IMPORT_HEADER_NOT_FOUND', 400, 'A planilha precisa de uma coluna "Item".');
  }
  const headers = rows[headerIndex]!.map((cell) =>
    cell
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim(),
  );
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const groupCol = col('grupo');
  const itemCol = col('item', 'produto');
  const codesCol = col(
    'codigo oficial',
    'ncm',
    'cnae',
    'cfop',
    'nbs',
    'modelo',
    'cclasstrib',
    'item lc 116',
    'codigo',
  );
  const synonymsCol = col('sinonimos', 'sinonimo');
  const profileCol = col('no perfil', 'perfil');
  const orderCol = col('ordem');
  const classifyCol = col('classificar pelo nome', 'classificar');
  const definitionCol = col('definicao');
  const tribuscaCol = col('codigo tribusca');

  const CLEAR = /^(—|-|–)$/;
  // undefined = keep current value (column absent or blank cell);
  // [] / null = clear (cell with "—" or "-").
  const listCell = (index: number, row: string[]): string[] | undefined => {
    if (index < 0) return undefined;
    const raw = (row[index] ?? '').trim();
    if (!raw || /^a definir$/i.test(raw)) return undefined;
    if (CLEAR.test(raw)) return [];
    return raw
      .split(/[,;|\n]/)
      .map((part) => part.trim())
      .filter((part) => part && !CLEAR.test(part));
  };

  const truthy = (value: string | undefined): boolean | null => {
    const normalized = (value ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (['✓', 'x', 'sim', 's', 'true', '1', 'yes'].includes(normalized)) return true;
    if (['nao', 'não', 'n', 'false', '0', 'no'].includes(normalized)) return false;
    return null;
  };

  return rows.slice(headerIndex + 1).flatMap((row, offset) => {
    const item = (row[itemCol] ?? '').trim();
    if (!item) return [];
    const order = orderCol >= 0 ? Number.parseInt(row[orderCol] ?? '', 10) : Number.NaN;
    const groupRaw = groupCol >= 0 ? (row[groupCol] ?? '').trim() : '';
    return [
      {
        line: headerIndex + offset + 2,
        group: !groupRaw ? undefined : CLEAR.test(groupRaw) ? null : groupRaw,
        item,
        officialCodes: listCell(codesCol, row),
        synonyms: listCell(synonymsCol, row),
        profileVisible: profileCol >= 0 ? truthy(row[profileCol]) : null,
        classifyByLabel: classifyCol >= 0 ? truthy(row[classifyCol]) : null,
        definition: definitionCol >= 0 ? (row[definitionCol] ?? '').trim() || undefined : undefined,
        displayOrder: Number.isFinite(order) ? order : null,
        code: tribuscaCol >= 0 ? (row[tribuscaCol] ?? '').trim() || null : null,
      },
    ];
  });
}

function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value);
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function classificationProgress(
  app: FastifyInstance,
  releaseId: string | null,
  excluded: readonly string[],
): Promise<Record<string, number> | null> {
  if (!releaseId) return null;
  const result = await sql<{
    total: number;
    classified: number;
    without_tags: number;
    failed: number;
    excluded: number;
  }>`
    WITH current_versions AS (
      SELECT
        pv.id,
        EXISTS (
          SELECT 1
          FROM publication_origins po
          JOIN sources s ON s.id = po.source_id
          WHERE po.publication_id = pv.publication_id
            AND s.code = ANY(${[...excluded]}::text[])
        ) AS is_excluded
      FROM publication_versions pv
      WHERE pv.is_current = true
    )
    SELECT
      count(*) FILTER (WHERE NOT cv.is_excluded)::int AS total,
      count(*) FILTER (WHERE NOT cv.is_excluded AND s.status = 'SUCCESS')::int AS classified,
      count(*) FILTER (
        WHERE NOT cv.is_excluded AND s.status = 'SUCCESS' AND s.assertion_count = 0
      )::int AS without_tags,
      count(*) FILTER (WHERE NOT cv.is_excluded AND s.status = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE cv.is_excluded)::int AS excluded
    FROM current_versions cv
    LEFT JOIN publication_taxonomy_scans s
      ON s.publication_version_id = cv.id
     AND s.taxonomy_release_id = ${releaseId}::uuid
     AND s.engine_key = ${CURATED_ENGINE_KEY}
     AND s.engine_version = ${CURATED_ENGINE_VERSION}
  `.execute(app.db);
  const row = result.rows[0];
  if (!row) return null;
  return {
    total: row.total,
    classified: row.classified,
    pending: Math.max(0, row.total - row.classified - row.failed),
    withoutTags: row.without_tags,
    failed: row.failed,
    excluded: row.excluded,
  };
}

async function catalogStatus(app: FastifyInstance) {
  const result = await sql<{
    code: string;
    name: string;
    edition_code: string | null;
    valid_from: string | null;
    created_at: Date | null;
    entries: number | null;
  }>`
    SELECT
      oc.code, oc.name, ed.edition_code,
      to_char(ed.valid_from, 'YYYY-MM-DD') AS valid_from,
      ed.created_at,
      (SELECT count(*)::int FROM official_catalog_entries e
        WHERE e.catalog_edition_id = ed.id) AS entries
    FROM official_catalogs oc
    LEFT JOIN LATERAL (
      SELECT * FROM official_catalog_editions x
      WHERE x.catalog_id = oc.id AND x.status = 'CURRENT'
      ORDER BY x.created_at DESC LIMIT 1
    ) ed ON true
    WHERE oc.code IN ('NCM', 'CNAE', 'CCLASSTRIB')
  `.execute(app.db);

  const byCode = new Map(result.rows.map((row) => [row.code, row]));
  return (['NCM', 'CNAE', 'CCLASSTRIB'] as const).map((code) => {
    const row = byCode.get(code);
    return {
      code,
      name: row?.name ?? null,
      loaded: Boolean(row?.edition_code),
      editionCode: row?.edition_code ?? null,
      validFrom: row?.valid_from ?? null,
      loadedAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      entries: row?.entries ?? 0,
      source:
        code === 'NCM'
          ? 'AUTOMATIC'
          : code === 'CNAE'
            ? 'AUTOMATIC'
            : 'UPLOAD',
    };
  });
}

async function downloadNcm(): Promise<{
  sourceSha256: string;
  parsed: ReturnType<typeof parseNcmCatalogPayload>;
  entries: CatalogEntryInput[];
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(NCM_SOURCE_URL, {
      headers: { accept: 'application/json', 'user-agent': 'TriBusca-Radar-Fiscal/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NCM_SOURCE_HTTP_${response.status}`);
    const raw = await response.text();
    if (raw.length > 32 * 1024 * 1024) throw new Error('NCM_SOURCE_TOO_LARGE');
    const parsed = parseNcmCatalogPayload(JSON.parse(raw) as unknown);
    return {
      sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      parsed,
      entries: parsed.entries.map((entry) => ({
        officialCode: entry.officialCode,
        description: entry.description,
        parentCode: null,
        metadata: {},
      })),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function taxonomyAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const requireCurator = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.auth || !(await isTaxonomyCurator(app, request.auth.userId))) {
      await reply.status(403).send({ error: 'taxonomy_curator_required' });
    }
  };

  const curatorPool = (): Pool => {
    if (!app.curatorPool) throw new NotCuratorError('curator_database_unavailable');
    return app.curatorPool;
  };

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof NotCuratorError) {
      return reply.status(503).send({ error: 'curator_database_unavailable' });
    }
    if (error instanceof CurationError) return sendError(reply, error);
    throw error;
  });

  typed.get(
    '/api/v1/admin/me',
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      return reply.send({
        taxonomyCurator: await isTaxonomyCurator(app, request.auth.userId),
        curatorDatabase: app.curatorPool !== null,
      });
    },
  );

  typed.get(
    '/api/v1/admin/taxonomy/state',
    { preHandler: requireCurator },
    async (_request, reply) => {
      const run = kyselyRunner(app.db);
      const [published, draft, settings, catalogs] = await Promise.all([
        findLatestPublishedRelease(run),
        findOpenDraft(run),
        loadRuntimeSettings(run),
        catalogStatus(app),
      ]);
      return reply.send({
        published,
        draft,
        settings,
        engine: { key: CURATED_ENGINE_KEY, version: CURATED_ENGINE_VERSION },
        progress: await classificationProgress(
          app,
          published?.id ?? null,
          [...new Set([...settings.classificationExcludedSources, ...PROTECTED_EXCLUDED_SOURCES])],
        ),
        catalogs,
        curatorDatabase: app.curatorPool !== null,
      });
    },
  );

  typed.get(
    '/api/v1/admin/taxonomy/releases/:releaseId',
    { preHandler: requireCurator, schema: { params: releaseParams } },
    async (request, reply) => {
      const view = await loadReleaseView(kyselyRunner(app.db), request.params.releaseId, {
        includeRetired: true,
      });
      if (!view) return reply.status(404).send({ error: 'release_not_found' });
      return reply.send(view);
    },
  );

  typed.get(
    '/api/v1/admin/taxonomy/drafts/current/review',
    { preHandler: requireCurator },
    async (_request, reply) => {
      const pool = curatorPool();
      const client = await pool.connect();
      try {
        await assertCuratorSession(client);
        await client.query('BEGIN READ ONLY');
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const run = pgRunner(client);
        const draft = await findOpenDraft(run);
        if (!draft) return reply.status(404).send({ error: 'no_open_draft' });
        const view = await loadReleaseView(run, draft.id, { includeRetired: true });
        const source = draft.previousReleaseId
          ? await loadReleaseView(run, draft.previousReleaseId)
          : null;
        const issues = await validateReleaseView(client, view!);
        return reply.send({
          draft,
          diff: diffReleaseViews(source, view!),
          issues,
        });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts',
    { preHandler: requireCurator, schema: { body: justificationBody } },
    async (request, reply) => {
      const result = await withCuratorTransaction(curatorPool(), (client) =>
        createDraft(client, actorFrom(request, request.body.justification)),
      );
      return reply.status(201).send(result);
    },
  );

  typed.patch(
    '/api/v1/admin/taxonomy/drafts/current/dimensions/:code',
    { preHandler: requireCurator, schema: { params: dimensionParams, body: dimensionBody } },
    async (request, reply) => {
      const { justification: text, ...patch } = request.body;
      await withCuratorTransaction(curatorPool(), (client) =>
        updateDimension(client, actorFrom(request, text), request.params.code, patch),
      );
      return reply.status(204).send();
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/dimensions/:code/groups',
    { preHandler: requireCurator, schema: { params: dimensionParams, body: groupBody } },
    async (request, reply) => {
      const { justification: text, ...input } = request.body;
      const id = await withCuratorTransaction(curatorPool(), (client) =>
        createGroup(client, actorFrom(request, text), request.params.code, input),
      );
      return reply.status(201).send({ id });
    },
  );

  typed.patch(
    '/api/v1/admin/taxonomy/drafts/current/groups/:groupId',
    { preHandler: requireCurator, schema: { params: groupParams, body: groupBody } },
    async (request, reply) => {
      const { justification: text, ...input } = request.body;
      await withCuratorTransaction(curatorPool(), (client) =>
        updateGroup(client, actorFrom(request, text), request.params.groupId, input),
      );
      return reply.status(204).send();
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/groups/:groupId/delete',
    { preHandler: requireCurator, schema: { params: groupParams, body: justificationBody } },
    async (request, reply) => {
      await withCuratorTransaction(curatorPool(), (client) =>
        deleteGroup(client, actorFrom(request, request.body.justification), request.params.groupId),
      );
      return reply.status(204).send();
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/dimensions/:code/concepts',
    { preHandler: requireCurator, schema: { params: dimensionParams, body: conceptBody } },
    async (request, reply) => {
      const { justification: text, ...input } = request.body;
      const code = await withCuratorTransaction(curatorPool(), (client) =>
        createConcept(client, actorFrom(request, text), request.params.code, input),
      );
      return reply.status(201).send({ code });
    },
  );

  typed.patch(
    '/api/v1/admin/taxonomy/drafts/current/concepts/:code',
    { preHandler: requireCurator, schema: { params: conceptParams, body: conceptBody } },
    async (request, reply) => {
      const { justification: text, code: _code, ...input } = request.body;
      await withCuratorTransaction(curatorPool(), (client) =>
        updateConcept(client, actorFrom(request, text), request.params.code, input),
      );
      return reply.status(204).send();
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/dimensions/:code/import',
    {
      preHandler: requireCurator,
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        params: dimensionParams,
        body: z.object({ justification, csv: z.string().min(1).max(5 * 1024 * 1024) }),
      },
    },
    async (request, reply) => {
      const rows = parseImportCsv(request.body.csv);
      const report = await withCuratorTransaction(curatorPool(), (client) =>
        importDimensionRows(
          client,
          actorFrom(request, request.body.justification),
          request.params.code,
          rows,
        ),
      );
      return reply.send({ rows: rows.length, ...report });
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/dimensions/:code/rows',
    {
      preHandler: requireCurator,
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        params: dimensionParams,
        body: z.object({
          justification,
          rows: z
            .array(
              z.object({
                code: z.string().trim().min(1).max(200).nullable(),
                group: z.string().trim().max(200).nullable().optional(),
                label: z.string().max(300),
                officialCodes: z.array(z.string().trim().min(1).max(40)).max(500),
                aliases: z
                  .array(
                    z.object({
                      text: z.string().trim().min(1).max(300),
                      aliasType: z.enum(ALIAS_TYPES),
                    }),
                  )
                  .max(200),
                profileVisible: z.boolean(),
                classifyByLabel: z.boolean(),
                displayOrder: z.number().int().min(0).max(100000).nullable(),
              }),
            )
            .max(5000),
          retire: z.array(z.string().trim().min(1).max(200)).max(5000).default([]),
          groupSegments: z
            .array(
              z.object({
                group: z.string().trim().min(1).max(200),
                segmentCodes: z.array(z.string().regex(/^sector\.[a-z0-9_]+$/)).max(100),
              }),
            )
            .max(2000)
            .default([]),
        }),
      },
    },
    async (request, reply) => {
      const result = await withCuratorTransaction(curatorPool(), (client) =>
        saveDimensionRows(client, actorFrom(request, request.body.justification), request.params.code, {
          rows: request.body.rows,
          retire: request.body.retire,
          groupSegments: request.body.groupSegments,
        }),
      );
      return reply.send(result);
    },
  );

  typed.get(
    '/api/v1/admin/taxonomy/releases/:releaseId/dimensions/:code/export.csv',
    {
      preHandler: requireCurator,
      schema: { params: releaseParams.merge(dimensionParams) },
    },
    async (request, reply) => {
      const view = await loadReleaseView(kyselyRunner(app.db), request.params.releaseId);
      if (!view) return reply.status(404).send({ error: 'release_not_found' });
      const dimension = view.dimensions.find((d) => d.code === request.params.code);
      if (!dimension) return reply.status(404).send({ error: 'dimension_not_found' });

      const groupLabel = new Map(view.groups.map((g) => [g.id, g.label]));
      const header = [
        'Grupo',
        'Item',
        'Código oficial',
        'Sinônimos',
        'No perfil',
        'Ordem',
        'Classificar pelo nome',
        'Definição',
        'Código TriBusca',
      ];
      const lines = view.concepts
        .filter((concept) => concept.dimensionCode === dimension.code)
        .sort(
          (left, right) =>
            (groupLabel.get(left.groupId ?? '') ?? '~').localeCompare(
              groupLabel.get(right.groupId ?? '') ?? '~',
              'pt-BR',
            ) ||
            (left.displayOrder ?? 9999) - (right.displayOrder ?? 9999) ||
            left.label.localeCompare(right.label, 'pt-BR'),
        )
        .map((concept) =>
          [
            groupLabel.get(concept.groupId ?? '') ?? '',
            concept.label,
            concept.officialCodes
              .map((code) => formatOfficialCode(dimension.officialCodeType, code))
              .join(', '),
            concept.aliases.map((alias) => alias.text).join(', '),
            concept.profileVisible ? 'x' : '',
            concept.displayOrder,
            concept.classifyByLabel ? 'x' : '',
            concept.definition,
            concept.code,
          ]
            .map(csvCell)
            .join(';'),
        );
      const body = '﻿' + [header.join(';'), ...lines].join('\r\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="taxonomia-${view.release.version}-${dimension.code}.csv"`,
        )
        .send(body);
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/drafts/current/publish',
    {
      preHandler: requireCurator,
      schema: {
        body: z.object({ justification, changeNotes: z.string().trim().min(3).max(4000) }),
      },
    },
    async (request, reply) => {
      const result = await withCuratorTransaction(curatorPool(), (client) =>
        publishDraft(client, actorFrom(request, request.body.justification), {
          changeNotes: request.body.changeNotes,
          gitSha: env.RAILWAY_GIT_COMMIT_SHA ?? null,
        }),
      );
      resetClassificationConceptCache();
      return reply.send(result);
    },
  );

  typed.put(
    '/api/v1/admin/taxonomy/settings/classification',
    {
      preHandler: requireCurator,
      schema: { body: z.object({ justification, enabled: z.boolean() }) },
    },
    async (request, reply) => {
      await withCuratorTransaction(curatorPool(), (client) =>
        setRuntimeSetting(
          client,
          actorFrom(request, request.body.justification),
          'classification_enabled',
          request.body.enabled,
        ),
      );
      return reply.status(204).send();
    },
  );

  typed.put(
    '/api/v1/admin/taxonomy/settings/excluded-sources',
    {
      preHandler: requireCurator,
      schema: {
        body: z.object({
          justification,
          sources: z.array(z.string().regex(/^[a-z0-9][a-z0-9-_]*$/)).max(50),
        }),
      },
    },
    async (request, reply) => {
      const missing = PROTECTED_EXCLUDED_SOURCES.filter(
        (source) => !request.body.sources.includes(source),
      );
      if (missing.length > 0) {
        return reply.status(409).send({
          error: 'protected_excluded_source',
          message: `A fonte ${missing.join(', ')} só pode voltar à classificação após o fechamento formal da reconstrução DOE-SP (operação própria).`,
        });
      }
      await withCuratorTransaction(curatorPool(), (client) =>
        setRuntimeSetting(
          client,
          actorFrom(request, request.body.justification),
          'classification_excluded_sources',
          [...new Set(request.body.sources)],
        ),
      );
      return reply.status(204).send();
    },
  );

  // ---- Official catalogs -------------------------------------------------

  typed.get(
    '/api/v1/admin/taxonomy/catalogs/search',
    {
      preHandler: requireCurator,
      schema: {
        querystring: z.object({
          catalog: z.enum(['NCM', 'CNAE', 'CCLASSTRIB']),
          q: z.string().trim().min(2).max(120),
        }),
      },
    },
    async (request, reply) => {
      const digits = request.query.q.replace(/\D/g, '');
      const pattern = `%${request.query.q.replace(/[%_]/g, '')}%`;
      const result = await sql<{ official_code: string; description: string }>`
        SELECT e.official_code, e.description
        FROM official_catalog_entries e
        JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
        JOIN official_catalogs oc ON oc.id = ed.catalog_id
        WHERE oc.code = ${request.query.catalog}
          AND ed.status = 'CURRENT'
          AND (
            (${digits} <> '' AND regexp_replace(e.official_code, '[^0-9]', '', 'g') LIKE ${digits} || '%')
            OR e.description ILIKE ${pattern}
          )
        ORDER BY length(e.official_code), e.official_code
        LIMIT 30
      `.execute(app.db);
      return reply.send({
        items: result.rows.map((row) => ({
          code: row.official_code,
          normalized: row.official_code.replace(/[^0-9A-Za-z]/g, ''),
          description: row.description,
        })),
      });
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/catalogs/:catalog/check',
    {
      preHandler: requireCurator,
      bodyLimit: 10 * 1024 * 1024,
      schema: {
        params: catalogParams,
        body: z.object({ csv: z.string().max(10 * 1024 * 1024).optional() }),
      },
    },
    async (request, reply) => {
      const catalog = request.params.catalog;
      let sourceSha256: string;
      let entries: CatalogEntryInput[];
      if (catalog === 'NCM') {
        ({ sourceSha256, entries } = await downloadNcm());
      } else if (catalog === 'CNAE') {
        ({ sourceSha256, entries } = await downloadCnaeCatalog());
      } else {
        if (!request.body.csv) return reply.status(400).send({ error: 'csv_required' });
        ({ sourceSha256, entries } = parseCclasstribCsv(request.body.csv));
      }
      const pool = curatorPool();
      const client = await pool.connect();
      try {
        await assertCuratorSession(client);
        await client.query('BEGIN READ ONLY');
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const diff = await diffAgainstCurrentEdition(client, catalog, sourceSha256, entries);
        return reply.send({ catalog, sourceSha256, entries: entries.length, diff });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/catalogs/:catalog/import',
    {
      preHandler: requireCurator,
      bodyLimit: 10 * 1024 * 1024,
      schema: {
        params: catalogParams,
        body: z.object({
          justification,
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
          csv: z.string().max(10 * 1024 * 1024).optional(),
          validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (request, reply) => {
      const catalog = request.params.catalog;
      const actor = actorFrom(request, request.body.justification);
      const today = new Date().toISOString().slice(0, 10);

      if (catalog === 'NCM') {
        const downloaded = await downloadNcm();
        if (downloaded.sourceSha256 !== request.body.expectedSha256) {
          return reply.status(409).send({ error: 'source_changed_since_check' });
        }
        // importNcmCatalog owns its transaction; release that connection
        // before opening the audit transaction (pool max is small).
        const client = await curatorPool().connect();
        let result: Awaited<ReturnType<typeof importNcmCatalog>>;
        try {
          await assertCuratorSession(client);
          result = await importNcmCatalog(client, {
            sourceUrl: NCM_SOURCE_URL,
            sourceSha256: downloaded.sourceSha256,
            parsed: downloaded.parsed,
          });
        } finally {
          client.release();
        }
        await withCuratorTransaction(curatorPool(), async (tx) => {
          await tx.query(
            `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
             VALUES (NULL, 'ADMIN', $1, 'OFFICIAL_CATALOG_IMPORTED', 'official_catalog_edition', $2::uuid, $3::jsonb, gen_random_uuid())`,
            [actor.userId, result.editionId, JSON.stringify({ catalog, ...result, justification: actor.justification })],
          );
        });
        return reply.send({ catalog, ...result });
      }

      let sourceSha256: string;
      let entries: CatalogEntryInput[];
      let sourceUrl: string | null;
      if (catalog === 'CNAE') {
        ({ sourceSha256, entries } = await downloadCnaeCatalog());
        sourceUrl = CNAE_SOURCE_URL;
      } else {
        if (!request.body.csv) return reply.status(400).send({ error: 'csv_required' });
        ({ sourceSha256, entries } = parseCclasstribCsv(request.body.csv));
        sourceUrl = null;
      }
      if (sourceSha256 !== request.body.expectedSha256) {
        return reply.status(409).send({ error: 'source_changed_since_check' });
      }

      const result = await withCuratorTransaction(curatorPool(), async (client) => {
        const imported = await importOfficialCatalog(client, {
          catalog: catalog === 'CNAE' ? CNAE_CATALOG : CCLASSTRIB_CATALOG,
          sourceUrl,
          sourceSha256,
          validFrom: request.body.validFrom ?? today,
          entries,
        });
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
           VALUES (NULL, 'ADMIN', $1, 'OFFICIAL_CATALOG_IMPORTED', 'official_catalog_edition', $2::uuid, $3::jsonb, gen_random_uuid())`,
          [actor.userId, imported.editionId, JSON.stringify({ catalog, ...imported, justification: actor.justification })],
        );
        return imported;
      });
      return reply.send({ catalog, ...result });
    },
  );

  // ---- Publication tags (curator corrections) ---------------------------

  typed.get(
    '/api/v1/admin/taxonomy/publications/:publicationId/tags',
    { preHandler: requireCurator, schema: { params: publicationParams } },
    async (request, reply) => {
      const view = await loadPublicationTaxonomy(
        kyselyRunner(app.db),
        request.params.publicationId,
        { includeRemoved: true },
      );
      return reply.send(view);
    },
  );

  typed.post(
    '/api/v1/admin/taxonomy/publications/:publicationId/tags',
    {
      preHandler: requireCurator,
      schema: {
        params: publicationParams,
        body: z.object({
          justification,
          conceptCode: conceptParams.shape.code,
          action: z.enum(['ADD', 'REMOVE', 'RESTORE']),
        }),
      },
    },
    async (request, reply) => {
      const view = await loadPublicationTaxonomy(
        kyselyRunner(app.db),
        request.params.publicationId,
        { includeRemoved: true },
      );
      if (!view.publicationVersionId || !view.release) {
        return reply.status(404).send({ error: 'publication_not_classifiable' });
      }
      if (view.status === 'EXCLUDED') {
        return reply.status(409).send({ error: 'publication_source_excluded' });
      }

      const actor = actorFrom(request, request.body.justification);
      const existing = view.sections
        .flatMap((section) => section.tags)
        .find((tag) => tag.conceptCode === request.body.conceptCode);

      await withCuratorTransaction(curatorPool(), async (client) => {
        // The view above may predate a concurrent SUPPRESS. The narrow
        // definer locks canonical state without granting the curator SELECT.
        try {
          await client.query(
            'SELECT public.publication_scope_lock_curator_version($1::uuid)',
            [view.publicationVersionId],
          );
        } catch (error) {
          if (error instanceof Error && error.message === 'PUBLICATION_OUT_OF_SCOPE') {
            throw new CurationError('PUBLICATION_OUT_OF_SCOPE', 409);
          }
          throw error;
        }
        const concept = await client.query<{ id: string }>(
          `SELECT rc.id FROM taxonomy_release_concepts rc
           JOIN taxonomy_concepts c ON c.id = rc.concept_id
           WHERE rc.release_id = $1::uuid AND c.code = $2
             AND rc.membership_status = 'INCLUDED'`,
          [view.release!.id, request.body.conceptCode],
        );
        const releaseConceptId = concept.rows[0]?.id;
        if (!releaseConceptId) throw new CurationError('CONCEPT_NOT_FOUND', 404);

        const action = request.body.action;
        // The concept-level decision (ADD/REMOVE) is what survives new
        // releases; the assertion review keeps the audit trail of the
        // automatic tag that was judged.
        if (existing?.origin === 'AUTOMATIC' && existing.assertionId && action !== 'ADD') {
          await client.query(
            `INSERT INTO publication_taxonomy_reviews (
               assertion_id, decision, reviewer_actor_id, rationale
             ) VALUES ($1::uuid, $2, $3, $4)`,
            [
              existing.assertionId,
              action === 'REMOVE' ? 'REJECT' : 'CONFIRM',
              `curator:${actor.userId}`,
              actor.justification,
            ],
          );
        } else if (action === 'RESTORE') {
          throw new CurationError('NOTHING_TO_RESTORE', 409);
        }

        await client.query(
          `INSERT INTO publication_taxonomy_curator_tags (
             publication_version_id, taxonomy_release_id, release_concept_id,
             action, actor_id, rationale
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
          [
            view.publicationVersionId,
            view.release!.id,
            releaseConceptId,
            action === 'REMOVE' ? 'REMOVE' : 'ADD',
            `curator:${actor.userId}`,
            actor.justification,
          ],
        );

        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
           VALUES (NULL, 'ADMIN', $1, 'PUBLICATION_TAG_CURATED', 'publication', $2::uuid, $3::jsonb, gen_random_uuid())`,
          [
            actor.userId,
            request.params.publicationId,
            JSON.stringify({
              conceptCode: request.body.conceptCode,
              action,
              justification: actor.justification,
            }),
          ],
        );
      });

      return reply.send(
        await loadPublicationTaxonomy(kyselyRunner(app.db), request.params.publicationId, {
          includeRemoved: true,
        }),
      );
    },
  );
}
