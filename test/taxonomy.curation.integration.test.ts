import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  classifySinglePublication,
  processPublicationTaxonomyBatch,
  resetClassificationConceptCache,
} from '../src/modules/taxonomy/classification/classification.worker.js';
import { processPublicationNcmEnrichmentBatch } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';
import { checkWorkerConcurrency } from './worker-concurrency.checks.js';
import {
  loadProductSheet,
  parseProductSheet,
} from '../src/modules/taxonomy/curation/curation.product-load.js';
import {
  retireDimension,
  withCuratorTransaction,
} from '../src/modules/taxonomy/curation/curation.draft.js';
import { mergeDimension } from '../src/modules/taxonomy/curation/curation.merge-dimension.js';
import { findOpenDraft, loadReleaseView, pgRunner } from '../src/modules/taxonomy/curation/curation.read.js';
import { updateDraftTaxonomyCodeCompatibility } from '../src/modules/taxonomy/taxonomy-code-compatibility.js';

/**
 * TAX-11 end-to-end gate. Runs as a dedicated, final CI step: it commits a
 * high-numbered fixture release (v70.x) that becomes the latest PUBLISHED
 * release of the disposable CI database.
 */

const adminUrl = process.env.DATABASE_ADMIN_URL;
const workerPassword =
  process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!adminUrl || !workerPassword) {
  throw new Error('DATABASE_ADMIN_URL and runtime passwords are required');
}
if (!process.env.DB_CURATOR_RUNTIME_PASSWORD) {
  throw new Error('DB_CURATOR_RUNTIME_PASSWORD is required for the curation gate');
}

const PASSWORD = 'Curadoria-Segura-2026!';
let MAJOR = 70;

function workerUrl(): string {
  const url = new URL(adminUrl!);
  url.username = 'radar_worker_runtime';
  url.password = workerPassword!;
  return url.toString();
}

async function registerAndLogin(app: FastifyInstance, label: string) {
  const email = `curation-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: `Curadoria ${label}`,
      email,
      company: `Curadoria ${label}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      acceptedTerms: true,
    },
  });
  assert.equal(register.statusCode, 201, register.body);
  const registered = register.json<{ tenant: { id: string }; user: { id: string } }>();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const { accessToken } = login.json<{ accessToken: string }>();
  return {
    userId: registered.user.id,
    tenantId: registered.tenant.id,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-tenant-id': registered.tenant.id,
    },
  };
}

async function insertFixtureRelease(admin: Pool): Promise<string> {
  const latest = await admin.query<{ major: number | null }>(
    'SELECT max(version_major)::int AS major FROM taxonomy_releases',
  );
  MAJOR = Math.max(70, (latest.rows[0]?.major ?? 0) + 1);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const release = await client.query<{ id: string }>(
      `INSERT INTO taxonomy_releases (
         version_major, version_minor, version_patch, status, manifest,
         change_notes, created_by_actor
       ) VALUES ($1, 0, 0, 'DRAFT', '{"fixture":"tax-11"}', 'TAX-11 fixture', 'tax-11-test')
       RETURNING id`,
      [MAJOR],
    );
    const releaseId = release.rows[0]!.id;

    const dimensions: Array<[string, string, Array<[string, string]>]> = [
      ['product', 'Produto', [
        ['urea', 'Ureia'],
        ['rice', 'Arroz'],
        ['soy', 'Soja'],
        ['fertilizers', 'Fertilizantes'],
      ]],
      ['sector', 'Setor', [['agribusiness', 'Agronegócio']]],
      ['document', 'Documento', [['nfe', 'NF-e; 55']]],
      ['theme', 'Tema', [['presumed_credit', 'Crédito presumido']]],
      ['act_type', 'Tipo de ato', [['law', 'Lei']]],
    ];

    for (const [code, name, concepts] of dimensions) {
      const dimension = await client.query<{ id: string }>(
        `INSERT INTO taxonomy_dimensions (code) VALUES ($1)
         ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id`,
        [code],
      );
      const dimensionId = dimension.rows[0]!.id;
      const revision = await client.query<{ id: string }>(
        `INSERT INTO taxonomy_dimension_revisions (dimension_id, revision_no, name)
         SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, $2
         FROM taxonomy_dimension_revisions WHERE dimension_id = $1::uuid
         RETURNING id`,
        [dimensionId, name],
      );
      await client.query(
        `INSERT INTO taxonomy_release_dimensions (release_id, dimension_id, dimension_revision_id)
         VALUES ($1, $2, $3)`,
        [releaseId, dimensionId, revision.rows[0]!.id],
      );

      for (const [suffix, label] of concepts) {
        const concept = await client.query<{ id: string }>(
          `INSERT INTO taxonomy_concepts (code, dimension_id) VALUES ($1, $2)
           ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
           RETURNING id`,
          [`${code}.${suffix}`, dimensionId],
        );
        const conceptRevision = await client.query<{ id: string }>(
          `INSERT INTO taxonomy_concept_revisions (concept_id, revision_no, label, definition)
           SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, $2, $3
           FROM taxonomy_concept_revisions WHERE concept_id = $1::uuid
           RETURNING id`,
          [concept.rows[0]!.id, label, `Definição de ${label}`],
        );
        await client.query(
          `INSERT INTO taxonomy_release_concepts (release_id, concept_id, concept_revision_id)
           VALUES ($1, $2, $3)`,
          [releaseId, concept.rows[0]!.id, conceptRevision.rows[0]!.id],
        );
      }
    }

    await client.query(
      `UPDATE taxonomy_releases
       SET status = 'PUBLISHED', approved_at = now(), published_at = now(),
           artifact_repository = 'test', artifact_path = 'tax-11',
           artifact_git_sha = $2, artifact_sha256 = $3
       WHERE id = $1`,
      [releaseId, '0'.repeat(40), '0'.repeat(64)],
    );
    await client.query('COMMIT');
    return releaseId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createPublication(admin: Pool, title: string, text: string) {
  const publication = await admin.query<{ id: string }>(
    `INSERT INTO publications (
       identity_hash, identity_strength, identity_basis,
       jurisdiction_level, title, published_on
     ) VALUES ($1, 'STRONG', '{}'::jsonb, 'FEDERAL', $2, CURRENT_DATE)
     RETURNING id`,
    [createHash('sha256').update(randomUUID()).digest('hex'), title],
  );
  const publicationId = publication.rows[0]!.id;
  const version = await admin.query<{ id: string }>(
    `INSERT INTO publication_versions (
       publication_id, version_no, content_hash, content_text, is_current
     ) VALUES ($1::uuid, 1, $2, $3, TRUE)
     RETURNING id`,
    [publicationId, createHash('sha256').update(text).digest('hex'), text],
  );
  return { publicationId, versionId: version.rows[0]!.id };
}

test('TAX-11 curation: draft, tables, publication, profile, classification and tags', async (t) => {
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const worker = createStandaloneDatabase({
    connectionString: workerUrl(),
    poolMax: 1,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
  });
  const app = await buildApp();

  try {
    assert.ok(app.curatorPool, 'curator pool must be configured');
    // Start from the migration defaults regardless of earlier runs.
    await admin.query(
      `UPDATE taxonomy_runtime_settings
       SET value = CASE key
         WHEN 'classification_enabled' THEN 'false'::jsonb
         ELSE '["doe-sp"]'::jsonb END,
           updated_by = 'tax-11-test'`,
    );
    await insertFixtureRelease(admin);

    const curator = await registerAndLogin(app, 'curator');
    const customer = await registerAndLogin(app, 'customer');
    await admin.query(
      `INSERT INTO platform_user_roles (user_id, role, granted_by)
       VALUES
         ($1, 'TAXONOMY_CURATOR', 'tax-11-test'),
         ($1, 'PLATFORM_ADMIN', 'tax-11-test')`,
      [curator.userId],
    );

    // Access control
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/taxonomy/state',
      headers: customer.headers,
    });
    assert.equal(denied.statusCode, 403);
    const meCustomer = await app.inject({ method: 'GET', url: '/api/v1/admin/me', headers: customer.headers });
    assert.equal(meCustomer.json().taxonomyCurator, false);
    const meCurator = await app.inject({ method: 'GET', url: '/api/v1/admin/me', headers: curator.headers });
    assert.deepEqual(meCurator.json(), {
      platformAdmin: true,
      taxonomyCurator: true,
      licenseBypass: true,
      curatorDatabase: true,
    });

    const state = await app.inject({ method: 'GET', url: '/api/v1/admin/taxonomy/state', headers: curator.headers });
    assert.equal(state.statusCode, 200, state.body);
    assert.equal(state.json().published.version, `v${MAJOR}.0.0`);
    assert.equal(state.json().draft, null);
    assert.equal(state.json().settings.classificationEnabled, false);
    assert.deepEqual(state.json().settings.classificationExcludedSources, []);

    // Justification is mandatory
    const noJustification = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts',
      headers: curator.headers,
      payload: { justification: '' },
    });
    assert.equal(noJustification.statusCode, 400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts',
      headers: curator.headers,
      payload: { justification: 'Primeira curadoria TAX-11' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const draft = created.json();
    assert.equal(draft.draft.version, `v${MAJOR}.1.0`);
    assert.equal(draft.initialCuration.labelsFixed, 1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts',
      headers: curator.headers,
      payload: { justification: 'Outro rascunho' },
    });
    assert.equal(second.statusCode, 409);

    const draftView = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`,
        headers: curator.headers,
      })
    ).json();
    const nfe = draftView.concepts.find((c: { code: string }) => c.code === 'document.nfe');
    assert.equal(nfe.label, 'NF-e');
    assert.deepEqual(nfe.officialCodes, ['55']);
    assert.equal(nfe.groupCode, 'mercadorias');
    const law = draftView.concepts.find((c: { code: string }) => c.code === 'act_type.law');
    assert.equal(law.classifyByLabel, false);
    const rice = draftView.concepts.find((c: { code: string }) => c.code === 'product.rice');
    assert.deepEqual(rice.officialCodes, ['1006']);
    const fertGroup = draftView.groups.find((g: { code: string }) => g.code === 'fertilizantes');
    assert.deepEqual(fertGroup.segmentCodes, ['sector.agribusiness']);
    const product = draftView.dimensions.find((d: { code: string }) => d.code === 'product');
    assert.equal(product.officialCodeType, 'NCM');
    assert.equal(product.profileVisible, true);

    // Edit an item: synonyms + NCM (normalized)
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/taxonomy/drafts/current/concepts/product.urea',
      headers: curator.headers,
      payload: {
        justification: 'NCM e sinônimo',
        officialCodes: ['3102.10'],
        aliases: [{ text: 'carbamida', aliasType: 'EXACT_LEXICAL' }],
      },
    });
    assert.equal(edited.statusCode, 204, edited.body);

    const invalidCode = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/taxonomy/drafts/current/concepts/product.urea',
      headers: curator.headers,
      payload: { justification: 'NCM de 3 dígitos inválido (5/7 são válidos)', officialCodes: ['310'] },
    });
    assert.equal(invalidCode.statusCode, 400);

    // Spreadsheet import with a blank NCM and a new group
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/dimensions/product/import',
      headers: curator.headers,
      payload: {
        justification: 'Planilha de produtos',
        csv: [
          'Segmento;Grupo;Item;Código oficial;Sinônimos;No perfil;Código TriBusca',
          'Agronegócio;Fertilizantes e corretivos;Cloreto de potássio;3104.20;"KCl, potassa";✓;',
          'Agronegócio;Defensivos e adjuvantes;Espalhante adesivo;;adjuvante;✓;',
          'Agronegócio;Grãos novos;Soja;;;não;product.soy',
        ].join('\n'),
      },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().created, 2);
    assert.equal(imported.json().updated, 1);
    assert.equal(imported.json().groupsCreated, 1);
    assert.deepEqual(imported.json().errors, []);

    const sectorDraft = draftView.dimensions.find((d: { code: string }) => d.code === 'sector');
    assert.equal(sectorDraft.name, 'Segmento', 'initial curation renames Setor');

    // A sheet without the code/synonym columns must not erase curated data.
    const partial = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/dimensions/product/import',
      headers: curator.headers,
      payload: { justification: 'Só perfil', csv: 'Item;No perfil;Código TriBusca\nUreia;✓;product.urea' },
    });
    assert.equal(partial.statusCode, 200, partial.body);
    const afterPartial = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`,
        headers: curator.headers,
      })
    ).json();
    const urea = afterPartial.concepts.find((c: { code: string }) => c.code === 'product.urea');
    assert.deepEqual(urea.officialCodes, ['310210']);
    assert.ok(urea.aliases.some((a: { text: string }) => a.text === 'carbamida'));
    assert.equal(urea.groupCode, 'fertilizantes');

    // Spreadsheet-like editor: batch save, generated unique codes, retire.
    const gridUrl = '/api/v1/admin/taxonomy/drafts/current/dimensions/product/rows';
    const gridRow = (label: string, extra: Record<string, unknown> = {}) => ({
      code: null,
      group: 'Fertilizantes e corretivos',
      label,
      officialCodes: [],
      aliases: [
        { text: `${label} em pó`, aliasType: 'EXACT_LEXICAL' },
        { text: `${label} agrícola`, aliasType: 'EXACT_LEXICAL' },
      ],
      profileVisible: true,
      classifyByLabel: true,
      displayOrder: null,
      ...extra,
    });
    const gridSaved = await app.inject({
      method: 'POST',
      url: gridUrl,
      headers: curator.headers,
      payload: {
        justification: 'Grade',
        rows: [
          gridRow('Gesso', {
            aliases: [
              { text: 'Gesso em pó', aliasType: 'EXACT_LEXICAL' },
              { text: 'CaSO4', aliasType: 'ABBREVIATION' },
            ],
          }),
          gridRow('Gesso!'),
        ],
        retire: [],
      },
    });
    assert.equal(gridSaved.statusCode, 200, gridSaved.body);
    assert.deepEqual(gridSaved.json().created, ['product.gesso', 'product.gesso_2']);

    const gridAtomic = await app.inject({
      method: 'POST',
      url: gridUrl,
      headers: curator.headers,
      payload: {
        justification: 'Grade',
        rows: [gridRow('Calcário'), gridRow('Ureia', { code: 'product.urea', officialCodes: ['310'] })],
        retire: ['product.gesso_2'],
      },
    });
    assert.equal(gridAtomic.statusCode, 400, gridAtomic.body);
    assert.match(gridAtomic.json().message, /Linha 2/);
    const afterGrid = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`,
        headers: curator.headers,
      })
    ).json();
    // Segmento column of the grid: a group's segment must be an item of the
    // Segmento table, never a CNAE activity (7-digit) nor a retired item.
    {
      const activity = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/taxonomy/drafts/current/dimensions/sector/rows',
        headers: curator.headers,
        payload: {
          justification: 'Atividade CNAE',
          rows: [
            {
              code: null,
              group: null,
              label: 'Cultivo de arroz (teste)',
              officialCodes: ['0111301'],
              aliases: [],
              profileVisible: false,
              classifyByLabel: false,
              displayOrder: null,
            },
          ],
          retire: [],
        },
      });
      assert.equal(activity.statusCode, 200, activity.body);
      const activityCode = activity.json().created[0] as string;
      const segmentSave = (segmentCodes: string[]) =>
        app.inject({
          method: 'POST',
          url: gridUrl,
          headers: curator.headers,
          payload: {
            justification: 'Segmento do grupo',
            rows: [],
            retire: [],
            groupSegments: [{ group: 'fertilizantes e corretivos', segmentCodes }],
          },
        });
      const notSegment = await segmentSave([activityCode]);
      assert.equal(notSegment.statusCode, 400, notSegment.body);
      assert.match(notSegment.json().message, /não é segmento/);
      const unknown = await segmentSave(['sector.nao_existe']);
      assert.equal(unknown.statusCode, 400, unknown.body);
      assert.match(unknown.json().message, /tabela Segmento/);
      const linked = await segmentSave(['sector.agribusiness']);
      assert.equal(linked.statusCode, 200, linked.body);
      assert.equal(linked.json().groupsUpdated, 1);
      const retired = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/taxonomy/drafts/current/dimensions/sector/rows',
        headers: curator.headers,
        payload: { justification: 'Remove atividade de teste', rows: [], retire: [activityCode] },
      });
      assert.equal(retired.statusCode, 200, retired.body);
    }
    const gesso = afterGrid.concepts.find((c: { code: string }) => c.code === 'product.gesso');
    assert.equal(gesso.aliases.length, 2, 'several synonyms per row');
    assert.ok(
      !afterGrid.concepts.some((c: { label: string }) => c.label === 'Calcário'),
      'a failing row rolls back the whole save',
    );

    const gridRetire = await app.inject({
      method: 'POST',
      url: gridUrl,
      headers: curator.headers,
      payload: { justification: 'Grade', rows: [], retire: ['product.gesso_2'] },
    });
    assert.equal(gridRetire.statusCode, 200, gridRetire.body);
    assert.equal(gridRetire.json().retired, 1);

    // CSV rows without "Código TriBusca" get a code generated from the item.
    const blankCode = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/dimensions/product/import',
      headers: curator.headers,
      payload: {
        justification: 'Carga massiva',
        csv: [
          'Grupo;Item;Classificar pelo nome;Código TriBusca',
          'Fertilizantes e corretivos;Termofosfato;x;',
          'Fertilizantes e corretivos;Gesso;x;',
          'Fertilizantes e corretivos;Gesso;;product.gesso',
          'Fertilizantes e corretivos;Inexistente;;product.nao_existe',
        ].join('\n'),
      },
    });
    assert.equal(blankCode.statusCode, 200, blankCode.body);
    assert.equal(blankCode.json().created, 2, 'blank TriBusca code always creates');
    assert.equal(blankCode.json().updated, 1, 'filled TriBusca code updates that item');
    assert.equal(blankCode.json().errors.length, 1, 'unknown TriBusca code is refused');
    assert.match(blankCode.json().errors[0].message, /não existe nesta tabela/);
    assert.equal(blankCode.json().warnings.length, 1, 'same name as an existing item is flagged');
    assert.match(blankCode.json().warnings[0].message, /já existia \(product\.gesso\)/);
    const createdAfterBlank = (
      await app.inject({ method: 'GET', url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`, headers: curator.headers })
    ).json();
    assert.ok(createdAfterBlank.concepts.some((c: { code: string }) => c.code === 'product.termofosfato'));
    assert.ok(createdAfterBlank.concepts.some((c: { code: string }) => c.code === 'product.gesso_3'), 'next free code');

    const dimensionPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/taxonomy/drafts/current/dimensions/sector',
      headers: curator.headers,
      payload: { justification: 'Ajuda', helpText: 'Onde a empresa atua.' },
    });
    assert.equal(dimensionPatch.statusCode, 204, dimensionPatch.body);

    const searchOnly = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/taxonomy/drafts/current/concepts/product.urea',
      headers: curator.headers,
      payload: {
        justification: 'Sinônimo legado',
        aliases: [
          { text: 'carbamida', aliasType: 'EXACT_LEXICAL' },
          { text: 'adubo nitrogenado', aliasType: 'SEARCH_RELATED' },
        ],
      },
    });
    assert.equal(searchOnly.statusCode, 204, searchOnly.body);

    const review = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/taxonomy/drafts/current/review',
      headers: curator.headers,
    });
    assert.equal(review.statusCode, 200, review.body);
    const diff = review.json().diff;
    assert.ok(diff.addedConcepts.includes('product.cloreto_de_potassio'));
    assert.ok(diff.changedConcepts.some((c: { code: string }) => c.code === 'document.nfe'));
    assert.ok(diff.changedDimensions.some((d: { code: string }) => d.code === 'sector'));
    assert.ok(!review.json().issues.some((i: { severity: string }) => i.severity === 'BLOCKER'));
    const synonymWarnings = review
      .json()
      .issues.filter((i: { code: string }) => i.code === 'SYNONYM_WAS_NOT_AUTOMATIC');
    assert.ok(
      synonymWarnings.some((i: { message: string }) => /“adubo nitrogenado” \(só busca no dicionário\)/.test(i.message)),
      JSON.stringify(synonymWarnings.slice(0, 3)),
    );
    assert.ok(synonymWarnings.every((i: { severity: string }) => i.severity === 'WARNING'), 'warning, not a blocker');

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}/dimensions/product/export.csv`,
      headers: curator.headers,
    });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.body, /Cloreto de potássio;3104\.20;KCl, potassa;x/);
    assert.ok(!exported.body.includes('✓'), 'export marks with x, easy to type back');

    // Exporting and importing the same sheet back changes nothing: same
    // items (matched by TriBusca code), same synonym types, no duplicates.
    const beforeRoundTrip = (
      await app.inject({ method: 'GET', url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`, headers: curator.headers })
    ).json();
    const roundTrip = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/dimensions/product/import',
      headers: curator.headers,
      payload: { justification: 'Ida e volta', csv: exported.body },
    });
    assert.equal(roundTrip.statusCode, 200, roundTrip.body);
    assert.equal(roundTrip.json().created, 0, 'no duplicates on round trip');
    assert.deepEqual(roundTrip.json().errors, []);
    const afterRoundTrip = (
      await app.inject({ method: 'GET', url: `/api/v1/admin/taxonomy/releases/${draft.draft.id}`, headers: curator.headers })
    ).json();
    const pick = (view: { concepts: Array<Record<string, unknown>> }) =>
      view.concepts
        .filter((c) => c.dimensionCode === 'product')
        .map((c) => ({
          code: c.code,
          label: c.label,
          groupCode: c.groupCode,
          officialCodes: c.officialCodes,
          profileVisible: c.profileVisible,
          classifyByLabel: c.classifyByLabel,
          displayOrder: c.displayOrder,
          aliases: [...(c.aliases as Array<{ text: string; aliasType: string }>)].sort((x, y) =>
            x.text.localeCompare(y.text),
          ),
        }))
        .sort((x, y) => String(x.code).localeCompare(String(y.code)));
    assert.deepEqual(pick(afterRoundTrip), pick(beforeRoundTrip));

    // Bulk load of the PO's product sheet: the sheet is the latest truth
    // (rolled back here so the rest of the gate keeps its fixture).
    {
      const client = await app.curatorPool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const load = await loadProductSheet(
          client,
          { userId: randomUUID(), justification: 'Carga da planilha' },
          parseProductSheet(
            [
              '\uFEFFSegmento;Grupo;Item',
              'Agronegocio;Fertilizantes, corretivos e substratos;ureias',
              'Agronegocio;Fertilizantes, corretivos e substratos;MAP (mono-amônio fosfato)',
              'Agronegocio;Grãos e Cereais;arroz',
              'Agronegocio;Grãos e Cereais;Arroz',
            ].join('\r\n'),
          ),
        );
        assert.deepEqual(load.errors, []);
        assert.equal(load.sheetRows, 4);
        assert.deepEqual(load.sheetDuplicates, [{ line: 4, item: 'arroz', replacedByLine: 5 }]);
        assert.deepEqual(
          load.matched.map((m) => [m.code, m.item]).sort(),
          [['product.rice', 'Arroz'], ['product.urea', 'Ureias']],
        );
        assert.equal(load.updated, 2);
        assert.equal(load.created, 1);
        assert.equal(load.groupsCreated, 2);
        assert.equal(load.groupsLinkedToSegment.length, 2);

        const { findOpenDraft, loadReleaseView, pgRunner } = await import('../src/modules/taxonomy/curation/curation.read.js');
        const open = await findOpenDraft(pgRunner(client));
        const view = await loadReleaseView(pgRunner(client), open!.id);
        const urea = view!.concepts.find((c) => c.code === 'product.urea')!;
        const fertGroup = view!.groups.find((g) => g.label === 'Fertilizantes, corretivos e substratos')!;
        assert.equal(urea.label, 'Ureias');
        assert.equal(urea.groupId, fertGroup.id);
        assert.ok(urea.aliases.some((a) => a.text === 'Ureia'), 'previous name kept as synonym');
        assert.deepEqual(fertGroup.segmentCodes, ['sector.agribusiness']);
        assert.ok(view!.concepts.some((c) => c.label === 'MAP (mono-amônio fosfato)' && c.groupId === fertGroup.id));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    // Old baseline segments retire once their groups move to the TriFaros
    // Segmento table (rolled back here too).
    {
      const client = await app.curatorPool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const actor = { userId: randomUUID(), justification: 'Segmentos antigos' };
        const { createConcept } = await import('../src/modules/taxonomy/curation/curation.draft.js');
        const { retireLegacySegments, LEGACY_SEGMENT_TARGETS } = await import(
          '../src/modules/taxonomy/curation/curation.legacy-segments.js'
        );
        const blocked = await retireLegacySegments(client, actor);
        assert.ok(blocked.missingTargets.includes('sector.trifaros_agro'), 'nothing moves without the new segments');
        for (const id of new Set(Object.values(LEGACY_SEGMENT_TARGETS))) {
          await createConcept(client, actor, 'sector', {
            code: `sector.trifaros_${id}`,
            label: `TriFaros ${id}`,
            definition: `Segmento ${id}`,
            officialCodes: [],
            aliases: [],
            classifyByLabel: false,
          });
        }
        const done = await retireLegacySegments(client, actor);
        assert.deepEqual(done.missingTargets, []);
        assert.ok(done.retire.includes('sector.agribusiness'));
        const { findOpenDraft, loadReleaseView, pgRunner } = await import('../src/modules/taxonomy/curation/curation.read.js');
        const open = await findOpenDraft(pgRunner(client));
        const view = await loadReleaseView(pgRunner(client), open!.id);
        assert.ok(!view!.concepts.some((c) => c.code === 'sector.agribusiness'), 'old item retired');
        const fert = view!.groups.find((g) => g.code === 'fertilizantes')!;
        assert.ok(fert.segmentCodes.includes('sector.trifaros_agro'));
        assert.ok(view!.groups.every((g) => g.segmentCodes.every((code) => !code.startsWith('sector.') || code.startsWith('sector.trifaros_'))));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    await withCuratorTransaction(app.curatorPool!, async (client) => {
      const open = await findOpenDraft(pgRunner(client));
      assert.ok(open);
      await updateDraftTaxonomyCodeCompatibility(client, open!.id, {
        redirects: {
          'treatment.presumed_credit': 'theme.presumed_credit',
        },
        retiredCodes: ['platform.sped', 'tax_species.tax'],
      });
    });

    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/publish',
      headers: curator.headers,
      payload: { justification: 'Revisado', changeNotes: 'Primeira versão curada' },
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().release.status, 'PUBLISHED');
    assert.match(published.json().snapshotSha256, /^[a-f0-9]{64}$/);

    // Published snapshot is immutable, even for the curator role.
    const guard = await admin.connect();
    try {
      await guard.query('BEGIN');
      await guard.query('SET LOCAL ROLE radar_taxonomy_curator');
      await assert.rejects(
        guard.query(
          `UPDATE taxonomy_release_concepts SET profile_visible = false
           WHERE release_id = $1`,
          [draft.draft.id],
        ),
        /immutable/,
      );
    } finally {
      await guard.query('ROLLBACK').catch(() => undefined);
      guard.release();
    }

    // Customer profile options follow the curated settings.
    const options = await app.inject({
      method: 'GET',
      url: '/api/v1/taxonomy/profile-options',
      headers: customer.headers,
    });
    assert.equal(options.statusCode, 200, options.body);
    const body = options.json();
    assert.equal(body.release.version, `v${MAJOR}.1.0`);
    const dims = body.dimensions.map((d: { code: string }) => d.code);
    assert.deepEqual(dims, ['sector', 'product', 'document']);
    assert.equal(body.dimensions[0].name, 'Segmento');
    const productOptions = body.dimensions[1];
    assert.ok(productOptions.groups.some((g: { label: string }) => g.label === 'Fertilizantes e corretivos'));
    const productCodes = productOptions.concepts.map((c: { code: string }) => c.code);
    assert.ok(productCodes.includes('product.cloreto_de_potassio'));
    assert.ok(!productCodes.includes('product.soy'), 'hidden item is not offered');
    assert.ok(body.conceptCodes.includes('product.soy'), 'hidden item stays saveable');
    assert.ok(
      body.conceptIndex.some((c: { code: string; label: string }) => c.code === 'product.soy' && c.label === 'Soja'),
      'hidden item keeps its label for legacy profile fields',
    );
    assert.equal(body.dimensions[2].concepts[0].label, 'NF-e');
    // Segmento table and Produtos table for the CNAE / product pickers.
    assert.ok(body.segments.some((item: { code: string }) => item.code === 'sector.agribusiness'));
    const ureaOption = body.products.find((item: { code: string }) => item.code === 'product.urea');
    assert.equal(ureaOption.groupLabel, 'Fertilizantes e corretivos');
    assert.deepEqual(ureaOption.officialCodes, ['310210']);
    assert.ok(ureaOption.segmentCodes.includes('sector.agribusiness'));
    assert.ok(
      !body.products.some((item: { code: string }) => item.code === 'product.soy'),
      'hidden item is not offered to companies',
    );

    // Classification is disabled by default: the Worker does nothing.
    const { publicationId } = await createPublication(
      admin,
      'Portaria concede crédito presumido',
      'Fica concedido crédito presumido nas saídas de ureia e de arroz NCM 1006.30.11. Lei 1. adjuvante.',
    );
    await processPublicationNcmEnrichmentBatch(worker, { limit: 50 });
    resetClassificationConceptCache();
    const disabled = await processPublicationTaxonomyBatch(worker, { limit: 50 });
    assert.equal(disabled.skipped, 'DISABLED');

    const pendingView = await app.inject({
      method: 'GET',
      url: `/api/v1/publications/${publicationId}/taxonomy`,
      headers: customer.headers,
    });
    assert.equal(pendingView.json().status, 'DISABLED');

    // On-demand classification of ONE act works with the switch off:
    // a preview saves nothing; with persist the act shows its tags.
    {
      const releaseId = (await admin.query<{ id: string }>(
        `SELECT id FROM taxonomy_releases WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1`,
      )).rows[0]!.id;
      resetClassificationConceptCache();
      const preview = await classifySinglePublication(worker, { publicationId, releaseId, persist: false });
      assert.equal(preview.persisted, false);
      assert.ok(preview.ncmScanned);
      assert.ok(preview.tags.some((tag) => tag.conceptCode === 'product.urea'), JSON.stringify(preview.tags));
      const stillDisabled = await app.inject({
        method: 'GET',
        url: `/api/v1/publications/${publicationId}/taxonomy`,
        headers: customer.headers,
      });
      assert.equal(stillDisabled.json().status, 'DISABLED', 'a preview writes nothing');

      const other = await createPublication(admin, 'Convênio sobre ureia', 'Reduz a base de cálculo nas saídas de ureia.');
      await processPublicationNcmEnrichmentBatch(worker, { limit: 50 });
      const saved = await classifySinglePublication(worker, {
        publicationId: other.publicationId,
        releaseId,
        persist: true,
      });
      assert.equal(saved.persisted, true);
      assert.ok(saved.tags.some((tag) => tag.conceptCode === 'product.urea'), JSON.stringify(saved.tags));
      const classifiedOne = await app.inject({
        method: 'GET',
        url: `/api/v1/publications/${other.publicationId}/taxonomy`,
        headers: customer.headers,
      });
      assert.equal(classifiedOne.json().status, 'CLASSIFIED');
    }

    const enable = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/taxonomy/settings/classification',
      headers: curator.headers,
      payload: { justification: 'Tabelas revisadas', enabled: true },
    });
    assert.equal(enable.statusCode, 204);

    const batch = await processPublicationTaxonomyBatch(worker, { limit: 50 });
    assert.equal(batch.skipped, null);
    assert.ok(batch.succeeded >= 1, JSON.stringify(batch));

    const concurrencyRelease = (await admin.query<{ id: string }>(
      `SELECT id FROM taxonomy_releases WHERE status = 'PUBLISHED'
       ORDER BY version_major DESC, version_minor DESC, version_patch DESC LIMIT 1`,
    )).rows[0]!.id;
    await checkWorkerConcurrency(t, admin, workerUrl(), concurrencyRelease);

    const tags = await app.inject({
      method: 'GET',
      url: `/api/v1/publications/${publicationId}/taxonomy`,
      headers: customer.headers,
    });
    assert.equal(tags.statusCode, 200, tags.body);
    const tagView = tags.json();
    assert.equal(tagView.status, 'CLASSIFIED');
    const flat = tagView.sections.flatMap((s: { name: string; tags: Array<Record<string, unknown>> }) =>
      s.tags.map((t) => ({ section: s.name, ...t })),
    );
    const find = (code: string) => flat.find((t: { conceptCode: string }) => t.conceptCode === code);
    assert.equal(find('theme.presumed_credit').section, 'Benefícios e tratamentos');
    assert.equal(find('theme.presumed_credit').reason.type, 'TEXT');
    assert.equal(find('product.urea').section, 'Produtos');
    assert.equal(find('product.rice').reason.type, 'NCM');
    // What the site marks in the legislation text.
    assert.ok(find('theme.presumed_credit').highlight.terms.includes('Crédito presumido'));
    assert.deepEqual(find('theme.presumed_credit').highlight.ncmPrefixes, []);
    assert.ok(find('product.rice').highlight.ncmPrefixes.length > 0, 'products carry their NCM prefixes');
    assert.equal(find('product.rice').reason.term, '10063011');
    assert.equal(find('product.espalhante_adesivo').reason.type, 'SYNONYM');
    assert.equal(find('act_type.law'), undefined, 'generic label does not tag');
    // Segment served by the act, seen from its products (group → segment).
    assert.equal(find('sector.agribusiness').reason.type, 'PRODUCTS');
    assert.match(find('sector.agribusiness').reason.excerpt, /Ureia|Uréia/);

    // Affinity with the customer's company tax profile.
    {
      const company = await admin.query<{ id: string }>(
        `INSERT INTO companies (tenant_id, legal_name, head_office_cnpj)
         VALUES ($1::uuid, 'Agro Teste S.A.', $2) RETURNING id`,
        [customer.tenantId, String(Date.now()).padStart(14, '0').slice(-14)],
      );
      const companyId = company.rows[0]!.id;
      const affinityUrl = `/api/v1/companies/${companyId}/publications/${publicationId}/affinity`;
      const noProfile = await app.inject({ method: 'GET', url: affinityUrl, headers: customer.headers });
      assert.equal(noProfile.statusCode, 200, noProfile.body);
      assert.equal(noProfile.json().status, 'NO_PROFILE');

      await admin.query(
        `INSERT INTO company_tax_profiles (company_id, version_no, tax_regime, personalization, is_current)
         VALUES ($1::uuid, 1, 'LUCRO_REAL', $2::jsonb, true)`,
        [
          companyId,
          JSON.stringify({ taxonomy: { releaseId: tagView.release.id, releaseVersion: tagView.release.version, conceptCodes: ['sector.agribusiness', 'product.urea'] } }),
        ],
      );
      const affinity = await app.inject({ method: 'GET', url: affinityUrl, headers: customer.headers });
      assert.equal(affinity.statusCode, 200, affinity.body);
      const body = affinity.json();
      assert.equal(body.company.name, 'Agro Teste S.A.');
      assert.equal(body.level, 'HIGH');
      assert.deepEqual(body.matches.map((m: { code: string }) => m.code).sort(), ['product.urea', 'sector.agribusiness']);

      // TAX-12 compatibility: a profile saved with a Treatment-era code is
      // projected to the current Theme code and keeps its affinity.
      const legacyCompany = await admin.query<{ id: string }>(
        `INSERT INTO companies (tenant_id, legal_name, head_office_cnpj)
         VALUES ($1::uuid, 'Perfil Legado TAX-12 Ltda.', $2) RETURNING id`,
        [customer.tenantId, String(Date.now() + 10).padStart(14, '0').slice(-14)],
      );
      const legacyCompanyId = legacyCompany.rows[0]!.id;
      await admin.query(
        `INSERT INTO company_tax_profiles (
           company_id, version_no, tax_regime, personalization, is_current
         ) VALUES ($1::uuid, 1, 'LUCRO_REAL', $2::jsonb, true)`,
        [
          legacyCompanyId,
          JSON.stringify({
            taxonomy: {
              releaseId: 'historical-release',
              releaseVersion: 'v0.0.0',
              conceptCodes: [
                'treatment.presumed_credit',
                'platform.sped',
              ],
            },
          }),
        ],
      );
      const legacyProfile = await app.inject({
        method: 'GET',
        url: `/api/v1/companies/${legacyCompanyId}/tax-profile`,
        headers: customer.headers,
      });
      assert.equal(legacyProfile.statusCode, 200, legacyProfile.body);
      assert.equal(legacyProfile.json().profile.personalization.taxonomy.releaseId, tagView.release.id);
      assert.deepEqual(
        legacyProfile.json().profile.personalization.taxonomy.conceptCodes,
        ['theme.presumed_credit'],
      );

      const legacyAffinity = await app.inject({
        method: 'GET',
        url: `/api/v1/companies/${legacyCompanyId}/publications/${publicationId}/affinity`,
        headers: customer.headers,
      });
      assert.equal(legacyAffinity.statusCode, 200, legacyAffinity.body);
      assert.ok(
        legacyAffinity.json().matches.some(
          (match: { code: string }) => match.code === 'theme.presumed_credit',
        ),
        legacyAffinity.body,
      );

      // Another tenant cannot read this company's affinity.
      const other = await app.inject({ method: 'GET', url: affinityUrl, headers: curator.headers });
      assert.equal(other.statusCode, 404, other.body);
      // Segment of each company CNAE, from the Segmento table.
      await admin.query(
        `INSERT INTO cnaes (code, description, is_active) VALUES ('0111301', 'Cultivo de arroz', TRUE)
         ON CONFLICT (code) DO NOTHING`,
      );
      await admin.query(
        `INSERT INTO company_cnaes (company_id, cnae_code, is_primary) VALUES ($1::uuid, '0111301', TRUE)`,
        [companyId],
      );
      const suggestions = await app.inject({
        method: 'GET',
        url: `/api/v1/companies/${companyId}/taxonomy-suggestions`,
        headers: customer.headers,
      });
      assert.equal(suggestions.statusCode, 200, suggestions.body);
      const [cnaeRow] = suggestions.json().cnaes;
      assert.equal(cnaeRow.cnaeCode, '0111301');
      assert.ok(cnaeRow.segments.some((segment: { code: string }) => segment.code === 'sector.agribusiness'));

      // A company with only its CNAEs (profile never saved) is compared by
      // the segment of each CNAE; one with an empty saved profile is
      // compared too ("Sem afinidade"), never "profile not filled".
      {
        const onlyCnae = await admin.query<{ id: string }>(
          `INSERT INTO companies (tenant_id, legal_name, head_office_cnpj)
           VALUES ($1::uuid, 'Só CNAE Ltda.', $2) RETURNING id`,
          [customer.tenantId, String(Date.now() + 1).padStart(14, '0').slice(-14)],
        );
        await admin.query(
          `INSERT INTO company_cnaes (company_id, cnae_code, is_primary) VALUES ($1::uuid, '0111301', TRUE)`,
          [onlyCnae.rows[0]!.id],
        );
        const byCnae = await app.inject({
          method: 'GET',
          url: `/api/v1/companies/${onlyCnae.rows[0]!.id}/publications/${publicationId}/affinity`,
          headers: customer.headers,
        });
        assert.equal(byCnae.statusCode, 200, byCnae.body);
        assert.equal(byCnae.json().status, 'OK');
        assert.ok(byCnae.json().matches.some((m: { code: string }) => m.code === 'sector.agribusiness'));

        const emptyProfile = await admin.query<{ id: string }>(
          `INSERT INTO companies (tenant_id, legal_name, head_office_cnpj)
           VALUES ($1::uuid, 'Perfil Vazio Ltda.', $2) RETURNING id`,
          [customer.tenantId, String(Date.now() + 2).padStart(14, '0').slice(-14)],
        );
        await admin.query(
          `INSERT INTO company_tax_profiles (company_id, version_no, tax_regime, personalization, is_current)
           VALUES ($1::uuid, 1, 'LUCRO_PRESUMIDO', '{}'::jsonb, true)`,
          [emptyProfile.rows[0]!.id],
        );
        const empty = await app.inject({
          method: 'GET',
          url: `/api/v1/companies/${emptyProfile.rows[0]!.id}/publications/${publicationId}/affinity`,
          headers: customer.headers,
        });
        assert.equal(empty.statusCode, 200, empty.body);
        assert.equal(empty.json().status, 'OK');
        assert.equal(empty.json().level, 'NONE');

        // A single keyword is enough: here it names a tag of the act.
        await admin.query(
          `UPDATE company_tax_profiles SET personalization = $2::jsonb WHERE company_id = $1::uuid`,
          [emptyProfile.rows[0]!.id, JSON.stringify({ keywords: ['Crédito presumido'] })],
        );
        const byKeyword = await app.inject({
          method: 'GET',
          url: `/api/v1/companies/${emptyProfile.rows[0]!.id}/publications/${publicationId}/affinity`,
          headers: customer.headers,
        });
        assert.equal(byKeyword.statusCode, 200, byKeyword.body);
        assert.deepEqual(byKeyword.json().matches.map((m: { code: string }) => m.code), ['theme.presumed_credit']);
      }

      // Profile keeps the user's segment per CNAE; a CNAE activity or an
      // unknown item is refused.
      const profileUrl = `/api/v1/companies/${companyId}/tax-profile`;
      const profileBody = (cnaeSegments: Array<{ cnaeCode: string; segmentCode: string }>) => ({
        taxRegime: 'LUCRO_REAL',
        segments: [],
        activities: [],
        personalization: {
          taxonomy: {
            releaseId: tagView.release.id,
            releaseVersion: tagView.release.version,
            conceptCodes: [],
            cnaeSegments,
          },
        },
      });
      const badSegment = await app.inject({
        method: 'PUT',
        url: profileUrl,
        headers: customer.headers,
        payload: profileBody([{ cnaeCode: '0111301', segmentCode: 'sector.nao_existe' }]),
      });
      assert.equal(badSegment.statusCode, 400, badSegment.body);
      const savedProfile = await app.inject({
        method: 'PUT',
        url: profileUrl,
        headers: customer.headers,
        payload: profileBody([{ cnaeCode: '0111301', segmentCode: 'sector.agribusiness' }]),
      });
      assert.ok(savedProfile.statusCode < 300, savedProfile.body);
      // The user may also remove the CNAE's segment (null).
      const noSegment = await app.inject({
        method: 'PUT',
        url: profileUrl,
        headers: customer.headers,
        payload: profileBody([{ cnaeCode: '0111301', segmentCode: null as unknown as string }]),
      });
      assert.ok(noSegment.statusCode < 300, noSegment.body);
      const restored = await app.inject({
        method: 'PUT',
        url: profileUrl,
        headers: customer.headers,
        payload: profileBody([{ cnaeCode: '0111301', segmentCode: 'sector.agribusiness' }]),
      });
      assert.ok(restored.statusCode < 300, restored.body);

      // Product parametrized per CNAE, linked to the Produtos table.
      const badProduct = await app.inject({
        method: 'POST',
        url: `/api/v1/companies/${companyId}/product-profiles`,
        headers: customer.headers,
        payload: { cnaeCode: '0111301', productLabel: 'Inexistente', productConceptCode: 'product.nao_existe', ncmCodes: [] },
      });
      assert.equal(badProduct.statusCode, 400, badProduct.body);
      assert.equal(badProduct.json().error, 'invalid_product');
      const productProfile = await app.inject({
        method: 'POST',
        url: `/api/v1/companies/${companyId}/product-profiles`,
        headers: customer.headers,
        payload: { cnaeCode: '0111301', productLabel: 'Ureia', productConceptCode: 'product.urea', ncmCodes: [] },
      });
      assert.equal(productProfile.statusCode, 201, productProfile.body);
      assert.equal(productProfile.json().productConceptCode, 'product.urea');

      // Affinity now reads the CNAE segment and the parametrized product.
      const fromProfile = await app.inject({ method: 'GET', url: affinityUrl, headers: customer.headers });
      assert.equal(fromProfile.statusCode, 200, fromProfile.body);
      assert.equal(fromProfile.json().level, 'HIGH');
      assert.deepEqual(
        fromProfile.json().matches.map((m: { code: string }) => m.code).sort(),
        ['product.urea', 'sector.agribusiness'],
      );
    }

    // Seal: a second batch does not reclassify the same version.
    const again = await processPublicationTaxonomyBatch(worker, { limit: 50 });
    const reclassified = await admin.query(
      `SELECT count(*)::int AS n FROM publication_taxonomy_runs r
       JOIN publication_versions pv ON pv.id = r.publication_version_id
       WHERE pv.publication_id = $1`,
      [publicationId],
    );
    assert.equal(reclassified.rows[0].n, 1, JSON.stringify(again));

    // Acervo filtered by tag
    const archive = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?tag=theme.presumed_credit',
      headers: customer.headers,
    });
    assert.equal(archive.statusCode, 200, archive.body);
    assert.ok(archive.json().items.some((item: { id: string }) => item.id === publicationId));

    // Curator removes an automatic tag, then adds a manual one.
    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/taxonomy/publications/${publicationId}/tags`,
      headers: curator.headers,
      payload: { justification: 'Não é crédito presumido', conceptCode: 'theme.presumed_credit', action: 'REMOVE' },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const afterRemove = (
      await app.inject({ method: 'GET', url: `/api/v1/publications/${publicationId}/taxonomy`, headers: customer.headers })
    ).json();
    assert.ok(
      !afterRemove.sections.flatMap((s: { tags: Array<{ conceptCode: string }> }) => s.tags)
        .some((t: { conceptCode: string }) => t.conceptCode === 'theme.presumed_credit'),
    );
    const archiveAfter = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?tag=theme.presumed_credit',
      headers: customer.headers,
    });
    assert.ok(!archiveAfter.json().items.some((item: { id: string }) => item.id === publicationId));

    const addedTag = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/taxonomy/publications/${publicationId}/tags`,
      headers: curator.headers,
      payload: { justification: 'Soja citada no anexo', conceptCode: 'product.soy', action: 'ADD' },
    });
    assert.equal(addedTag.statusCode, 200, addedTag.body);
    const soy = addedTag
      .json()
      .sections.flatMap((s: { tags: Array<{ conceptCode: string; origin: string }> }) => s.tags)
      .find((t: { conceptCode: string }) => t.conceptCode === 'product.soy');
    assert.equal(soy.origin, 'CURATOR');
    const archiveSoy = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?tag=product.soy',
      headers: customer.headers,
    });
    assert.ok(archiveSoy.json().items.some((item: { id: string }) => item.id === publicationId));

    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/taxonomy/publications/${publicationId}/tags`,
      headers: curator.headers,
      payload: { justification: 'Revisto', conceptCode: 'theme.presumed_credit', action: 'RESTORE' },
    });
    assert.equal(restored.statusCode, 200, restored.body);

    // The compatibility endpoint permits clearing old settings but forbids exclusions.
    const unprotect = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/taxonomy/settings/excluded-sources',
      headers: curator.headers,
      payload: { justification: 'Tentar incluir DOE-SP', sources: [] },
    });
    assert.equal(unprotect.statusCode, 204);
    const exclude = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/taxonomy/settings/excluded-sources',
      headers: curator.headers,
      payload: { justification: 'Excluir uma fonte', sources: ['doe-sp'] },
    });
    assert.equal(exclude.statusCode, 409);
    assert.equal(exclude.json().error, 'classification_archive_scope_fixed');

    // Curator decisions survive a new release: remove the automatic tag,
    // publish the next version and reclassify.
    const removeAgain = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/taxonomy/publications/${publicationId}/tags`,
      headers: curator.headers,
      payload: { justification: 'Não é crédito presumido', conceptCode: 'theme.presumed_credit', action: 'REMOVE' },
    });
    assert.equal(removeAgain.statusCode, 200, removeAgain.body);
    const nextDraft = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts',
      headers: curator.headers,
      payload: { justification: 'Segunda versão' },
    });
    assert.equal(nextDraft.statusCode, 201, nextDraft.body);
    assert.equal(nextDraft.json().initialCuration, null, 'configured source is copied as is');
    // "Tipo de ato" and "Esfera" leave the taxonomy: the act's type and
    // jurisdiction come from its source.
    {
      const client = await app.curatorPool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE radar_taxonomy_curator');
        const actor = { userId: randomUUID(), justification: 'Dimensões redundantes com os metadados do ato' };
        // (this fixture release has no "sphere" dimension; production does)
        const actType = await retireDimension(client, actor, 'act_type');
        assert.ok(actType.retiredConcepts.length > 0);
        assert.ok(actType.retiredConcepts.every((code) => code.startsWith('act_type.')));
        // Folding a dimension into another (rolled back: the fixture keeps
        // its documents). Production folds "Tratamento" into "Tema".
        await client.query('SAVEPOINT merge_dimension');
        const merge = await mergeDimension(client, actor, 'document', 'theme');
        assert.ok(merge.steps.length > 0);
        assert.deepEqual(merge.retired.sort(), merge.steps.map((step) => step.from).sort());
        const mergedView = await loadReleaseView(pgRunner(client), (await findOpenDraft(pgRunner(client)))!.id);
        const nfeTheme = mergedView!.concepts.find((concept) => concept.code === 'theme.nfe');
        assert.equal(nfeTheme?.membershipStatus, 'INCLUDED');
        assert.deepEqual(nfeTheme!.officialCodes, ['55'], 'official codes move with the item');
        assert.ok(!mergedView!.concepts.some((concept) => concept.code.startsWith('document.')));
        await client.query('ROLLBACK TO SAVEPOINT merge_dimension');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const nextPublish = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/publish',
      headers: curator.headers,
      payload: { justification: 'Revisado', changeNotes: 'Segunda versão curada' },
    });
    assert.equal(nextPublish.statusCode, 200, nextPublish.body);
    resetClassificationConceptCache();
    const rerun = await processPublicationTaxonomyBatch(worker, { limit: 50 });
    assert.ok(rerun.succeeded >= 1, JSON.stringify(rerun));
    const afterRelease = (
      await app.inject({ method: 'GET', url: `/api/v1/publications/${publicationId}/taxonomy`, headers: customer.headers })
    ).json();
    assert.equal(afterRelease.release.version, `v${MAJOR}.2.0`);
    const codesAfter = afterRelease.sections.flatMap((s: { tags: Array<{ conceptCode: string }> }) =>
      s.tags.map((t) => t.conceptCode),
    );
    assert.ok(!codesAfter.includes('theme.presumed_credit'), 'removal survives the new release');
    assert.ok(codesAfter.includes('product.soy'), 'manual tag survives the new release');
    assert.ok(codesAfter.includes('product.urea'));
    assert.ok(!codesAfter.some((code: string) => code.startsWith('act_type.') || code.startsWith('sphere.')));
    const retiredDimensions = await admin.query<{ code: string; membership_status: string }>(
      `SELECT d.code, rd.membership_status
       FROM taxonomy_release_dimensions rd
       JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
       JOIN taxonomy_releases r ON r.id = rd.release_id
       WHERE r.version_major = $1 AND r.version_minor = 2 AND d.code = 'act_type'`,
      [MAJOR],
    );
    assert.deepEqual(retiredDimensions.rows, [{ code: 'act_type', membership_status: 'RETIRED' }]);
    const archiveRemoved = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?tag=theme.presumed_credit',
      headers: customer.headers,
    });
    assert.ok(!archiveRemoved.json().items.some((item: { id: string }) => item.id === publicationId));
    const archiveManual = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?tag=product.soy',
      headers: customer.headers,
    });
    assert.ok(archiveManual.json().items.some((item: { id: string }) => item.id === publicationId));

    const progress = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/taxonomy/state', headers: curator.headers })
    ).json().progress;
    assert.ok(progress.classified >= 1);

    await t.test('classification covers exactly the visible Acervo, including DOE-SP and legacy settings', async () => {
      const before = (await app.inject({
        method: 'GET', url: '/api/v1/admin/taxonomy/state', headers: curator.headers,
      })).json().progress;
      const otherCode = `class-all-${randomUUID().slice(0, 8)}`;
      const fixtures: Array<{ publicationId: string; versionId: string; visible: boolean }> = [];
      for (const [code, hiddenTitle, visible] of [
        ['doe-sp', true, true], ['dou', true, true],
        [otherCode, false, true], [otherCode, true, false],
      ] as const) {
        await admin.query(
          `INSERT INTO sources (code, name, jurisdiction_level, base_url, connector_key, schedule_cron, is_active)
           VALUES ($1, $1, 'FEDERAL', 'https://example.test', $1, '0 7 * * *', false)
           ON CONFLICT (code) DO NOTHING`, [code],
        );
        const fixture = await createPublication(admin,
          hiddenTitle ? 'AVISO DE LICITAÇÃO — ureia' : 'Ato sobre ureia', 'Ureia NCM 3102.10.10.');
        await admin.query(`UPDATE publications SET published_on = '2099-01-01' WHERE id = $1`, [fixture.publicationId]);
        await admin.query(
          `INSERT INTO publication_origins (publication_id, source_id, official_url)
           SELECT $1, id, $2 FROM sources WHERE code = $3`,
          [fixture.publicationId, `https://example.test/${fixture.publicationId}`, code],
        );
        fixtures.push({ ...fixture, visible });
      }
      // Even a visible publication awaiting content belongs to the total (pending).
      await admin.query(
        `INSERT INTO publications (identity_hash, identity_strength, identity_basis, jurisdiction_level, title)
         VALUES ($1, 'STRONG', '{}'::jsonb, 'FEDERAL', 'Aguardando versão')`,
        [createHash('sha256').update(randomUUID()).digest('hex')],
      );
      await admin.query(
        `UPDATE taxonomy_runtime_settings SET value = $1::jsonb WHERE key = 'classification_excluded_sources'`,
        [JSON.stringify(['doe-sp', otherCode])],
      );
      const stateAfter = (await app.inject({
        method: 'GET', url: '/api/v1/admin/taxonomy/state', headers: curator.headers,
      })).json();
      assert.equal(stateAfter.progress.total, before.total + 4);
      assert.equal(stateAfter.progress.pending, before.pending + 4);
      assert.equal(stateAfter.progress.excluded, 0);
      assert.deepEqual(stateAfter.settings.classificationExcludedSources, []);
      const archive = await app.inject({ method: 'GET', url: '/api/v2/archive', headers: customer.headers });
      assert.equal(archive.statusCode, 200, archive.body);
      assert.equal(stateAfter.progress.total, archive.json().totalItems);

      await processPublicationNcmEnrichmentBatch(worker, { limit: 100 });
      await processPublicationTaxonomyBatch(worker, { limit: 200 });
      for (const fixture of fixtures) {
        const scan = await admin.query(
          `SELECT status FROM publication_taxonomy_scans WHERE publication_version_id = $1
           AND taxonomy_release_id = $2`, [fixture.versionId, stateAfter.published.id],
        );
        assert.equal(scan.rows[0]?.status ?? null, fixture.visible ? 'SUCCESS' : null);
        const ncm = await admin.query(
          `SELECT status FROM publication_ncm_scans WHERE publication_version_id = $1`, [fixture.versionId],
        );
        assert.equal(ncm.rows[0]?.status ?? null, fixture.visible ? 'SUCCESS' : null);
        const view = (await app.inject({
          method: 'GET', url: `/api/v1/publications/${fixture.publicationId}/taxonomy`, headers: customer.headers,
        })).json();
        assert.equal(view.status, fixture.visible ? 'CLASSIFIED' : 'EXCLUDED');
      }
      await processPublicationTaxonomyBatch(worker, { limit: 200 });
      const seals = await admin.query(
        `SELECT count(*)::int AS n FROM publication_taxonomy_scans
         WHERE publication_version_id = ANY($1::uuid[]) AND taxonomy_release_id = $2`,
        [fixtures.map((f) => f.versionId), stateAfter.published.id],
      );
      assert.equal(seals.rows[0].n, 3, 'second batch preserves idempotency across all sources');
    });

    // Leave the shared CI database with classification disabled again.
    const disable = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/taxonomy/settings/classification',
      headers: curator.headers,
      payload: { justification: 'Fim do teste', enabled: false },
    });
    assert.equal(disable.statusCode, 204);

    const audit = await admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log
       WHERE actor_type = 'ADMIN' AND actor_id = $1`,
      [curator.userId],
    );
    const actions = audit.rows.map((row) => row.action);
    for (const expected of [
      'TAXONOMY_CURATION_DRAFT_CREATED',
      'TAXONOMY_CURATION_CONCEPT_UPDATED',
      'TAXONOMY_CURATION_IMPORT',
      'TAXONOMY_CURATION_PUBLISHED',
      'TAXONOMY_RUNTIME_SETTING_UPDATED',
      'PUBLICATION_TAG_CURATED',
    ]) {
      assert.ok(actions.includes(expected), `audit ${expected}`);
    }
  } finally {
    await app.close();
    await worker.destroy();
    await admin.end();
  }
});

test('F2-T02: Atuação curator draft, CNAE origin FK and unauthorized callers', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const app = await buildApp();
  try {
    assert.ok(app.curatorPool);
    await insertFixtureRelease(admin);
    const curator = await registerAndLogin(app, 'f2-curator');
    const customer = await registerAndLogin(app, 'f2-customer');
    await admin.query(
      "INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'TAXONOMY_CURATOR', 'f2-test'), ($1, 'PLATFORM_ADMIN', 'f2-test')",
      [curator.userId],
    );
    const draft = await app.inject({
      method: 'POST', url: '/api/v1/admin/taxonomy/drafts',
      headers: curator.headers, payload: { justification: 'F2 teste integrado' },
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const draftId = draft.json().draft.id as string;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/actuacao/initialize',
      headers: customer.headers, payload: { justification: 'Não autorizado' },
    });
    assert.equal(denied.statusCode, 403);

    const initialized = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/actuacao/initialize',
      headers: curator.headers, payload: { justification: 'Atuação F2 origem CNAE' },
    });
    assert.equal(initialized.statusCode, 200, initialized.body);
    assert.equal(initialized.json().seededCodes.length, 12);
    assert.equal(initialized.json().sourceRows, 1332);
    assert.equal(initialized.json().classificationPublished, false);

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/actuacao/initialize',
      headers: curator.headers, payload: { justification: 'Verificar idempotência' },
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(repeated.json().seededCodes, []);
    const view = await app.inject({
      method: 'GET', url: '/api/v1/admin/taxonomy/releases/' + draftId,
      headers: curator.headers,
    });
    assert.equal(view.statusCode, 200, view.body);
    const seeded = view.json().concepts.filter((concept: { code: string }) =>
      concept.code.startsWith('actuacao.'));
    assert.equal(seeded.length, 12);
    const expectedEnergiaAliases = [
      'geração de energia elétrica',
      'transmissão de energia elétrica',
      'distribuição de energia elétrica',
      'comercialização de energia elétrica',
      'produção de gás',
      'distribuição de gás canalizado',
      'produção e distribuição de vapor',
      'produção e distribuição de água quente',
    ];
    for (const concept of seeded) {
      assert.equal(concept.classifyByLabel, false);
      if (concept.code === 'actuacao.energia_e_utilidades') {
        assert.deepEqual(
          concept.aliases.map((alias: { text: string }) => alias.text).sort(),
          [...expectedEnergiaAliases].sort(),
        );
        assert.ok(concept.aliases.every((alias: { aliasType: string }) =>
          alias.aliasType === 'EXACT_LEXICAL'));
      } else {
        assert.deepEqual(concept.aliases, []);
      }
    }

    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/taxonomy/drafts/current/actuacao/origins',
      headers: curator.headers,
      payload: {
        justification: 'Origem errada',
        sourceSha256: '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd',
        rows: Array.from({ length: 1332 }, (_, index) => ({
          sourceLine: index + 2,
          cnaeCode: String(index).padStart(7, '0'),
          atuacaoLabel: 'Serviço',
        })),
      },
    });
    assert.equal(forged.statusCode, 400, forged.body);
    const noOrigins = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
      [draftId],
    );
    assert.equal(noOrigins.rows[0]?.n, 0, 'forged input must not write rows');

    // Verify the real PostgreSQL FK/unique constraint under the dedicated
    // curator session. This is an isolated PG test, never a production load.
    await withCuratorTransaction(app.curatorPool!, async client => {
      const concept = await client.query<{ id: string }>(
        "SELECT rc.id FROM taxonomy_release_concepts rc JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE rc.release_id = $1::uuid AND c.code = 'actuacao.servico'",
        [draftId],
      );
      assert.equal(concept.rows.length, 1);
      const inserted = await client.query<{ cnae_code: string }>(
        'INSERT INTO taxonomy_release_actuacao_cnae_origins (release_id, release_concept_id, cnae_code, source_line, source_sha256) VALUES ($1::uuid, $2::uuid, $3, 2, $4) RETURNING cnae_code',
        [draftId, concept.rows[0]!.id, '0111301',
         '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd'],
      );
      assert.deepEqual(inserted.rows.map(row => row.cnae_code), ['0111301']);
    });
    const origins = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
      [draftId],
    );
    assert.equal(origins.rows[0]?.n, 1);
  } finally {
    await app.close();
    await admin.end();
  }
});

