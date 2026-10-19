import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { AcquiredCollectionRun } from '../../modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../../modules/collection/collection.engine.js';
import {
  CONFAZ_CONNECTOR_KEY,
  parseConfazPublicationHtml,
  type ConfazFamilyKey,
} from '../../modules/collection/confaz.connector.js';
import type { CollectionConnector } from '../../modules/collection/connector.contract.js';
import { ConnectorRegistry } from '../../modules/collection/connector.registry.js';
import { normalizePublication } from '../../modules/collection/publication.normalizer.js';
import type { DB } from './database.types.js';

/**
 * Imports ONE CONFAZ act from its official page saved by an operator, for
 * acts the incremental collection does not reach (older years) or when the
 * portal is unreachable from production.
 *
 *   node dist/infrastructure/database/import-confaz-act.js \
 *     --file=ops/confaz/acts/CV100_97.html \
 *     --url=https://www.confaz.fazenda.gov.br/legislacao/convenios/1997/CV100_97 \
 *     [--confirm] [--refresh-presentation]
 *
 * Without --confirm it only parses and checks (read-only). With --confirm it
 * runs the real collection engine once (MANUAL run owned by this process, one
 * attempt, never visible to the workers' queue), so persistence, versioning,
 * origins and audit follow exactly the normal CONFAZ path.
 *
 * --refresh-presentation (with --confirm): the display HTML and the validity
 * end date are not part of the version hash, so improving how a page is read
 * does not create a new version. This flag rewrites them on the act's latest
 * version — only when its content hash equals the page's — and audits it.
 */

const EFFECTIVE_UNTIL_KEYS = ['effectiveUntil', 'effectiveUntilBasis', 'effectiveUntilText', 'effectiveUntilAmendedBy'];

function arg(name: string): string | undefined {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : undefined;
}

const file = arg('file');
const officialUrl = arg('url');
const confirm = process.argv.includes('--confirm');
const refreshPresentation = process.argv.includes('--refresh-presentation');

if (!file || !officialUrl) {
  console.error('Usage: import-confaz-act --file=<saved official page> --url=<official CONFAZ URL> [--confirm]');
  process.exit(1);
}

const URL_PATTERN =
  /^https:\/\/www\.confaz\.fazenda\.gov\.br\/legislacao\/(convenios|ajustes|atos|protocolos)\/(\d{4})\/[A-Za-z0-9_-]+$/;
const urlMatch = URL_PATTERN.exec(officialUrl);
if (!urlMatch) {
  console.error('--url must be an official CONFAZ act URL (https://www.confaz.fazenda.gov.br/legislacao/<família>/<ano>/<ato>)');
  process.exit(1);
}
const family = urlMatch[1] as ConfazFamilyKey;
const urlYear = Number(urlMatch[2]);

const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const html = readFileSync(file, 'utf8');
const fileSha256 = createHash('sha256').update(html).digest('hex');

// The saved page must be the requested act: browsers record where it came from.
const savedFrom =
  /<!--\s*saved from url=\(\d+\)(\S+)\s*-->/i.exec(html)?.[1] ??
  /<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
if (!savedFrom || savedFrom.replace(/\/$/, '') !== officialUrl.replace(/\/$/, '')) {
  console.error(`The file was saved from ${savedFrom ?? 'an unknown address'}, not from ${officialUrl}.`);
  process.exit(1);
}

const parsed = parseConfazPublicationHtml(html, officialUrl, family, 'NORMAL');
const parsedYear = Number(parsed.metadata?.year);
if (parsedYear !== urlYear) {
  console.error(`Act year ${parsedYear} does not match the URL year ${urlYear}.`);
  process.exit(1);
}

const publication = {
  ...parsed,
  metadata: {
    ...parsed.metadata,
    ingestionChannel: 'CONFAZ_PORTAL_SAVED_PAGE',
    savedPage: { sha256: fileSha256, savedFrom, file },
  },
};

const summary = {
  officialUrl,
  title: publication.title,
  actType: publication.actType,
  actNumber: publication.actNumber,
  publishedAt: publication.publishedAt?.toISOString().slice(0, 10) ?? null,
  effectiveAt: publication.effectiveAt?.toISOString().slice(0, 10) ?? null,
  contentChars: publication.content?.length ?? 0,
  files: publication.files?.length ?? 0,
  fileSha256,
};

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 3 }) }),
});

async function existingOrigin() {
  const path = new URL(officialUrl!).pathname;
  return db
    .selectFrom('publication_origins')
    .select(['publication_id', 'official_url'])
    .where((eb) => eb.or([eb('official_url', '=', officialUrl!), eb('external_id', '=', path)]))
    .executeTakeFirst();
}

async function ownedRun(workerId: string): Promise<AcquiredCollectionRun> {
  return db.transaction().execute(async (trx) => {
    const source = await trx
      .selectFrom('sources')
      .select(['id', 'is_active'])
      .where('code', '=', CONFAZ_CONNECTOR_KEY)
      .where('connector_key', '=', CONFAZ_CONNECTOR_KEY)
      .executeTakeFirst();
    if (!source || !source.is_active) throw new Error('Active CONFAZ source not found');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'import-confaz-act:' + source.id}, 0))`.execute(trx);
    const now = new Date();
    const run = await trx
      .insertInto('collection_runs')
      .values({
        source_id: source.id,
        scheduled_for: now,
        trigger_type: 'MANUAL',
        status: 'RUNNING',
        started_at: now,
        worker_id: workerId,
        locked_at: now,
        heartbeat_at: now,
      })
      .returning(['id', 'correlation_id'])
      .executeTakeFirstOrThrow();
    return {
      id: run.id,
      sourceId: source.id,
      connectorKey: CONFAZ_CONNECTOR_KEY,
      maxAttempts: 1,
      correlationId: run.correlation_id,
      workerId,
    };
  });
}

const logger = {
  info: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'info', message, ...bindings })),
  warn: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'warn', message, ...bindings })),
  error: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'error', message, ...bindings })),
};

try {
  const before = await existingOrigin();
  if (!confirm) {
    console.log('CONFAZ_ACT_IMPORT=' + JSON.stringify({ mode: 'DRY_RUN', ...summary, alreadyImported: Boolean(before) }));
  } else {
    const registry = new ConnectorRegistry();
    const connector: CollectionConnector = {
      key: CONFAZ_CONNECTOR_KEY,
      collect: async () => ({
        publications: [publication],
        metadata: { mode: 'SINGLE_ACT_IMPORT', officialUrl, savedPageSha256: fileSha256 },
      }),
    };
    registry.register(connector);
    const acquired = await ownedRun(`import-confaz-act-${hostname()}-${process.pid}`);
    const result = await processAcquiredCollectionRun(db, registry, acquired, {
      timeoutMs: 120_000,
      heartbeatIntervalMs: 15_000,
      logger,
    });
    const after = await existingOrigin();
    const run = await db
      .selectFrom('collection_runs')
      .select(['status', 'error_summary'])
      .where('id', '=', acquired.id)
      .executeTakeFirstOrThrow();
    console.log(
      'CONFAZ_ACT_IMPORT=' +
        JSON.stringify({
          mode: 'IMPORT',
          ...summary,
          runId: acquired.id,
          engineStatus: result.status,
          metrics: result.metrics,
          run,
          publicationId: after?.publication_id ?? null,
          alreadyImportedBefore: Boolean(before),
        }),
    );
    if (run.status !== 'SUCCESS') process.exitCode = 2;

    if (refreshPresentation && run.status === 'SUCCESS' && after?.publication_id) {
      const normalized = normalizePublication({ sourceId: acquired.sourceId, publication });
      const presentation = normalized.metadata.presentation;
      const latest = await db
        .selectFrom('publication_versions')
        .select(['id', 'version_no', 'content_hash'])
        .where('publication_id', '=', after.publication_id)
        .orderBy('version_no', 'desc')
        .executeTakeFirstOrThrow();
      if (!presentation || latest.content_hash !== normalized.contentHash) {
        console.log('CONFAZ_PRESENTATION_REFRESH=' + JSON.stringify({ refreshed: false, reason: !presentation ? 'NO_PRESENTATION' : 'CONTENT_HASH_DIFFERS', versionId: latest.id }));
      } else {
        await db.transaction().execute(async (trx) => {
          // Display-only fields derived from the page (not in the hash):
          // the presentation HTML and the validity end date.
          const derived = Object.fromEntries(
            ['presentation', ...EFFECTIVE_UNTIL_KEYS]
              .filter((key) => normalized.metadata[key] !== undefined)
              .map((key) => [key, normalized.metadata[key]]),
          );
          await sql`
            UPDATE publication_versions
            SET source_metadata = (source_metadata - ${sql.raw(`ARRAY[${EFFECTIVE_UNTIL_KEYS.map((key) => `'${key}'`).join(',')}]`)}::text[]) || ${JSON.stringify(derived)}::jsonb
            WHERE id = ${latest.id}::uuid AND content_hash = ${normalized.contentHash}
          `.execute(trx);
          await sql`
            INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
            VALUES (NULL, 'SYSTEM', 'ops:import-confaz-act', 'PUBLICATION_PRESENTATION_REFRESHED', 'publication_version', ${latest.id}::uuid,
                    public.audit_project('PUBLICATION_PRESENTATION_REFRESHED','publication_version',${JSON.stringify({ savedPageSha256: fileSha256, htmlChars: (presentation as { html?: string }).html?.length ?? 0, effectiveUntil: normalized.metadata.effectiveUntil ?? null })}::jsonb), gen_random_uuid())
          `.execute(trx);
        });
        console.log('CONFAZ_PRESENTATION_REFRESH=' + JSON.stringify({ refreshed: true, versionId: latest.id, versionNo: latest.version_no, effectiveUntil: normalized.metadata.effectiveUntil ?? null }));
      }
    }
  }
} finally {
  await db.destroy();
}
