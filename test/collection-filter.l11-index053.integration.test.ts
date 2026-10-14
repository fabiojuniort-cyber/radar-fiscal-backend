import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL is required (isolated PG18 only)');

const HISTORICAL_ITEMS = 535_000;
const PURGE_TARGETS = 500;
const LIMIT_MS = 20_000;
const PASSWORD = 'L11-Index053-Isolated-Benchmark!';

type PlanNode = { 'Node Type'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
function usesIndex(node: PlanNode, name: string): boolean {
  if (node['Index Name'] === name) return true;
  return (node.Plans ?? []).some(child => usesIndex(child, name));
}

test('053: index-backed actual first 500-item purge with 535k collection_items (isolated PostgreSQL 18)', {
  timeout: 30 * 60_000,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const app = await buildApp();
  const unique = randomUUID().slice(0, 8).toUpperCase();
  const canonicalType = 'AVISO ADMINISTRATIVO INDEX053 ' + unique;
  const started = performance.now();
  let seedMs = 0, previewMs = 0, purgeMs = 0;
  try {
    const email = 'l11-index053-' + unique.toLowerCase() + '@example.test';
    const registration = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { name: 'L11 Benchmark Index053', email,
        company: 'L11 Benchmark', password: PASSWORD, confirmPassword: PASSWORD,
        acceptedTerms: true },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const owner = registration.json<{ user: { id: string }; tenant: { id: string } }>();
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = {
      authorization: 'Bearer ' + login.json<{ accessToken: string }>().accessToken,
      'x-tenant-id': owner.tenant.id,
    };
    await admin.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l11-index053')",
      [owner.user.id],
    );
    const policy = await admin.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1");
    if (!policy.rows.length) {
      await admin.query(
        "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) " +
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies",
        [owner.user.id],
      );
    }
    const source = await admin.query<{ id: string }>("SELECT id FROM sources WHERE code='dou' LIMIT 1");
    const sourceId = source.rows[0]?.id ?? (await admin.query<{ id: string }>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) " +
      "VALUES('dou','DOU Index053','FEDERAL','https://in.gov.br','dou') RETURNING id",
    )).rows[0]!.id;

    // The 535k historical items all have NON-NULL publication references:
    // they are unrelated to the 500 targets, but force a realistic expensive
    // sequential scan if collection_items.publication_id has no lookup index.
    const sentinel = await admin.query<{ id: string }>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis," +
      "jurisdiction_level,act_type,title,primary_official_url) " +
      "VALUES(md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text)," +
      "'STRONG','{}'::jsonb,'FEDERAL','HISTORICAL'," +
      "'Preserved unrelated historical publication',$1) RETURNING id",
      ['https://example.test/l11-index053/sentinel/' + unique],
    );
    const historicalId = sentinel.rows[0]!.id;
    const run = await admin.query<{ id: string }>(
      "INSERT INTO collection_runs(source_id,scheduled_for,trigger_type,status) " +
      "VALUES($1,clock_timestamp(),'MANUAL','SUCCESS') RETURNING id",
      [sourceId],
    );
    const collectionRunId = run.rows[0]!.id;
    const targets = await admin.query<{ id: string }>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis," +
      "jurisdiction_level,act_type,title,primary_official_url) " +
      "SELECT md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text)," +
      "'STRONG','{}'::jsonb,'FEDERAL',$1," +
      "'Aviso administrativo descartável para ensaio isolado'," +
      "'https://example.test/l11-index053/target/'||gen_random_uuid()::text " +
      "FROM generate_series(1,$2) RETURNING id",
      [canonicalType, PURGE_TARGETS],
    );
    const ids = targets.rows.map(row => row.id);
    assert.equal(ids.length, PURGE_TARGETS);
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash," +
      "content_text,is_current,source_metadata) " +
      "SELECT id,1,md5('053'||id::text)||md5('body'||id::text)," +
      "'Aviso de procedimento administrativo sem conteúdo fiscal',true," +
      "jsonb_build_object('dou',jsonb_build_object('section','DO3','sourceActType',$2::text)) " +
      "FROM publications WHERE id=ANY($1::uuid[])",
      [ids,canonicalType],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) " +
      "SELECT id,$2,'https://example.test/l11-index053/origin/'||id::text," +
      "jsonb_build_object('dou',jsonb_build_object('section','DO3','sourceActType',$3::text)) " +
      "FROM publications WHERE id=ANY($1::uuid[])",
      [ids,sourceId,canonicalType],
    );

    // Bulk synthetic data, valid FKs. No production DB credentials in CI.
    await admin.query(
      "INSERT INTO collection_items(collection_run_id,source_item_key,status,publication_id,raw_metadata) " +
      "SELECT $1,'hist-'||g::text,'PROCESSED_EXISTING',$2," +
      "jsonb_build_object('raw',md5(g::text||'a')||md5(g::text||'b')||" +
      "md5(g::text||'c')||md5(g::text||'d')||md5(g::text||'e')||md5(g::text||'f')) " +
      "FROM generate_series(1,$3) g",
      [collectionRunId, historicalId, HISTORICAL_ITEMS],
    );
    await admin.query(
      "INSERT INTO collection_items(collection_run_id,source_item_key,status,publication_id) " +
      "SELECT $1,'target-'||t.ord::text,'PROCESSED_NEW',t.id " +
      "FROM unnest($2::uuid[]) WITH ORDINALITY t(id,ord)",
      [collectionRunId, ids],
    );
    seedMs = Math.round(performance.now() - started);
    await admin.query('ANALYZE collection_items');
    await admin.query('ANALYZE taxonomy_candidate_occurrence_links');
    await admin.query('ANALYZE collection_filter_new_types');

    const count = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM collection_items',
    );
    assert.ok(Number(count.rows[0]!.count) >= 500_000);

    // EXPLAIN, not EXPLAIN ANALYZE: no write occurs in the plan assertions.
    const explain = await admin.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      'EXPLAIN (FORMAT JSON) UPDATE collection_items SET publication_id=NULL ' +
      'WHERE publication_id=ANY($1::uuid[])', [ids.slice(0, 100)],
    );
    const primaryPlan = explain.rows[0]!['QUERY PLAN'][0]!.Plan;
    assert.ok(usesIndex(primaryPlan, 'ix_collection_items_publication_id'),
      '535k-row UPDATE must plan an index access, not a sequential table scan');

    // The two other absent indexes cover SUPERSEDED occurrence links and
    // UUID[] overlap. Disabling seqscan here only proves the index is usable:
    // PostgreSQL may correctly choose seqscan for tiny/empty fixture tables.
    await admin.query('SET enable_seqscan=off');
    try {
      const links = await admin.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        'EXPLAIN (FORMAT JSON) DELETE FROM taxonomy_candidate_occurrence_links ' +
        'WHERE occurrence_id=$1::uuid', [randomUUID()],
      );
      assert.ok(usesIndex(links.rows[0]!['QUERY PLAN'][0]!.Plan,
        'ix_taxonomy_candidate_occurrence_links_occurrence'));
      const samples = await admin.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        'EXPLAIN (FORMAT JSON) UPDATE collection_filter_new_types ' +
        'SET sample_publication_ids=sample_publication_ids ' +
        'WHERE sample_publication_ids && $1::uuid[]', [[ids[0]]],
      );
      assert.ok(usesIndex(samples.rows[0]!['QUERY PLAN'][0]!.Plan,
        'ix_collection_filter_new_types_sample_publication_ids'));
    } finally {
      await admin.query('RESET enable_seqscan');
    }

    // Check all other parent-to-child lookup paths used by the 051 purge.
    const preexisting = [
      'ix_collection_run_publications_pub',
      'publication_scope_state_pkey', 'ix_publication_scope_events_publication',
      'uq_publication_version_number', 'ix_publication_taxonomy_curator_tags_version',
      'uq_publication_taxonomy_scan', 'ix_publication_ncm_mentions_version',
      'ix_taxonomy_unmapped_occurrences_run',
      'ix_publication_taxonomy_runs_version_release',
      'ix_publication_taxonomy_assertions_run', 'ix_publication_taxonomy_spans_assertion',
      'ix_publication_taxonomy_reviews_assertion_created',
      'ix_company_publications_publication_id',
      'ix_collection_run_publications_version_id',
      'ix_publication_scope_state_event_id',
    ];
    const lookup = await admin.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public'",
    );
    const present = new Set(lookup.rows.map(row => row.indexname));
    for (const index of preexisting) {
      assert.ok(present.has(index), 'Missing supporting index ' + index);
    }

    const rule = { sourceCode: 'dou', section: 'DO3',
      canonicalType, mode: 'EXCLUDE_ALWAYS' };
    const p0 = performance.now();
    const preview = await app.inject({
      method: 'POST', url: '/api/v1/admin/collection-filter/direct-rule/preview',
      headers, payload: rule,
    });
    previewMs = Math.round(performance.now() - p0);
    assert.equal(preview.statusCode, 200, preview.body);
    const p = preview.json<{ count: number; token: string; blockedCompany: number;
      blockedOtherSource: number;confirmationToken:string;policyRevision:number }>();
    assert.equal(p.count, PURGE_TARGETS);
    assert.equal(p.blockedCompany, 0);
    assert.equal(p.blockedOtherSource, 0);

    const t0 = performance.now();
    const confirm = await app.inject({
      method: 'POST', url: '/api/v1/admin/collection-filter/direct-rule/confirm',
      headers,
      payload: { ...rule, expectedCount: p.count, previewToken: p.token,confirmationToken:p.confirmationToken,policyRevision:p.policyRevision },
    });
    purgeMs = Math.round(performance.now() - t0);
    assert.equal(confirm.statusCode, 200, confirm.body);
    const result = confirm.json<{ apagadas: number; restantes: number; deletedCount: number }>();
    assert.equal(result.apagadas, PURGE_TARGETS);
    assert.equal(result.restantes, 0);
    assert.equal(result.deletedCount, PURGE_TARGETS);
    assert.ok(purgeMs < LIMIT_MS, '500-item confirmation exceeded 20 seconds: ' + purgeMs);

    const history = await admin.query<{ remaining: string; detached: string }>(
      'SELECT count(*) FILTER (WHERE publication_id=$1)::text AS remaining, ' +
      'count(*) FILTER (WHERE publication_id IS NULL)::text AS detached ' +
      'FROM collection_items WHERE collection_run_id=$2', [historicalId, collectionRunId],
    );
    assert.equal(Number(history.rows[0]!.remaining), HISTORICAL_ITEMS);
    assert.equal(Number(history.rows[0]!.detached), PURGE_TARGETS);
    const size = await admin.query<{ bytes: string }>(
      "SELECT pg_total_relation_size('public.collection_items')::text AS bytes",
    );
    console.log('L11_INDEX053_BENCHMARK=' + JSON.stringify({
      isolatedPg18: true, synthetic: true, collectionItems: HISTORICAL_ITEMS + PURGE_TARGETS,
      collectionItemsBytes: Number(size.rows[0]!.bytes),
      deletes: PURGE_TARGETS, seedMs, previewMs, purgeMs,
      updatePlanUsesIndex: true, noProductionWrites: true, targetMs: LIMIT_MS,
    }));
  } finally {
    await app.close();
    await admin.end();
  }
});
