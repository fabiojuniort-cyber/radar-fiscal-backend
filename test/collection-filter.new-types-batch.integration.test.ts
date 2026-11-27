import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import {
  createApiClient, runPhase1, runPlan,
  type Ctx,
} from '../ops/collection-filter/apply-new-types.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL required: isolated PostgreSQL only');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('novos tipos em lote: plan e fase 1 salvam regras dos três modos sem apagar nenhuma publicação', async () => {
  const owner = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const tag = 'NTBATCH' + randomUUID().replaceAll('-', '').toUpperCase().slice(0, 12);
  const dir = await mkdtemp(path.join(tmpdir(), 'ntbatch-'));
  const calls: string[] = [];
  const allCalls: string[] = [];
  try {
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const email = tag.toLowerCase() + '@example.test';
    const password = 'NtBatch-Isolated-Integration-2026!';
    const registered = await app.inject({ method: 'POST', url: '/auth/register', payload: { name: 'Batch', email, password, confirmPassword: password, acceptedTerms: true } });
    assert.equal(registered.statusCode, 201, registered.body);
    const account = registered.json<{ user: { id: string }; tenant: { id: string } }>();
    await owner.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','NTBATCH_ISOLATED_TEST')", [account.user.id]);
    const policy = (await owner.query<{ id: string }>("SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1")).rows[0]
      ?? (await owner.query<{ id: string }>("INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies RETURNING id", [account.user.id])).rows[0]!;
    const source = async (code: string) => {
      const existing = (await owner.query<{ id: string }>('SELECT id FROM sources WHERE code=$1', [code])).rows[0];
      return existing?.id ?? (await owner.query<{ id: string }>("INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) VALUES($1,$1,'FEDERAL','https://example.test',$1) RETURNING id", [code])).rows[0]!.id;
    };
    const dou = await source('dou');
    const doe = await source('doe-sp');

    const ids: string[] = [];
    const fixture = async (label: string, code: 'dou' | 'doe-sp', name: string, extraOrigin = false) => {
      const id = randomUUID(); ids.push(id);
      const sourceId = code === 'dou' ? dou : doe;
      const officialUrl = 'https://example.test/' + tag + '/' + label;
      const title = name + ' Nº 33/2026';
      const metadata = code === 'dou' ? { dou: { section: 'DO3E', sourceActType: 'Aviso' } } : { section: 'ATOS NORMATIVOS', publicationType: 'Aviso' };
      await owner.query("INSERT INTO publications(id,identity_hash,identity_strength,identity_basis,jurisdiction_level,act_type,title,published_on,primary_official_url) VALUES($1,$2,'STRONG','{}'::jsonb,'FEDERAL','AVISO',$3,'2026-10-09',$4)", [id, sha(id), title, officialUrl]);
      await owner.query('INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) VALUES($1,$2,$3,$4::jsonb)', [id, sourceId, officialUrl, JSON.stringify(metadata)]);
      await owner.query('INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) VALUES($1,1,$2,$3,true,$4::jsonb)', [id, sha('body' + id), 'Contratacao administrativa de rotina.', JSON.stringify(metadata)]);
      if (extraOrigin) await owner.query('INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) VALUES($1,$2,$3,$4::jsonb)', [id, sourceId, officialUrl + '/second', JSON.stringify(metadata)]);
      return id;
    };

    const T = {
      keepA: tag + ' AVISO MANTER', keepB: tag + ' COMUNICADO CONDICIONAL',
      excA: tag + ' RELATORIO ROTINA', excB: tag + ' ATO ESTADUAL ROTINA', excC: tag + ' PARECER CRESCENTE',
      excD: tag + ' ATO DIRETO ROTINA', liveOnly: tag + ' TIPO SO NO VIVO', csvOnly: tag + ' TIPO NAO EXISTE',
    };
    for (let n = 0; n < 3; n++) await fixture('keepA' + n, 'dou', T.keepA);
    for (let n = 0; n < 2; n++) await fixture('keepB' + n, 'dou', T.keepB);
    const excA: string[] = [];
    for (let n = 0; n < 3; n++) excA.push(await fixture('excA' + n, 'dou', T.excA));
    const companyProtected = await fixture('excA-company', 'dou', T.excA);
    const originProtected = await fixture('excA-origin', 'dou', T.excA, true);
    const excB: string[] = [];
    for (let n = 0; n < 2; n++) excB.push(await fixture('excB' + n, 'doe-sp', T.excB));
    const excC: string[] = [];
    for (let n = 0; n < 2; n++) excC.push(await fixture('excC' + n, 'dou', T.excC));
    const excD: string[] = [];
    for (let n = 0; n < 2; n++) excD.push(await fixture('excD' + n, 'dou', T.excD));
    const liveOnly = await fixture('liveOnly', 'dou', T.liveOnly);
    const company = (await owner.query<{ id: string }>('INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES($1,$2,$3) RETURNING id', [account.tenant.id, tag, String(BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 11))).padStart(14, '0')])).rows[0]!.id;
    await owner.query('INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)', [company, companyProtected]);

    // Cliente HTTP real (loopback) com registro das chamadas; credenciais só em memória.
    const client = createApiClient({
      baseUrl, credentials: async () => ({ email, password }),
      fetchImpl: async (url, init) => { const c = (init?.method ?? 'GET') + ' ' + new URL(String(url)).pathname; calls.push(c); allCalls.push(c); return fetch(url, init); },
    });
    const logs: string[] = [];
    const makeCtx = (out: string, csv: string, extra: Partial<Ctx> = {}): Ctx => ({
      client, outDir: out, csvPath: csv, log: (l) => logs.push(l), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
      now: () => new Date(), inventoryRetries: 200, inventoryDelayMs: 50, allowDivergences: false, ...extra,
    });

    // Seções vêm do inventário vivo (planilha sintética montada a partir dele).
    const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    const headers = { authorization: 'Bearer ' + first.json<{ accessToken: string }>().accessToken };
    let live: Array<{ source_code: string; section: string; act_name: string; normalized_type: string; occurrence_count: number }> = [];
    for (let i = 0; i < 200; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/v1/admin/collection-filter/new-types?status=OPEN', headers });
      const b = r.json<{ inventory?: { status: string }; items: typeof live }>();
      if (b.inventory?.status === 'READY') { live = b.items; break; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    const sectionOf = (name: string) => {
      const item = live.find((x) => x.normalized_type === name);
      assert.ok(item, 'item vivo esperado: ' + name);
      return item;
    };
    const row = (name: string, mode: string, occ?: number) => {
      const item = sectionOf(name);
      return [item.source_code, item.section, name, occ ?? item.occurrence_count, mode, 'g'].join(';');
    };
    const csvPath = path.join(dir, 'sheet.csv');
    await writeFile(csvPath, '﻿' + [
      'fonte;secao;tipo;ocorrencias;modo;grupo',
      row(T.keepA, 'KEEP_ALWAYS'), row(T.keepB, 'KEEP_IF_TAX_TERM'),
      row(T.excA, 'EXCLUDE_UNLESS_STRONG'), row(T.excB, 'EXCLUDE_UNLESS_STRONG'),
      row(T.excC, 'EXCLUDE_UNLESS_STRONG', 99), // diferença de contagem proposital
      'dou;DO3;' + T.csvOnly + ';7;EXCLUDE_UNLESS_STRONG;g', // não existe no vivo
    ].join('\r\n') + '\r\n', 'utf8');

    const count = async (sql: string, params: unknown[] = []) => Number((await owner.query<{ n: string }>(sql, params)).rows[0]!.n);
    const pubCount = () => count('SELECT count(*) AS n FROM publications WHERE id=ANY($1::uuid[])', [ids]);
    const revision = () => count('SELECT revision AS n FROM collection_filter_policies WHERE id=$1', [policy.id]);
    const ruleCount = () => count('SELECT count(*) AS n FROM collection_filter_type_rules WHERE policy_id=$1 AND canonical_type ILIKE $2', [policy.id, tag + '%']);
    const totalPubs = ids.length;

    // ------------------------------------------------------------------ plan
    const planOut = path.join(dir, 'plan');
    const plan = await runPlan(makeCtx(planOut, csvPath));
    assert.equal(plan.exitCode, 2, 'linha sem item vivo bloqueia');
    assert.equal(plan.plan.totals.matched, 5);
    assert.equal(plan.plan.totals.unmatchedCsv, 1);
    const kinds = (k: string) => plan.plan.divergences.filter((d) => d.kind === k && d.tipo.toUpperCase().includes(tag)).map((d) => ({ ...d, tipo: d.tipo.toUpperCase() }));
    assert.deepEqual(kinds('CSV_WITHOUT_LIVE_ITEM').map((d) => d.tipo), [T.csvOnly]);
    assert.deepEqual(kinds('LIVE_NOT_IN_CSV').map((d) => d.tipo).sort(), [T.excD, T.liveOnly].sort());
    assert.deepEqual(kinds('COUNT_DIFFERENCE').map((d) => d.tipo), [T.excC]);
    for (const f of ['plan.json', 'divergences.csv', 'divergences.md']) assert.ok((await readFile(path.join(planOut, f), 'utf8')).length > 0);
    assert.ok((await readFile(path.join(planOut, 'divergences.md'), 'utf8')).toUpperCase().includes(T.csvOnly));
    assert.equal((await runPlan(makeCtx(planOut, csvPath, { allowDivergences: true }))).exitCode, 0);
    const written = (await readFile(path.join(planOut, 'plan.json'), 'utf8')) + (await readFile(path.join(planOut, 'divergences.csv'), 'utf8'));
    assert.ok(!written.includes(password) && !written.includes(first.json<{ accessToken: string }>().accessToken));
    assert.equal(await pubCount(), totalPubs);
    assert.equal(await ruleCount(), 0, 'plan não escreve regras');

    // ----------------------------------------------------------------- fase 1
    const idsBefore = (await owner.query<{ id: string }>('SELECT id FROM publications WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows.map((r) => r.id);
    assert.equal(idsBefore.length, totalPubs);
    const p1Out = path.join(dir, 'p1');
    const rev0 = await revision();
    calls.length = 0;
    const dry = await runPhase1(makeCtx(p1Out, csvPath, { allowDivergences: true }), { dryRun: true });
    assert.equal(dry.saved, 0);
    assert.equal(dry.dry.length, 5, 'dry-run faz preview dos três modos');
    assert.ok(calls.every((c) => c === 'POST /auth/login' || c.includes('/new-types') || c.endsWith('/direct-rule/preview')), 'dry-run só lê');
    assert.equal(await revision(), rev0, 'dry-run não altera a política');
    assert.equal(await ruleCount(), 0);
    const dryBy = Object.fromEntries(dry.dry.map((d) => [String(d.canonicalType).toUpperCase(), d]));
    assert.equal(dryBy[T.excA]!.previewCount, 3, 'regra EXCLUDE descartaria 3 (1 de empresa e 1 de outra origem protegidas)');
    assert.equal(dryBy[T.excB]!.previewCount, 2);
    assert.equal(dryBy[T.excC]!.previewCount, 2);
    assert.ok(Object.values(dryBy).filter((d) => d.mode === 'EXCLUDE_UNLESS_STRONG').every((d) => Number(d.previewCount) > 0));

    calls.length = 0;
    const p1 = await runPhase1(makeCtx(p1Out, csvPath, { allowDivergences: true }), { dryRun: false });
    assert.deepEqual([p1.saved, p1.skipped, p1.exitCode], [5, 0, 0]);
    const seq = calls.filter((c) => c.includes('/direct-rule/')).map((c) => c.split('/').pop());
    assert.deepEqual(seq, ['preview', 'save', 'preview', 'save', 'preview', 'save', 'preview', 'save', 'preview', 'save'], 'preview novo antes de cada save');
    assert.equal(await revision(), rev0 + 5, 'cada save sobe a revisão');
    assert.equal(await ruleCount(), 5);
    const modes = (await owner.query<{ canonical_type: string; mode: string }>('SELECT canonical_type,mode FROM collection_filter_type_rules WHERE policy_id=$1 AND canonical_type ILIKE $2', [policy.id, tag + '%'])).rows;
    assert.deepEqual(Object.fromEntries(modes.map((m) => [m.canonical_type.toUpperCase(), m.mode])), {
      [T.keepA]: 'KEEP_ALWAYS', [T.keepB]: 'KEEP_IF_TAX_TERM',
      [T.excA]: 'EXCLUDE_UNLESS_STRONG', [T.excB]: 'EXCLUDE_UNLESS_STRONG', [T.excC]: 'EXCLUDE_UNLESS_STRONG',
    });
    const idsAfter = (await owner.query<{ id: string }>('SELECT id FROM publications WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows.map((r) => r.id);
    assert.deepEqual(idsAfter, idsBefore, 'nenhuma publicação foi apagada (mesmos ids)');
    assert.equal(await pubCount(), totalPubs);
    assert.equal(await count('SELECT count(*) AS n FROM publications WHERE id=ANY($1::uuid[])', [[...excA, ...excB, ...excC, companyProtected, originProtected]]), 9, 'as apagáveis seguem todas lá');
    assert.ok(logs.includes('nenhuma publicação foi apagada (rotina só usa /save)'));
    const report = await readFile(path.join(p1Out, 'phase1-report.csv'), 'utf8');
    assert.ok(/NAO_sao_apagadas_por_esta_rotina/.test(report));
    const state = JSON.parse(await readFile(path.join(p1Out, 'phase1.state.json'), 'utf8')) as { saved: Record<string, unknown> };
    assert.equal(Object.keys(state.saved).length, 5);

    // Segunda execução é no-op.
    calls.length = 0;
    const p1b = await runPhase1(makeCtx(p1Out, csvPath, { allowDivergences: true }), { dryRun: false });
    assert.deepEqual([p1b.saved, p1b.skipped, p1b.exitCode], [0, 5, 0]);
    assert.ok(!calls.some((c) => c.includes('/save') || c.includes('/preview')));
    assert.equal(await revision(), rev0 + 5);
    assert.equal(await pubCount(), totalPubs);

    // /save direto no servidor, regra EXCLUDE com count > 0: não destrutivo.
    const sec = sectionOf(T.excD);
    const rule = { sourceCode: sec.source_code, section: sec.section, canonicalType: sec.act_name, mode: 'EXCLUDE_UNLESS_STRONG' };
    allCalls.push('POST /api/v1/admin/collection-filter/direct-rule/preview');
    const pvRes = await app.inject({ method: 'POST', url: '/api/v1/admin/collection-filter/direct-rule/preview', headers, payload: rule });
    assert.equal(pvRes.statusCode, 200, pvRes.body);
    const pv = pvRes.json<{ count: number; token: string; confirmationToken: string; policyRevision: number }>();
    assert.ok(pv.count > 0, 'a regra descartaria publicações numa limpeza futura');
    allCalls.push('POST /api/v1/admin/collection-filter/direct-rule/save');
    const sv = await app.inject({ method: 'POST', url: '/api/v1/admin/collection-filter/direct-rule/save', headers,
      payload: { ...rule, expectedCount: pv.count, previewToken: pv.token, confirmationToken: pv.confirmationToken, policyRevision: pv.policyRevision } });
    assert.equal(sv.statusCode, 200, sv.body);
    assert.equal(sv.json<{ deletedCount: number }>().deletedCount, 0);
    assert.equal(await count('SELECT count(*) AS n FROM publications WHERE id=ANY($1::uuid[])', [excD]), 2, 'save direto não apagou nada');
    assert.equal(await pubCount(), totalPubs);
    assert.equal(await ruleCount(), 6);

    // Nenhuma chamada passou por /confirm e tudo ficou nas rotas administrativas esperadas.
    assert.ok(!allCalls.some((c) => c.includes('/confirm')), 'nenhum caminho continha /confirm');
    assert.ok(allCalls.every((c) => c.includes('/api/v1/admin/collection-filter/') || c === 'POST /auth/login'));
  } finally {
    await app.close();
    await owner.end();
  }
});
