import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';

export const MIB = 1024 * 1024;
export interface DouDownloadLimits {
  pdfMiB: number;
  zipMiB: number;
  expandedZipMiB: number;
  xmlEntryMiB: number;
}
export const DOU_DEFAULT_LIMITS: Readonly<DouDownloadLimits> = Object.freeze({
  pdfMiB: 20,
  zipMiB: 64,
  expandedZipMiB: 128,
  xmlEntryMiB: 8,
});

export const douLimitsSchema = z.object({
  pdfMiB: z.number().int().min(1).max(20),
  zipMiB: z.number().int().min(1).max(64),
  expandedZipMiB: z.number().int().min(1).max(128),
  xmlEntryMiB: z.number().int().min(1).max(8),
}).strict().refine(v => v.expandedZipMiB >= v.zipMiB, {
  message: 'expanded ZIP must be >= compressed ZIP',
});

function limitsFromSource(config: unknown): { limits: DouDownloadLimits; configured: boolean } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('DOU_INVALID_SOURCE_CONNECTOR_CONFIG');
  }
  const field = (config as Record<string, unknown>).douDownloadLimits;
  if (field === undefined) return { limits: { ...DOU_DEFAULT_LIMITS }, configured: false };
  const parsed = douLimitsSchema.safeParse(field);
  if (!parsed.success) throw new Error('DOU_INVALID_PERSISTED_DOWNLOAD_LIMITS');
  return { limits: parsed.data, configured: true };
}

export async function readWorkerDouLimits(db: Kysely<DB>, sourceId: string): Promise<DouDownloadLimits> {
  const row = await db.selectFrom('sources').select('connector_config')
    .where('id', '=', sourceId).where('connector_key', '=', 'dou').executeTakeFirst();
  if (!row) throw new Error('DOU_SOURCE_NOT_FOUND');
  return limitsFromSource(row.connector_config).limits;
}

export async function readAdminDouLimits(db: Kysely<DB>): Promise<{
  limits: DouDownloadLimits; configured: boolean; editable: boolean;
  updatedAt: Date | null; limitsNotice: string;
}> {
  const row = await db.selectFrom('sources')
    .select(['connector_config', 'updated_at'])
    .where('code', '=', 'dou').where('connector_key', '=', 'dou').executeTakeFirst();
  const result = row ? limitsFromSource(row.connector_config)
    : { limits: { ...DOU_DEFAULT_LIMITS }, configured: false };
  const functionStatus = await sql<{ ready: boolean }>`
    SELECT COALESCE(
      pg_catalog.has_function_privilege(
        current_user,
        pg_catalog.to_regprocedure('public.platform_admin_set_dou_limits(jsonb)'),
        'EXECUTE'
      ),
      false
    ) AS ready
  `.execute(db);
  const editable = Boolean(row && functionStatus.rows[0]?.ready);
  return {
    ...result,
    editable,
    updatedAt: result.configured ? row?.updated_at ?? null : null,
    limitsNotice: !row
      ? 'A fonte DOU não foi cadastrada. Nenhuma alteração poderá ser salva.'
      : !editable
        ? 'Prévia dos limites. A gravação depende de SQL autorizado; nenhuma alteração de produção está ativa.'
        : 'Limites globais; alterações afetam novas execuções. Atestação PDF continua bloqueada pelos gates TAX13.',
  };
}

/** Deliberately fail-closed until the independently authorized DB function exists. */
export async function saveAdminDouLimits(
  db: Kysely<DB>, userId: string, incoming: unknown,
) {
  const limits = douLimitsSchema.parse(incoming);
  await withUserContext(db, userId, async trx => {
    await sql`
      SELECT public.platform_admin_set_dou_limits(${JSON.stringify(limits)}::jsonb)
    `.execute(trx);
  });
  return readAdminDouLimits(db);
}
