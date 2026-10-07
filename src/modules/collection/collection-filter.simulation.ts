import { hostname } from 'node:os';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  compileCollectionFilterPolicy,
  evaluateCollectionFilter,
  type CollectionFilterPolicyInput,
  type CollectionFilterTermHit,
} from './collection-filter.engine.js';

interface SimulationClaim {
  simulation_id: string;
  policy_id: string;
  policy_version: number;
  policy_revision: number;
  simulation_scope: 'FULL_ARCHIVE' | 'RECENT';
  review_mode: 'ALL' | 'SAMPLE' | 'NONE';
  last_publication_id: string | null;
  processed_count: string | number;
  metrics: unknown;
  policy_document: CollectionFilterPolicyInput;
}

interface SimulationRow {
  publication_id: string;
  title: string;
  published_on: string | Date | null;
  official_url: string | null;
  act_type: string | null;
  summary: string | null;
  body: string | null;
  evidence_complete: boolean;
  material_attachments_unexamined: boolean;
  provenance_conflict: boolean;
  origins: unknown;
}

interface OriginShape {
  sourceCode: string;
  section: string;
}

interface SimulationMetrics {
  inspected: number;
  keep: number;
  discard: number;
  unknownType: number;
  reviewSample: number;
  byReason: Record<string, number>;
  bySource: Record<string, number>;
}

export interface ProcessCollectionFilterSimulationOptions {
  workerId: string;
  batchSize?: number;
}

export type ProcessCollectionFilterSimulationResult =
  | { state: 'IDLE' }
  | {
      state: 'BATCH';
      simulationId: string;
      inspected: number;
      processed: number;
    }
  | {
      state: 'COMPLETED';
      simulationId: string;
      processed: number;
      metrics: SimulationMetrics;
    }
  | {
      state: 'FAILED';
      simulationId: string;
      errorCode: string;
    };

function runtimeWorkerId(base: string): string {
  return `${base}:${hostname()}:${process.pid}`.slice(0, 200);
}

function asMetrics(value: unknown): SimulationMetrics {
  const object =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const numeric = (key: string): number => {
    const value = object[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : 0;
  };
  const record = (key: string): Record<string, number> => {
    const value = object[key];
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]),
        ),
    );
  };
  return {
    inspected: numeric('inspected'),
    keep: numeric('keep'),
    discard: numeric('discard'),
    unknownType: numeric('unknownType'),
    reviewSample: numeric('reviewSample'),
    byReason: record('byReason'),
    bySource: record('bySource'),
  };
}

function origins(value: unknown): OriginShape[] {
  if (!Array.isArray(value)) return [];
  const result: OriginShape[] = [];
  for (const item of value) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      continue;
    }
    const object = item as Record<string, unknown>;
    if (typeof object.sourceCode !== 'string') continue;
    result.push({
      sourceCode: object.sourceCode,
      section:
        typeof object.section === 'string'
          ? object.section
          : '',
    });
  }
  return result.sort(
    (left, right) =>
      left.sourceCode.localeCompare(right.sourceCode) ||
      left.section.localeCompare(right.section),
  );
}

function deterministicSample(publicationId: string): boolean {
  const hex = publicationId.replaceAll('-', '').slice(0, 8);
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) && value % 20 === 0;
}

function decisiveHit(
  hits: readonly CollectionFilterTermHit[],
): CollectionFilterTermHit | undefined {
  return (
    hits.find(
      (hit) =>
        hit.strength === 'STRONG' &&
        !hit.neutralizedByNegative,
    ) ??
    hits.find(
      (hit) =>
        hit.strength === 'WEAK' &&
        !hit.neutralizedByNegative,
    )
  );
}

function reviewExcerpt(
  row: SimulationRow,
  hit: CollectionFilterTermHit | undefined,
): string | null {
  const source =
    hit?.location === 'TITLE'
      ? row.title
      : hit?.location === 'SUMMARY'
        ? row.summary
        : hit?.location === 'BODY'
          ? row.body
          : row.summary ?? row.body ?? row.title;
  if (!source) return null;
  const compact = source.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.slice(0, 600);
}

function increment(
  record: Record<string, number>,
  key: string,
): void {
  record[key] = (record[key] ?? 0) + 1;
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'SIMULATION_FAILED';
  if (/policy/i.test(error.message)) {
    return 'POLICY_COMPILE_FAILED';
  }
  if (/lease/i.test(error.message)) {
    return 'SIMULATION_LEASE_FAILED';
  }
  return 'SIMULATION_PROCESSING_FAILED';
}

export async function processCollectionFilterSimulationBatch(
  db: Kysely<DB>,
  options: ProcessCollectionFilterSimulationOptions,
): Promise<ProcessCollectionFilterSimulationResult> {
  const workerId = runtimeWorkerId(options.workerId);
  const batchSize = Math.min(
    Math.max(options.batchSize ?? 500, 1),
    1000,
  );

  const claimed = await sql<SimulationClaim>`
    SELECT *
    FROM collection_filter_claim_simulation(${workerId})
  `.execute(db);
  const claim = claimed.rows[0];
  if (!claim) return { state: 'IDLE' };

  let policy;
  try {
    policy = compileCollectionFilterPolicy(
      claim.policy_document,
    );
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await sql`
      SELECT collection_filter_fail_simulation(
        ${claim.simulation_id}::uuid,
        ${workerId},
        ${errorCode}
      )
    `.execute(db);
    return {
      state: 'FAILED',
      simulationId: claim.simulation_id,
      errorCode,
    };
  }

  try {
    const page = await sql<SimulationRow>`
      SELECT *
      FROM collection_filter_simulation_batch(
        ${claim.simulation_id}::uuid,
        ${workerId},
        ${claim.last_publication_id}::uuid,
        ${batchSize}
      )
    `.execute(db);

    const metrics = asMetrics(claim.metrics);

    if (page.rows.length === 0) {
      await sql`
        SELECT collection_filter_finish_simulation(
          ${claim.simulation_id}::uuid,
          ${workerId},
          ${JSON.stringify(metrics)}::jsonb
        )
      `.execute(db);
      return {
        state: 'COMPLETED',
        simulationId: claim.simulation_id,
        processed: Number(claim.processed_count),
        metrics,
      };
    }

    const items = page.rows.map((row) => {
      const eligibleOrigins = origins(row.origins);
      const origin = eligibleOrigins[0] ?? {
        sourceCode: 'UNKNOWN',
        section: '',
      };

      const decision = evaluateCollectionFilter(policy, {
        sourceCode: origin.sourceCode,
        section: origin.section,
        actType: row.act_type,
        title: row.title,
        summary: row.summary,
        body: row.body,
        evidenceComplete: row.evidence_complete,
        materialAttachmentsUnexamined:
          row.material_attachments_unexamined,
        provenanceConflict:
          row.provenance_conflict ||
          eligibleOrigins.length === 0,
      });

      const hit = decisiveHit(decision.termHits);
      const reviewSample =
        claim.review_mode === 'ALL' ||
        (claim.review_mode === 'SAMPLE' &&
          (decision.reasonCode === 'UNKNOWN_TYPE' ||
            deterministicSample(row.publication_id)));

      metrics.inspected += 1;
      if (decision.decision === 'KEEP') metrics.keep += 1;
      else metrics.discard += 1;
      if (decision.reasonCode === 'UNKNOWN_TYPE') {
        metrics.unknownType += 1;
      }
      if (reviewSample) metrics.reviewSample += 1;
      increment(metrics.byReason, decision.reasonCode);
      increment(metrics.bySource, origin.sourceCode);

      return {
        publication_id: row.publication_id,
        source_code: origin.sourceCode,
        section: origin.section,
        raw_type: decision.rawType || null,
        canonical_type: decision.canonicalType ?? null,
        decision: decision.decision,
        reason_code: decision.reasonCode,
        decisive_term: hit?.text ?? null,
        excerpt: reviewExcerpt(row, hit),
        title: row.title,
        published_on:
          row.published_on instanceof Date
            ? row.published_on.toISOString().slice(0, 10)
            : row.published_on,
        official_url: row.official_url,
        review_sample: reviewSample,
      };
    });

    const lastPublicationId =
      page.rows[page.rows.length - 1]!.publication_id;

    await sql`
      SELECT collection_filter_record_simulation_batch(
        ${claim.simulation_id}::uuid,
        ${workerId},
        ${lastPublicationId}::uuid,
        ${JSON.stringify(items)}::jsonb,
        ${JSON.stringify(metrics)}::jsonb
      )
    `.execute(db);

    return {
      state: 'BATCH',
      simulationId: claim.simulation_id,
      inspected: page.rows.length,
      processed:
        Number(claim.processed_count) + page.rows.length,
    };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await sql`
      SELECT collection_filter_fail_simulation(
        ${claim.simulation_id}::uuid,
        ${workerId},
        ${errorCode}
      )
    `.execute(db).catch(() => undefined);
    return {
      state: 'FAILED',
      simulationId: claim.simulation_id,
      errorCode,
    };
  }
}
