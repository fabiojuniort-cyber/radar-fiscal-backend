import type { PoolClient } from 'pg';

export async function writeBaselineAudit(
  client: PoolClient,
  input: {
    action: string;
    correlationId: string;
    releaseId?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    [
      'INSERT INTO audit_log (',
      '  tenant_id,',
      '  actor_type,',
      '  actor_id,',
      '  action,',
      '  entity_type,',
      '  entity_id,',
      '  after_data,',
      '  correlation_id',
      ') VALUES (',
      '  NULL,',
      "  'SYSTEM',",
      "  'taxonomy-baseline-importer',",
      '  $1,',
      "  'taxonomy_baseline',",
      '  $2,',
      '  $3::jsonb,',
      '  $4::uuid',
      ')',
    ].join('\n'),
    [
      input.action,
      input.releaseId ?? null,
      JSON.stringify(input.payload),
      input.correlationId,
    ],
  );
}
