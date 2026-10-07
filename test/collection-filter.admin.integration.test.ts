import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');

const PASSWORD = 'Collection-Filter-Seguro-2026!';

async function registerAndLogin(
  app: FastifyInstance,
  label: string,
) {
  const email =
    `filter-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: `Filter ${label}`,
      email,
      company: `Filter ${label}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      acceptedTerms: true,
    },
  });
  assert.equal(register.statusCode, 201, register.body);
  const registered = register.json<{
    tenant: { id: string };
    user: { id: string };
  }>();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const { accessToken } =
    login.json<{ accessToken: string }>();

  return {
    userId: registered.user.id,
    email,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-tenant-id': registered.tenant.id,
    },
  };
}

test(
  'ACT-SCOPE-02 Stage 4: PLATFORM_ADMIN manages draft and new types safely',
  async () => {
    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });
    const app = await buildApp();

    const createdUserIds: string[] = [];
    try {
      await admin.query(
        `TRUNCATE collection_filter_simulations,
                  collection_filter_new_types,
                  collection_filter_terms,
                  collection_filter_type_aliases,
                  collection_filter_type_rules,
                  collection_filter_policies
         CASCADE`,
      );

      const platformAdmin = await registerAndLogin(app, 'admin');
      const ordinary = await registerAndLogin(app, 'ordinary');
      createdUserIds.push(
        platformAdmin.userId,
        ordinary.userId,
      );

      await admin.query(
        `INSERT INTO platform_user_roles (
           user_id, role, granted_by
         ) VALUES ($1, 'PLATFORM_ADMIN', 'act-scope-02-stage4-test')`,
        [platformAdmin.userId],
      );

      const denied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/collection-filter/state',
        headers: ordinary.headers,
      });
      assert.equal(denied.statusCode, 403, denied.body);

      const draft = {
        contextWindowWords: 7,
        weakScoreThreshold: 3,
        locationWeights: {
          title: 3,
          summary: 2,
          body: 1,
        },
        changeNotes: 'Rascunho inicial',
        rules: [
          {
            sourceCode: 'dou',
            section: 'DO1',
            canonicalType: 'PORTARIA',
            mode: 'KEEP_IF_TAX_TERM',
            helpText: 'Portarias dependem de relevância tributária.',
          },
          {
            sourceCode: 'confaz',
            section: '',
            canonicalType: 'CONVENIO ICMS',
            mode: 'KEEP_ALWAYS',
          },
        ],
        aliases: [
          {
            sourceCode: 'confaz',
            section: '',
            alias: 'Convênio ICMS',
            canonicalType: 'CONVENIO ICMS',
          },
        ],
        terms: [
          {
            text: 'ICMS',
            strength: 'STRONG',
          },
          {
            text: 'tributário',
            strength: 'WEAK',
            locationScope: 'ANY',
          },
          {
            text: 'regularidade fiscal',
            strength: 'NEGATIVE',
            locationScope: 'BODY',
          },
        ],
      };

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/collection-filter/draft',
        headers: platformAdmin.headers,
        payload: draft,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().version, 1);
      assert.equal(saved.json().revision, 1);

      const state = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/collection-filter/state',
        headers: platformAdmin.headers,
      });
      assert.equal(state.statusCode, 200, state.body);
      const stateJson = state.json<{
        policies: Array<{
          id: string;
          status: string;
          revision: number;
        }>;
        documents: Record<
          string,
          {
            rules: unknown[];
            aliases: unknown[];
            terms: unknown[];
          }
        >;
      }>();
      assert.equal(stateJson.policies.length, 1);
      assert.equal(stateJson.policies[0]!.status, 'DRAFT');
      const policyId = stateJson.policies[0]!.id;
      assert.equal(
        stateJson.documents[policyId]!.rules.length,
        2,
      );
      assert.equal(
        stateJson.documents[policyId]!.aliases.length,
        1,
      );
      assert.equal(
        stateJson.documents[policyId]!.terms.length,
        3,
      );

      const updated = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/collection-filter/draft',
        headers: platformAdmin.headers,
        payload: {
          ...draft,
          changeNotes: 'Segunda revisão',
        },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(updated.json().version, 1);
      assert.equal(updated.json().revision, 2);

      const simulation = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/collection-filter/simulations',
        headers: platformAdmin.headers,
        payload: {
          policyId,
          scope: 'FULL_ARCHIVE',
          reviewMode: 'SAMPLE',
        },
      });
      assert.equal(simulation.statusCode, 200, simulation.body);
      assert.equal(simulation.json().action, 'CREATED');
      assert.equal(simulation.json().policyRevision, 2);

      const sameSimulation = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/collection-filter/simulations',
        headers: platformAdmin.headers,
        payload: {
          policyId,
          scope: 'FULL_ARCHIVE',
          reviewMode: 'SAMPLE',
        },
      });
      assert.equal(
        sameSimulation.statusCode,
        200,
        sameSimulation.body,
      );
      assert.equal(sameSimulation.json().action, 'EXISTING');
      assert.equal(
        sameSimulation.json().simulationId,
        simulation.json().simulationId,
      );

      const prematureApproval = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/collection-filter/approve',
        headers: platformAdmin.headers,
        payload: { policyId },
      });
      assert.equal(
        prematureApproval.statusCode,
        409,
        prematureApproval.body,
      );
      assert.equal(
        prematureApproval.json().error,
        'collection_filter_fresh_simulation_required',
      );

      const unsafe = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/collection-filter/draft',
        headers: platformAdmin.headers,
        payload: {
          ...draft,
          terms: [
            {
              text: 'CNPJ',
              strength: 'STRONG',
            },
          ],
        },
      });
      assert.equal(unsafe.statusCode, 400, unsafe.body);
      assert.equal(
        unsafe.json().error,
        'invalid_collection_filter_draft',
      );

      const doeRejected = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/collection-filter/draft',
        headers: platformAdmin.headers,
        payload: {
          ...draft,
          rules: [
            {
              sourceCode: 'doe-sp',
              section: '',
              canonicalType: 'PORTARIA',
              mode: 'KEEP_ALWAYS',
            },
          ],
        },
      });
      assert.equal(doeRejected.statusCode, 400, doeRejected.body);
      assert.equal(
        doeRejected.json().error,
        'invalid_collection_filter_draft',
      );

      const requested = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/simulations`,
        headers: platformAdmin.headers,
        payload: {
          scope: 'FULL_ARCHIVE',
          reviewMode: 'SAMPLE',
        },
      });
      assert.equal(requested.statusCode, 202, requested.body);
      const requestedJson = requested.json<{
        simulationId: string;
        policyRevision: number;
        action: string;
      }>();
      assert.equal(requestedJson.policyRevision, 2);
      assert.equal(requestedJson.action, 'CREATED');

      const repeated = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/simulations`,
        headers: platformAdmin.headers,
        payload: {
          scope: 'FULL_ARCHIVE',
          reviewMode: 'SAMPLE',
        },
      });
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(
        repeated.json().simulationId,
        requestedJson.simulationId,
      );
      assert.equal(repeated.json().action, 'EXISTING');

      const prematureApproval = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/approve`,
        headers: platformAdmin.headers,
      });
      assert.equal(
        prematureApproval.statusCode,
        409,
        prematureApproval.body,
      );
      assert.equal(
        prematureApproval.json().error,
        'collection_filter_fresh_simulation_required',
      );

      const simulatedPublicationId = randomUUID();
      await admin.query(
        `UPDATE collection_filter_simulations
            SET status='COMPLETED',
                metrics='{"inspected":1,"keep":0,"discard":1}'::jsonb,
                completed_at=now()
          WHERE id=$1::uuid`,
        [requestedJson.simulationId],
      );
      await admin.query(
        `INSERT INTO collection_filter_simulation_items(
           simulation_id,publication_id,source_code,section,
           raw_type,canonical_type,decision,reason_code,
           decisive_term,excerpt,title,published_on,official_url,review_sample
         ) VALUES(
           $1::uuid,$2::uuid,'dou','DO1',
           'PORTARIA','PORTARIA','DISCARD','weak_score_below_threshold',
           NULL,'trecho','Portaria de teste','2026-10-06',
           'https://example.test/ato',true
         )`,
        [requestedJson.simulationId, simulatedPublicationId],
      );

      const sample = await app.inject({
        method: 'GET',
        url:
          `/api/v1/admin/collection-filter/simulations/${requestedJson.simulationId}/items?sampleOnly=true`,
        headers: platformAdmin.headers,
      });
      assert.equal(sample.statusCode, 200, sample.body);
      assert.equal(sample.json().items.length, 1);

      const markedError = await app.inject({
        method: 'PUT',
        url:
          `/api/v1/admin/collection-filter/simulations/${requestedJson.simulationId}/items/${simulatedPublicationId}/feedback`,
        headers: platformAdmin.headers,
        payload: {
          markedError: true,
          expectedDecision: 'KEEP',
          note: 'Falso descarte no teste.',
        },
      });
      assert.equal(markedError.statusCode, 200, markedError.body);

      const blockedByError = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/approve`,
        headers: platformAdmin.headers,
      });
      assert.equal(blockedByError.statusCode, 409, blockedByError.body);
      assert.equal(
        blockedByError.json().error,
        'collection_filter_simulation_has_errors',
      );

      const clearedError = await app.inject({
        method: 'PUT',
        url:
          `/api/v1/admin/collection-filter/simulations/${requestedJson.simulationId}/items/${simulatedPublicationId}/feedback`,
        headers: platformAdmin.headers,
        payload: {
          markedError: false,
          expectedDecision: 'KEEP',
          note: 'Revisado para continuar o teste de stale simulation.',
        },
      });
      assert.equal(clearedError.statusCode, 200, clearedError.body);

      const editedAfterSimulation = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/collection-filter/draft',
        headers: platformAdmin.headers,
        payload: {
          ...draft,
          changeNotes: 'Terceira revisão após simulação',
        },
      });
      assert.equal(
        editedAfterSimulation.statusCode,
        200,
        editedAfterSimulation.body,
      );
      assert.equal(editedAfterSimulation.json().revision, 3);

      const staleSimulation = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/approve`,
        headers: platformAdmin.headers,
      });
      assert.equal(staleSimulation.statusCode, 409, staleSimulation.body);
      assert.equal(
        staleSimulation.json().error,
        'collection_filter_fresh_simulation_required',
      );

      const freshRequested = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/simulations`,
        headers: platformAdmin.headers,
        payload: {
          scope: 'FULL_ARCHIVE',
          reviewMode: 'NONE',
        },
      });
      assert.equal(freshRequested.statusCode, 202, freshRequested.body);
      assert.equal(freshRequested.json().policyRevision, 3);

      await admin.query(
        `UPDATE collection_filter_simulations
            SET status='COMPLETED',
                metrics='{"inspected":1,"keep":1,"discard":0}'::jsonb,
                completed_at=now()
          WHERE id=$1::uuid`,
        [freshRequested.json().simulationId],
      );

      const approved = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/drafts/${policyId}/approve`,
        headers: platformAdmin.headers,
      });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json().version, 1);
      assert.equal(approved.json().revision, 3);
      assert.equal(
        approved.json().simulationId,
        freshRequested.json().simulationId,
      );

      const newTypeId = randomUUID();
      await admin.query(
        `INSERT INTO collection_filter_new_types (
           id,source_code,section,normalized_type,
           sample_raw_type,occurrence_count,sample_publication_ids
         ) VALUES (
           $1,'dou','DO1','ATO DESCONHECIDO',
           'Ato desconhecido',4,'{}'
         )`,
        [newTypeId],
      );

      const inbox = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/collection-filter/new-types',
        headers: platformAdmin.headers,
      });
      assert.equal(inbox.statusCode, 200, inbox.body);
      assert.equal(inbox.json().items.length, 1);
      assert.equal(
        inbox.json().items[0].normalized_type,
        'ATO DESCONHECIDO',
      );

      const resolved = await app.inject({
        method: 'POST',
        url:
          `/api/v1/admin/collection-filter/new-types/${newTypeId}/resolve`,
        headers: platformAdmin.headers,
        payload: { status: 'RESOLVED', canonicalType: 'ATO DESCONHECIDO' },
      });
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.equal(resolved.json().status, 'RESOLVED');

      const openAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/collection-filter/new-types',
        headers: platformAdmin.headers,
      });
      assert.equal(openAfter.statusCode, 200, openAfter.body);
      assert.equal(openAfter.json().items.length, 0);
    } finally {
      await admin.query(
        `TRUNCATE collection_filter_simulations,
                  collection_filter_new_types,
                  collection_filter_terms,
                  collection_filter_type_aliases,
                  collection_filter_type_rules,
                  collection_filter_policies
         CASCADE`,
      ).catch(() => undefined);

      if (createdUserIds.length > 0) {
        await admin.query(
          `UPDATE platform_user_roles
           SET revoked_at = COALESCE(revoked_at, now()),
               revoked_by = COALESCE(
                 revoked_by,
                 'act-scope-02-stage4-test-cleanup'
               )
           WHERE user_id = ANY($1::uuid[])
             AND revoked_at IS NULL`,
          [createdUserIds],
        ).catch(() => undefined);
      }

      await app.close();
      await admin.end();
    }
  },
);
