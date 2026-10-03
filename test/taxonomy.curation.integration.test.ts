import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  processPublicationTaxonomyBatch,
  resetClassificationConceptCache,
} from '../src/modules/taxonomy/classification/classification.worker.js';
import { processPublicationNcmEnrichmentBatch } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

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

test('TAX-11 curation: draft, tables, publication, profile, classification and tags', async () => {
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
       VALUES ($1, 'TAXONOMY_CURATOR', 'tax-11-test')`,
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
    assert.deepEqual(meCurator.json(), { taxonomyCurator: true, curatorDatabase: true });

    const state = await app.inject({ method: 'GET', url: '/api/v1/admin/taxonomy/state', headers: curator.headers });
    assert.equal(state.statusCode, 200, state.body);
    assert.equal(state.json().published.version, `v${MAJOR}.0.0`);
    assert.equal(state.json().draft, null);
    assert.equal(state.json().settings.classificationEnabled, false);
    assert.deepEqual(state.json().settings.classificationExcludedSources, ['doe-sp']);

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
      payload: { justification: 'NCM inválido', officialCodes: ['31021'] },
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
        rows: [gridRow('Calcário'), gridRow('Ureia', { code: 'product.urea', officialCodes: ['31021'] })],
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
    assert.equal(find('product.rice').reason.term, '10063011');
    assert.equal(find('product.espalhante_adesivo').reason.type, 'SYNONYM');
    assert.equal(find('act_type.law'), undefined, 'generic label does not tag');

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

    // DOE-SP cannot be put back into classification from the API.
    const unprotect = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/taxonomy/settings/excluded-sources',
      headers: curator.headers,
      payload: { justification: 'Tentar incluir DOE-SP', sources: [] },
    });
    assert.equal(unprotect.statusCode, 409);

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
