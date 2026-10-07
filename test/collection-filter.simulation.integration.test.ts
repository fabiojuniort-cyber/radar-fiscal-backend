import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sql } from 'kysely';
import { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { processCollectionFilterSimulationBatch } from '../src/modules/collection/collection-filter.simulation.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const workerUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
if (!workerUrl) throw new Error('DATABASE_URL is required');

test('ACT-SCOPE-02 Stage 5: worker simulates with least privilege, keeps unknown and excludes DOE-SP', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const worker = createStandaloneDatabase({
    connectionString: workerUrl,
    poolMax: 1,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
  });

  const suffix = randomUUID().slice(0, 8);
  const sourceCode = `filter-sim-${suffix}`;
  const connectorKey = `filter-sim-${suffix}`;
  const sourceId = randomUUID();
  const createdPublicationIds: string[] = [];
  let insertedDoeSource = false;

  async function publication(
    input: {
      sourceId: string;
      sourceCode: string;
      title: string;
      actType: string;
      text: string;
      section?: string;
    },
  ): Promise<string> {
    const publicationId = randomUUID();
    createdPublicationIds.push(publicationId);
    await admin.query(
      `INSERT INTO publications(
         id,identity_hash,identity_strength,identity_basis,
         jurisdiction_level,title,act_type,published_on,
         primary_official_url
       ) VALUES(
         $1,$2,'STRONG','{}'::jsonb,'FEDERAL',$3,$4,
         DATE '2026-10-06',$5
       )`,
      [
        publicationId,
        createHash('sha256').update(publicationId).digest('hex'),
        input.title,
        input.actType,
        `https://example.invalid/${publicationId}`,
      ],
    );
    await admin.query(
      `INSERT INTO publication_origins(
         publication_id,source_id,external_id,official_url,metadata
       ) VALUES(
         $1,$2,$3,$4,$5::jsonb
       )`,
      [
        publicationId,
        input.sourceId,
        `ext-${publicationId}`,
        `https://example.invalid/${publicationId}`,
        JSON.stringify({
          dou: { section: input.section ?? '' },
        }),
      ],
    );
    await admin.query(
      `INSERT INTO publication_versions(
         publication_id,version_no,content_hash,content_text,
         relevant_excerpt,source_metadata,is_current
       ) VALUES(
         $1,1,$2,$3,$4,'{}'::jsonb,true
       )`,
      [
        publicationId,
        createHash('sha256').update(input.text).digest('hex'),
        input.text,
        input.text.slice(0, 180),
      ],
    );
    return publicationId;
  }

  try {
    const role = await sql<{
      current_user: string;
      can_update_simulation: boolean;
      can_insert_item: boolean;
      can_claim: boolean;
      can_batch: boolean;
      can_record: boolean;
    }>`
      SELECT
        current_user,
        has_table_privilege(
          current_user,
          'public.collection_filter_simulations',
          'UPDATE'
        ) AS can_update_simulation,
        has_table_privilege(
          current_user,
          'public.collection_filter_simulation_items',
          'INSERT'
        ) AS can_insert_item,
        has_function_privilege(
          current_user,
          'public.collection_filter_claim_simulation(text)',
          'EXECUTE'
        ) AS can_claim,
        has_function_privilege(
          current_user,
          'public.collection_filter_simulation_batch(uuid,text,uuid,integer)',
          'EXECUTE'
        ) AS can_batch,
        has_function_privilege(
          current_user,
          'public.collection_filter_record_simulation_batch(uuid,text,uuid,jsonb,jsonb)',
          'EXECUTE'
        ) AS can_record
    `.execute(worker);

    assert.equal(role.rows[0]?.current_user, 'radar_worker_runtime');
    assert.deepEqual(
      {
        canUpdateSimulation: role.rows[0]?.can_update_simulation,
        canInsertItem: role.rows[0]?.can_insert_item,
        canClaim: role.rows[0]?.can_claim,
        canBatch: role.rows[0]?.can_batch,
        canRecord: role.rows[0]?.can_record,
      },
      {
        canUpdateSimulation: false,
        canInsertItem: false,
        canClaim: true,
        canBatch: true,
        canRecord: true,
      },
    );

    await admin.query(
      `INSERT INTO sources(
         id,code,name,jurisdiction_level,base_url,connector_key,is_active
       ) VALUES(
         $1,$2,'Filter simulation fixture','FEDERAL',
         'https://example.invalid',$3,true
       )`,
      [sourceId, sourceCode, connectorKey],
    );

    let doe = await admin.query<{ id: string }>(
      `SELECT id FROM sources WHERE code='doe-sp' LIMIT 1`,
    );
    if (!doe.rowCount) {
      const doeId = randomUUID();
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO sources(
           id,code,name,jurisdiction_level,uf,base_url,connector_key,is_active
         ) VALUES(
           $1,'doe-sp','DOE-SP fixture','STATE','SP',
           'https://doe.sp.gov.br','doe-sp',true
         )
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [doeId],
      );
      insertedDoeSource = inserted.rowCount === 1;
      doe = inserted.rowCount
        ? inserted
        : await admin.query<{ id: string }>(
            `SELECT id FROM sources WHERE code='doe-sp' LIMIT 1`,
          );
    }
    const doeSourceId = doe.rows[0]!.id;

    const keepId = await publication({
      sourceId,
      sourceCode,
      section: 'DO1',
      title: 'Portaria ICMS de teste',
      actType: 'PORTARIA',
      text: 'Regulamenta crédito de ICMS para a operação.',
    });
    const discardId = await publication({
      sourceId,
      sourceCode,
      section: 'DO1',
      title: 'Portaria administrativa de teste',
      actType: 'PORTARIA',
      text: 'Dispõe sobre escala interna de servidores.',
    });
    const unknownId = await publication({
      sourceId,
      sourceCode,
      section: 'DO1',
      title: 'Ato novo sem classificação',
      actType: 'ATO NOVO',
      text: 'Conteúdo administrativo sem classificação conhecida.',
    });
    const doeId = await publication({
      sourceId: doeSourceId,
      sourceCode: 'doe-sp',
      title: 'DOE-SP fora do escopo',
      actType: 'PORTARIA',
      text: 'ICMS no DOE-SP não pertence à ACT-SCOPE-02.',
    });

    const policy = await admin.query<{ id: string }>(
      `INSERT INTO collection_filter_policies(
         version,status,context_window_words,weak_score_threshold,
         title_weight,summary_weight,body_weight,revision
       ) VALUES(900001,'DRAFT',12,3,3,2,1,1)
       RETURNING id`,
    );
    const policyId = policy.rows[0]!.id;

    await admin.query(
      `INSERT INTO collection_filter_type_rules(
         policy_id,source_code,section,canonical_type,mode
       ) VALUES(
         $1,$2,'DO1','PORTARIA','KEEP_IF_TAX_TERM'
       )`,
      [policyId, sourceCode],
    );
    await admin.query(
      `INSERT INTO collection_filter_terms(
         policy_id,term_text,normalized_term,strength,location_scope
       ) VALUES(
         $1,'ICMS','ICMS','STRONG','ANY'
       )`,
      [policyId],
    );

    const simulation = await admin.query<{ id: string }>(
      `INSERT INTO collection_filter_simulations(
         policy_id,policy_revision,status,scope,review_mode
       ) VALUES($1,1,'PENDING','FULL_ARCHIVE','ALL')
       RETURNING id`,
      [policyId],
    );
    const simulationId = simulation.rows[0]!.id;

    let terminal:
      | Awaited<ReturnType<typeof processCollectionFilterSimulationBatch>>
      | undefined;
    for (let index = 0; index < 20; index += 1) {
      const result = await processCollectionFilterSimulationBatch(
        worker,
        {
          workerId: `stage5-test-${suffix}`,
          batchSize: 1000,
        },
      );
      if (
        result.state === 'COMPLETED' ||
        result.state === 'FAILED' ||
        result.state === 'IDLE'
      ) {
        terminal = result;
        if (result.state !== 'IDLE') break;
      }
    }

    assert.equal(terminal?.state, 'COMPLETED');

    const stored = await admin.query<{
      publication_id: string;
      decision: string;
      reason_code: string;
      review_sample: boolean;
    }>(
      `SELECT publication_id,decision,reason_code,review_sample
       FROM collection_filter_simulation_items
       WHERE simulation_id=$1
         AND publication_id=ANY($2::uuid[])
       ORDER BY publication_id`,
      [
        simulationId,
        [keepId, discardId, unknownId, doeId],
      ],
    );

    const byId = new Map(
      stored.rows.map((row) => [row.publication_id, row]),
    );
    assert.equal(byId.get(keepId)?.decision, 'KEEP');
    assert.equal(byId.get(discardId)?.decision, 'DISCARD');
    assert.equal(byId.get(unknownId)?.decision, 'KEEP');
    assert.equal(byId.get(unknownId)?.reason_code, 'UNKNOWN_TYPE');
    assert.equal(byId.has(doeId), false);
    assert.ok(
      [keepId, discardId, unknownId].every(
        (id) => byId.get(id)?.review_sample === true,
      ),
    );

    const state = await admin.query<{
      status: string;
      processed_count: string;
      metrics: {
        inspected?: number;
        keep?: number;
        discard?: number;
        unknownType?: number;
      };
    }>(
      `SELECT status,processed_count::text,metrics
       FROM collection_filter_simulations
       WHERE id=$1`,
      [simulationId],
    );
    assert.equal(state.rows[0]?.status, 'COMPLETED');
    assert.ok(Number(state.rows[0]?.processed_count ?? 0) >= 3);
    assert.ok((state.rows[0]?.metrics.keep ?? 0) >= 2);
    assert.ok((state.rows[0]?.metrics.discard ?? 0) >= 1);
    assert.ok((state.rows[0]?.metrics.unknownType ?? 0) >= 1);
  } finally {
    await admin.query(
      `DELETE FROM collection_filter_policies WHERE version=900001`,
    ).catch(() => undefined);
    if (createdPublicationIds.length) {
      await admin.query(
        `DELETE FROM publications WHERE id=ANY($1::uuid[])`,
        [createdPublicationIds],
      ).catch(() => undefined);
    }
    await admin.query(
      `DELETE FROM sources WHERE id=$1`,
      [sourceId],
    ).catch(() => undefined);
    if (insertedDoeSource) {
      await admin.query(
        `DELETE FROM sources WHERE code='doe-sp'`,
      ).catch(() => undefined);
    }
    await worker.destroy();
    await admin.end();
  }
});
