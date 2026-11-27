import { sql, type Kysely } from 'kysely';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { z } from 'zod';
import type { DB } from '../../infrastructure/database/database.types.js';

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

export async function readAdminDouLimits(db: Kysely<DB>, gatewayConfigured = false): Promise<{
  limits: DouDownloadLimits; configured: boolean; editable: boolean;
  updatedAt: Date | null; limitsNotice: string;
}> {
  const row = await db.selectFrom('sources')
    .select(['connector_config', 'updated_at'])
    .where('code', '=', 'dou').where('connector_key', '=', 'dou').executeTakeFirst();
  const result = row ? limitsFromSource(row.connector_config)
    : { limits: { ...DOU_DEFAULT_LIMITS }, configured: false };
  // The general app role is forbidden to call the write gateway.
  // Only report capability after the isolated SQL role AND signing key exist.
  let editable=false;
  if (row && gatewayConfigured) {
    const present=await sql<{ registered: boolean }>`
      SELECT pg_catalog.to_regprocedure(
        'public.platform_dou_limits_ready()') IS NOT NULL AS registered
    `.execute(db);
    if (present.rows[0]?.registered) {
      const status=await sql<{ ready: boolean }>`
        SELECT public.platform_dou_limits_ready() AS ready
      `.execute(db);
      editable=Boolean(status.rows[0]?.ready);
    }
  }
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

/** Only the JWT-authenticated API constructs these signed operation claims.
 * A generic app SQL credential cannot call the privileged gateway.
 * Never log the payload MAC, shared secret, or isolated DB URL. */
export async function saveAdminDouLimits(
  pool: Pool, userId: string, incoming: unknown,
): Promise<DouDownloadLimits> {
  const limits=douLimitsSchema.parse(incoming);
  const secret=env.DOU_LIMITS_SIGNING_SECRET;
  if (!secret || !env.DATABASE_DOU_LIMITS_URL) throw new Error('dou_limits_store_not_ready');
  const issuedAt=Math.floor(Date.now()/1000);
  const nonce=randomUUID();
  const statement=[
    'OPS-DL-01/v1',userId,String(issuedAt),nonce,
    String(limits.pdfMiB),String(limits.zipMiB),
    String(limits.expandedZipMiB),String(limits.xmlEntryMiB),
  ].join('|');
  const signature=createHmac('sha256',Buffer.from(secret,'hex'))
    .update(statement,'utf8').digest('hex');
  const result=await pool.query<{ limits: DouDownloadLimits }>(
    'SELECT public.platform_admin_set_dou_limits($1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text) AS limits',
    [userId,JSON.stringify(limits),issuedAt,nonce,signature],
  );
  if (!result.rows[0]?.limits) throw new Error('DOU_LIMITS_WRITE_NOT_CONFIRMED');
  return douLimitsSchema.parse(result.rows[0].limits);
}
