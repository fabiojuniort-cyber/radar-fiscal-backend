import { Pool } from 'pg';
import { z } from 'zod';

import {
  normalizeCollectionFilterType,
  type CollectionFilterMode,
} from '../../modules/collection/collection-filter.engine.js';
import {
  serializeCollectionFilterDraft,
  type CollectionFilterDraftInput,
} from '../../modules/collection/collection-filter.admin.js';

const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().min(1),
    PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  })
  .parse(process.env);

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const email = (
  arg('email') ??
  env.PLATFORM_ADMIN_EMAIL ??
  'fabio.terasaka@agrex.com.br'
)
  .trim()
  .toLowerCase();

const dryRun = process.argv.includes('--dry-run');
const replaceExistingDraft = process.argv.includes(
  '--replace-existing-draft',
);

const TAX_SOURCES = new Set([
  'confaz',
  'rfb-normas',
  'cgibs',
  'nfe-encat',
  'sped',
]);

const STRONG_TERMS = [
  'ICMS',
  'ISS',
  'ISSQN',
  'IBS',
  'CBS',
  'PIS',
  'COFINS',
  'IPI',
  'SUBSTITUICAO TRIBUTARIA',
  'CREDITO PRESUMIDO',
  'DIFERIMENTO',
  'ISENCAO',
  'REDUCAO DE BASE',
  'NF-E',
  'NFS-E',
  'CT-E',
  'MDF-E',
  'EFD',
  'SPED',
  'NCM',
  'CONVENIO ICMS',
  'AJUSTE SINIEF',
] as const;

const WEAK_TERMS = [
  'TRIBUTARIO',
  'TRIBUTARIA',
  'FISCAL',
  'ALIQUOTA',
  'CREDITO',
  'BENEFICIO FISCAL',
  'PRODUTOR RURAL',
  'AGRONEGOCIO',
  'FERTILIZANTE',
  'DEFENSIVO',
] as const;

const NEGATIVE_TERMS = [
  'REGULARIDADE FISCAL',
  'CERTIDAO NEGATIVA',
] as const;

function modeFor(
  sourceCode: string,
  canonicalType: string,
): CollectionFilterMode {
  if (TAX_SOURCES.has(sourceCode)) return 'KEEP_ALWAYS';
  if (sourceCode !== 'dou') return 'KEEP_ALWAYS';
  if (canonicalType === 'EXTRATO DE CONTRATO') {
    return 'EXCLUDE_UNLESS_STRONG';
  }
  return 'KEEP_IF_TAX_TERM';
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

const pool = new Pool({
  connectionString: env.DATABASE_ADMIN_URL,
  max: 1,
});

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actor = await client.query<{
      id: string;
      email: string;
    }>(
      `SELECT u.id,u.email
       FROM app_users u
       JOIN platform_user_roles r ON r.user_id=u.id
       WHERE lower(u.email)=lower($1)
         AND u.status='ACTIVE'
         AND r.role='PLATFORM_ADMIN'
         AND r.revoked_at IS NULL`,
      [email],
    );
    if (actor.rowCount !== 1) {
      throw new Error(
        `PLATFORM_ADMIN_NOT_UNIQUE: matched=${actor.rowCount}`,
      );
    }
    const actorRow = actor.rows[0]!;
    await client.query(
      `SELECT set_config('app.user_id',$1,true)`,
      [actorRow.id],
    );

    const policyState = await client.query<{
      status: string;
      count: string;
    }>(
      `SELECT status,count(*)::text AS count
       FROM collection_filter_policies
       WHERE status IN ('DRAFT','APPROVED')
       GROUP BY status`,
    );
    const activeCounts = new Map(
      policyState.rows.map((row) => [
        row.status,
        Number(row.count),
      ]),
    );
    if ((activeCounts.get('APPROVED') ?? 0) > 0) {
      throw new Error(
        'INITIAL_FILTER_SEED_REFUSED: approved policy already exists',
      );
    }
    if (
      !dryRun &&
      !replaceExistingDraft &&
      (activeCounts.get('DRAFT') ?? 0) > 0
    ) {
      throw new Error(
        'INITIAL_FILTER_SEED_REFUSED: draft already exists; use --replace-existing-draft only after review',
      );
    }

    const raw = await client.query<{
      source_code: string;
      section: string;
      raw_type: string;
      publications: string;
    }>(
      `SELECT
         s.code AS source_code,
         COALESCE(o.metadata->'dou'->>'section','') AS section,
         btrim(p.act_type) AS raw_type,
         count(DISTINCT p.id)::text AS publications
       FROM publication_origins o
       JOIN sources s ON s.id=o.source_id
       JOIN publications p ON p.id=o.publication_id
       WHERE s.code NOT IN ('doe-sp','doe-sp-legado')
         AND NOT p.is_hidden
         AND p.act_type IS NOT NULL
         AND btrim(p.act_type)<>''
       GROUP BY
         s.code,
         COALESCE(o.metadata->'dou'->>'section',''),
         btrim(p.act_type)
       ORDER BY s.code,section,raw_type`,
    );

    const ruleMap = new Map<
      string,
      {
        sourceCode: string;
        section: string;
        canonicalType: string;
        mode: CollectionFilterMode;
      }
    >();

    for (const row of raw.rows) {
      const sourceCode = row.source_code.trim().toLowerCase();
      const section = row.section.trim().toUpperCase();
      const canonicalType = normalizeCollectionFilterType(
        row.raw_type,
      );
      if (!canonicalType) continue;
      const key = `${sourceCode}\u001f${section}\u001f${canonicalType}`;
      if (!ruleMap.has(key)) {
        ruleMap.set(key, {
          sourceCode,
          section,
          canonicalType,
          mode: modeFor(sourceCode, canonicalType),
        });
      }
    }

    const terms: CollectionFilterDraftInput['terms'] = [
      ...STRONG_TERMS.map((text) => ({
        text,
        strength: 'STRONG' as const,
        locationScope: 'ANY' as const,
      })),
      ...WEAK_TERMS.map((text) => ({
        text,
        strength: 'WEAK' as const,
        locationScope: 'ANY' as const,
      })),
      ...NEGATIVE_TERMS.map((text) => ({
        text,
        strength: 'NEGATIVE' as const,
        locationScope: 'ANY' as const,
      })),
    ];

    const document: CollectionFilterDraftInput = {
      contextWindowWords: 12,
      weakScoreThreshold: 3,
      locationWeights: {
        title: 3,
        summary: 2,
        body: 1,
      },
      rules: [...ruleMap.values()],
      aliases: [],
      terms,
      changeNotes:
        'ACT-SCOPE-02 initial conservative seed from observed archive types',
    };

    const serializedDocument =
      serializeCollectionFilterDraft(document);

    const byMode = Object.fromEntries(
      [
        'KEEP_ALWAYS',
        'KEEP_IF_TAX_TERM',
        'EXCLUDE_UNLESS_STRONG',
        'EXCLUDE_ALWAYS',
      ].map((mode) => [
        mode,
        document.rules.filter((rule) => rule.mode === mode)
          .length,
      ]),
    );

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(
        'COLLECTION_FILTER_SEED=' +
          JSON.stringify({
            ok: true,
            dryRun: true,
            admin: maskEmail(actorRow.email),
            rawGroups: raw.rows.length,
            canonicalRules: document.rules.length,
            terms: document.terms.length,
            byMode,
            approvedPolicies: activeCounts.get('APPROVED') ?? 0,
            existingDrafts: activeCounts.get('DRAFT') ?? 0,
            next: 'FULL_ARCHIVE_SAMPLE_WOULD_BE_REQUESTED',
          }),
      );
    } else {
    const saved = await client.query<{
      policy_id: string;
      policy_version: number;
      policy_revision: number;
    }>(
      `SELECT * FROM collection_filter_save_draft($1::jsonb)`,
      [JSON.stringify(serializedDocument)],
    );
    const policy = saved.rows[0];
    if (!policy) {
      throw new Error('INITIAL_FILTER_SEED_SAVE_FAILED');
    }

    const requested = await client.query<{
      simulation_id: string;
      policy_revision: number;
      action: string;
    }>(
      `SELECT * FROM collection_filter_request_simulation(
         $1::uuid,'FULL_ARCHIVE','SAMPLE'
       )`,
      [policy.policy_id],
    );

    await client.query('COMMIT');

    console.log(
      'COLLECTION_FILTER_SEED=' +
        JSON.stringify({
          ok: true,
          dryRun: false,
          admin: maskEmail(actorRow.email),
          rawGroups: raw.rows.length,
          canonicalRules: document.rules.length,
          terms: document.terms.length,
          byMode,
          policyIdPrefix: policy.policy_id.slice(0, 8),
          version: Number(policy.policy_version),
          revision: Number(policy.policy_revision),
          simulationIdPrefix:
            requested.rows[0]?.simulation_id.slice(0, 8) ??
            null,
          simulationAction:
            requested.rows[0]?.action ?? null,
        }),
    );
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
