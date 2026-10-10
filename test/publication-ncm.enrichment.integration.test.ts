/**
 * Trifaros / TAX13-R8-02 — NCM lexical/catalog integration WITHOUT
 * pretending that synthetic CONFAZ HTML is authenticated official provenance.
 *
 * Positive legal-CURRENT/temporal scans require a genuine R8-02 capture and
 * independent legal-effectivity review. Those positive gates remain BLOCKED
 * in R7 until real independent official evidence is available; this suite
 * MUST NOT mint a fake V2 proof to make unrelated lexical checks pass.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'kysely';
import { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { seedTestLegalScopeAttestation } from './legal-scope-attestation.fixture.js';
import {
  PUBLICATION_NCM_DETECTOR_KEY,
  PUBLICATION_NCM_DETECTOR_VERSION,
  NOT_SUPERSEDED_NCM_MENTION_SQL,
  extractNcmCandidates,
  catalogMatches,
  processPublicationNcmEnrichmentBatch,
} from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl || process.env.NODE_ENV !== 'test' || process.env.GITHUB_ACTIONS !== 'true' ||
    !['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname)) {
  throw new Error('TAX13_NCM_CI_DISPOSABLE_GITHUB_ONLY');
}
const workerPassword =
  process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!workerPassword) throw new Error('DB worker runtime password is required');

function runtimeUrl(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = 'radar_worker_runtime';
  url.password = password;
  return url.toString();
}

async function createPublicationFixture(
  admin: Pool,
  input: { title: string; text: string; scoped?: boolean; coverage?: 'COMPLETE' | 'PARTIAL' },
): Promise<{ publicationId: string; versionId: string }> {
  const pub = await admin.query<{ id: string }>(`
    INSERT INTO public.publications (
      identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on
    ) VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL',$2,'9999-12-31'::date)
    RETURNING id`,
  [createHash('sha256').update(randomUUID()).digest('hex'), input.title]);
  const publicationId = pub.rows[0]!.id;
  const presentationHtml = input.scoped === false ? null :
    '<p class="TituloAcordo">CONVÊNIO ICMS — fixture</p><p class="TextoAcordo">' +
    input.text + '</p>';
  const ver = await admin.query<{ id: string }>(`
    INSERT INTO public.publication_versions (
      publication_id,version_no,content_hash,content_text,source_metadata,is_current
    ) VALUES ($1::uuid,1,$2,$3,$4::jsonb,true)
    RETURNING id`,
  [publicationId,createHash('sha256').update(input.text).digest('hex'),
    input.text,JSON.stringify({presentation:{
      format: input.scoped === false ? 'PRESERVED_TEXT' : 'SANITIZED_HTML',
      html: presentationHtml,
    }})]);
  const versionId = ver.rows[0]!.id;
  if (input.scoped !== false) {
    // The attestation is synthetic and CANNOT issue a V2 official proof.
    // No production legal trust boundary is bypassed.
    await seedTestLegalScopeAttestation(admin, versionId, input.coverage ?? 'COMPLETE', false);
  }
  return { publicationId, versionId };
}

test('NCM lexical recognition and current catalog matching are not legal CURRENT proof', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const db = createStandaloneDatabase({
    connectionString: runtimeUrl(adminUrl, workerPassword),
    poolMax: 1,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
  });
  try {
    const catalog = await admin.query<{ code: string }>(`
      SELECT regexp_replace(e.official_code,'[^0-9]','','g') AS code
      FROM official_catalog_entries e
      JOIN official_catalog_editions ed ON ed.id=e.catalog_edition_id
      JOIN official_catalogs c ON c.id=ed.catalog_id
      WHERE c.code='NCM' AND ed.status='CURRENT'
        AND COALESCE(e.metadata->>'assignable','false')='true'
        AND regexp_replace(e.official_code,'[^0-9]','','g')=ANY($1::text[])
      ORDER BY code`, [['10063011','10062099']]);
    assert.deepEqual(catalog.rows.map(x => x.code),['10062099','10063011'],
      'official NCM catalog must be prepared in ephemeral CI database');

    const access = await sql<{
      current_user: string;can_read_catalogs:boolean;can_read_editions:boolean;can_read_entries:boolean;
    }>`
      SELECT current_user,
        has_table_privilege(current_user,'public.official_catalogs','SELECT') AS can_read_catalogs,
        has_table_privilege(current_user,'public.official_catalog_editions','SELECT') AS can_read_editions,
        has_table_privilege(current_user,'public.official_catalog_entries','SELECT') AS can_read_entries
    `.execute(db);
    assert.deepEqual(access.rows[0],{
      current_user:'radar_worker_runtime',can_read_catalogs:true,
      can_read_editions:true,can_read_entries:true,
    });

    const raw='Tabela: NCM 1006.30.11 e 10062099. Repete 1006.30.11. Ignorar 9999.99.99.';
    const candidates=extractNcmCandidates(raw);
    assert.deepEqual(candidates.map(c=>c.code),['10063011','10062099','99999999']);
    assert.equal(candidates.find(c=>c.code==='10063011')?.occurrenceCount,2);
    assert.ok(candidates.every(c=>c.spanEnd > c.spanStart && c.excerpt.length>0));
    const matched=await db.transaction().execute(trx=>
      catalogMatches(trx,candidates.map(x=>x.code)));
    assert.deepEqual([...matched.keys()].sort(),['10062099','10063011']);
    assert.equal(matched.has('99999999'),false);

    const missing=extractNcmCandidates('Texto com candidato 9999.99.99 que não está no catálogo.');
    assert.deepEqual(missing.map(x=>x.code),['99999999']);
    const zeroMatch=await db.transaction().execute(trx=>
      catalogMatches(trx,missing.map(x=>x.code)));
    assert.equal(zeroMatch.size,0);
    // Catalog membership and regex matches NEVER publish current legal effects.
    const metadata={ interpretation:'CATALOG_CODE_MENTION_ONLY' };
    assert.equal(metadata.interpretation,'CATALOG_CODE_MENTION_ONLY');
  } finally {
    await db.destroy();
    await admin.end();
  }
});

test('NCM batch refuses synthetic COMPLETE/PARTIAL/unscoped documents without R8-02 official proof', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const db = createStandaloneDatabase({
    connectionString: runtimeUrl(adminUrl, workerPassword),
    poolMax: 1,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
  });
  try {
    const complete=await createPublicationFixture(admin,{
      title:'NCM synthetic COMPLETE no official capture',
      text:'NCM 1006.30.11 e 10062099. Repete 1006.30.11.',
    });
    const partial=await createPublicationFixture(admin,{
      title:'NCM synthetic PARTIAL no official capture',
      text:'NCM 1006.30.11 potencialmente em anexo não revisado.',
      coverage:'PARTIAL',
    });
    const unscoped=await createPublicationFixture(admin,{
      title:'NCM raw text must remain unverified',
      text:'NCM 1006.30.11 e 10062099 em texto não verificado.',
      scoped:false,
    });
    const targets=[complete,partial,unscoped];
    for(const target of targets){
      const pg = await admin.query<{proof_ready:boolean;fingerprint:string|null}>(`
        SELECT public.tax13_v2_worker_proof_ready($1::uuid,CURRENT_DATE) AS proof_ready,
          public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint`,
        [target.versionId]);
      assert.deepEqual(pg.rows[0],{proof_ready:false,fingerprint:null});
    }
    // The real worker still runs on a committed database, with its strict
    // V2 database selector (no monkeypatch and no spoofed CURRENT proof).
    const result=await processPublicationNcmEnrichmentBatch(db,{limit:100});
    assert.equal(result.failed,0);
    const persisted=await admin.query<{ version_id:string; mentions:number; scans:number; evidences:number; seals:number }>(`
      SELECT target.id AS version_id,
        (SELECT count(*)::int FROM public.publication_ncm_mentions m WHERE m.publication_version_id=target.id) AS mentions,
        (SELECT count(*)::int FROM public.publication_ncm_scans s
         WHERE s.publication_version_id=target.id AND s.detector_key=$2
           AND s.detector_version=$3) AS scans,
        (SELECT count(*)::int FROM public.publication_ncm_scan_evidence e
         WHERE e.publication_version_id=target.id AND e.detector_key=$2
           AND e.detector_version=$3) AS evidences,
        (SELECT count(*)::int FROM public.tax13_ncm_seals_v2 seal
         JOIN public.publication_ncm_scan_evidence e ON e.id=seal.scan_evidence_id
         WHERE e.publication_version_id=target.id) AS seals
      FROM unnest($1::uuid[]) AS target(id)
      ORDER BY target.id`,
      [targets.map(x=>x.versionId),PUBLICATION_NCM_DETECTOR_KEY,PUBLICATION_NCM_DETECTOR_VERSION]);
    assert.equal(persisted.rows.length,3);
    for(const row of persisted.rows) {
      assert.deepEqual([row.mentions,row.scans,row.evidences,row.seals],[0,0,0,0],
        'synthetic data must never generate scan success, NCM current seal or green status');
    }
    // Legacy catalogue mentions may remain searchable. 1.3.0 does not
    // prove that codes are globally absent from historical/unreviewed text.
    const entry=await admin.query<{id:string}>(`
      SELECT e.id FROM public.official_catalog_entries e
      JOIN public.official_catalog_editions ed ON ed.id=e.catalog_edition_id
      JOIN public.official_catalogs c ON c.id=ed.catalog_id
      WHERE c.code='NCM' AND ed.status='CURRENT'
        AND regexp_replace(e.official_code,'[^0-9]','','g')='10063011'
      LIMIT 1`);
    assert.ok(entry.rows[0]?.id);
    await admin.query(`
      INSERT INTO public.publication_ncm_mentions(
        publication_version_id,ncm_code,official_catalog_entry_id,verification_status,
        method_type,detector_key,detector_version,excerpt
      ) VALUES($1::uuid,'10063011',$2::uuid,'CATALOG_MATCHED',
        'EXTRACTOR',$3,'1.0.0','redação anterior, validade não verificada')`,
      [partial.versionId,entry.rows[0]!.id,PUBLICATION_NCM_DETECTOR_KEY]);
    const visible=await admin.query<{count:number}>(`
      SELECT count(*)::int AS count FROM public.publication_ncm_mentions pnm
      WHERE pnm.publication_version_id=$1::uuid
        AND ${NOT_SUPERSEDED_NCM_MENTION_SQL('pnm')}`,[partial.versionId]);
    assert.equal(visible.rows[0]?.count,1);
    const after=await admin.query<{fingerprint:string|null}>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint`,[partial.versionId]);
    assert.equal(after.rows[0]?.fingerprint,null);
  } finally {
    await db.destroy();
    // Tests exclusively use fresh randomly keyed records in disposable CI PG.
    // Do not delete source/attestation rows that may be protected by an
    // append-only ledger: retaining them in ephemeral DB is more faithful.
    await admin.end();
  }
});
