import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ApiError, assertBaseUrl, createApiClient, dedupeRows, matchKey, matchRows, parseCsvText, parseSheet,
  runPhase1, PREVIEW_COLUMN,
  type ApiClient, type Ctx, type LiveItem,
} from '../ops/collection-filter/apply-new-types.js';

const HEADER = 'fonte;secao;tipo;ocorrencias;modo;grupo';
const live = (source: string, section: string, name: string, normalized: string): LiveItem => ({
  id: 'x', source_code: source, section, normalized_type: normalized, sample_raw_type: name, act_name: name, occurrence_count: 1,
});

test('CSV: BOM, CRLF, ponto e vírgula e aspas escapadas', () => {
  const text = '﻿' + HEADER + '\r\n' + 'doe-sp;ATOS NORMATIVOS;"Solicitação ""a""; b";4;KEEP_ALWAYS;g\r\ndou;DO3;Aviso;2;EXCLUDE_UNLESS_STRONG;g\r\n';
  const { rows, invalid } = parseSheet(text);
  assert.equal(invalid.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.tipo, 'Solicitação "a"; b');
  assert.equal(rows[0]!.occurrences, 4);
  assert.deepEqual(parseCsvText('a;b\n'), [['a', 'b']]);
});

test('CSV: cabeçalho, fonte, modo, ocorrências e tipo vazio são inválidos', () => {
  assert.throws(() => parseSheet('x;y\n1;2\n'), /csv_header_invalid/);
  const { rows, invalid } = parseSheet([HEADER,
    'tcu;DO1;A;1;KEEP_ALWAYS;g', 'dou;DO1;B;1;EXCLUDE_ALWAYS;g', 'dou;DO1;C;x;KEEP_ALWAYS;g',
    'dou;DO1;;1;KEEP_ALWAYS;g', 'dou;DO1;D;1;KEEP_ALWAYS', 'dou;DO1;Ok;1;KEEP_ALWAYS;g'].join('\n'));
  assert.equal(rows.length, 1);
  assert.deepEqual(invalid.map((i) => i.reason.split(':')[0]), ['fonte_invalida', 'modo_invalido', 'ocorrencias_invalidas', 'tipo_vazio', 'colunas=5']);
});

test('normalização igual à do servidor: acentos, caixa, número do ato', () => {
  assert.equal(matchKey('dou', 'DO3', 'Extrato de Contrato nº 33/2026'), matchKey('dou', 'DO3', 'EXTRATO DE CONTRATO'));
  assert.equal(matchKey('dou', 'DO3', 'Solicitação de Talonários'), matchKey('dou', 'DO3', 'SOLICITACAO DE TALONARIOS'));
  assert.notEqual(matchKey('dou', 'DO3', 'Aviso'), matchKey('doe-sp', 'DO3', 'Aviso'));
  assert.notEqual(matchKey('dou', 'DO1', 'Aviso'), matchKey('dou', 'DO3', 'Aviso'));
});

test('nome que normaliza para vazio usa o rótulo do inventário do servidor', () => {
  assert.equal(JSON.parse(matchKey('doe-sp', 'ATOS NORMATIVOS', '658/2026'))[2], 'NOME NAO IDENTIFICADO');
});

test('duplicatas: mesmo modo mantém a primeira; modos em conflito excluem todas', () => {
  const { rows } = parseSheet([HEADER, 'dou;DO3;Aviso;1;KEEP_ALWAYS;g', 'dou;DO3;AVISO;2;KEEP_ALWAYS;g',
    'dou;DO3;Edital;1;KEEP_ALWAYS;g', 'dou;DO3;edital;1;EXCLUDE_UNLESS_STRONG;g', 'dou;DO3;Unico;1;KEEP_ALWAYS;g'].join('\n'));
  const { effective, duplicates } = dedupeRows(rows);
  assert.deepEqual(effective.map((r) => r.tipo), ['Aviso', 'Unico']);
  assert.deepEqual(duplicates.map((d) => d.kind), ['DUPLICATE_KEY', 'DUPLICATE_KEY_CONFLICT']);
});

test('matching por (fonte, seção, nome normalizado)', () => {
  const { rows } = parseSheet([HEADER, 'dou;DO3;Aviso de Abertura;1;KEEP_ALWAYS;g', 'dou;DO3;Inexistente;1;KEEP_ALWAYS;g'].join('\n'));
  const items = [live('dou', 'DO3', 'Aviso de Abertura', 'AVISO DE ABERTURA'), live('doe-sp', 'DO3', 'Aviso de Abertura', 'AVISO DE ABERTURA')];
  const m = matchRows(rows, items);
  assert.equal(m.matched.length, 1);
  assert.equal(m.matched[0]!.canonicalType, 'Aviso de Abertura');
  assert.deepEqual(m.unmatched.map((r) => r.tipo), ['Inexistente']);
});

test('URL base: https ou http somente em localhost', () => {
  assert.equal(assertBaseUrl('https://api.example.com/x'), 'https://api.example.com');
  assert.equal(assertBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(assertBaseUrl('http://localhost:1'), 'http://localhost:1');
  assert.throws(() => assertBaseUrl('http://api.example.com'));
  assert.throws(() => assertBaseUrl('ftp://localhost'));
  assert.throws(() => assertBaseUrl('nao-e-url'));
});

test('planilha real de novos tipos: 616 linhas válidas, sem conflitos', () => {
  const { rows, invalid } = parseSheet(readFileSync(new URL('../ops/collection-filter/novos-tipos-2026-11.csv', import.meta.url), 'utf8'));
  assert.equal(invalid.length, 0);
  assert.equal(rows.length, 616);
  const by = (m: string) => rows.filter((r) => r.mode === m).length;
  assert.deepEqual([by('KEEP_ALWAYS'), by('KEEP_IF_TAX_TERM'), by('EXCLUDE_UNLESS_STRONG')], [19, 50, 547]);
  assert.equal(dedupeRows(rows).duplicates.filter((d) => d.kind === 'DUPLICATE_KEY_CONFLICT').length, 0);
});

// ---- laço das fases com cliente falso (sem rede) ----------------------------

function fakeCtx(client: ApiClient, csvText: string, extra: Partial<Ctx> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ntb-unit-'));
  const csvPath = path.join(dir, 's.csv');
  writeFileSync(csvPath, csvText);
  const logs: string[] = [];
  const ctx: Ctx = { client, outDir: path.join(dir, 'out'), csvPath, log: (l) => logs.push(l), sleep: async () => {},
    now: () => new Date(0), inventoryRetries: 3, inventoryDelayMs: 0, allowDivergences: false, ...extra };
  return { ctx, logs, dir };
}
const item = (name: string, source = 'dou', section = 'DO3'): LiveItem => ({
  id: name, source_code: source, section, normalized_type: name.toUpperCase(), sample_raw_type: name, act_name: name, occurrence_count: 1, requires_review: true,
});
const prev = (count: number) => ({ actName: 'x', count, blockedCompany: 0, blockedOtherSource: 0, samples: [], token: 'a'.repeat(64), policyRevision: 1, confirmationToken: 'b'.repeat(64) });

test('inventário em aquecimento nunca vira "sem tipos": espera READY e falha se não ficar pronto', async () => {
  let n = 0;
  const warming: ApiClient = { get: async () => (++n < 3 ? { inventory: { status: 'WARMING' }, items: [] } : { inventory: { status: 'READY', key: 'k' }, items: [item('Aviso')] }), post: async () => prev(0) };
  const { ctx } = fakeCtx(warming, HEADER + '\ndou;DO3;Aviso;1;KEEP_ALWAYS;g\n', { inventoryRetries: 5 });
  const r = await runPhase1(ctx, { dryRun: true });
  assert.equal(r.dry.length, 1);
  const never: ApiClient = { get: async () => ({ inventory: { status: 'WARMING' }, items: [] }), post: async () => { throw new Error('nao deveria chamar'); } };
  await assert.rejects(runPhase1(fakeCtx(never, HEADER + '\ndou;DO3;Aviso;1;KEEP_ALWAYS;g\n').ctx, { dryRun: false }), /inventario_nao_ficou_pronto/);
});

test('fase 1: cobre os três modos (EXCLUDE incluído), preview antes de cada save, para no primeiro erro e retoma', async () => {
  const posts: string[] = [];
  const saves: Array<{ type: string; mode: string }> = [];
  let failB = true;
  const client: ApiClient = {
    get: async () => ({ inventory: { status: 'READY' }, items: [item('A'), item('B'), item('C'), item('D')] }),
    post: async (p, body) => {
      const b = body as { canonicalType: string; mode: string };
      posts.push(p.split('/').pop() + ':' + b.canonicalType);
      if (p.endsWith('/save') && b.canonicalType === 'B' && failB) throw new ApiError(409, null, 'HTTP 409');
      if (p.endsWith('/save')) saves.push({ type: b.canonicalType, mode: b.mode });
      return p.endsWith('/preview') ? prev(4) : { revision: 9, deletedCount: 0, historicalPurgeRequired: true };
    },
  };
  const { ctx, logs } = fakeCtx(client, HEADER + '\ndou;DO3;A;1;KEEP_ALWAYS;g\ndou;DO3;B;1;KEEP_IF_TAX_TERM;g\ndou;DO3;C;1;EXCLUDE_UNLESS_STRONG;g\ndou;DO3;D;1;EXCLUDE_UNLESS_STRONG;g\n');
  const first = await runPhase1(ctx, { dryRun: false });
  assert.equal(first.exitCode, 1);
  assert.deepEqual(posts, ['preview:A', 'save:A', 'preview:B', 'save:B']);
  failB = false; posts.length = 0;
  const second = await runPhase1(ctx, { dryRun: false });
  assert.equal(second.exitCode, 0);
  assert.deepEqual(posts, ['preview:B', 'save:B', 'preview:C', 'save:C', 'preview:D', 'save:D']);
  assert.deepEqual(saves.map((x) => x.mode), ['KEEP_ALWAYS', 'KEEP_IF_TAX_TERM', 'EXCLUDE_UNLESS_STRONG', 'EXCLUDE_UNLESS_STRONG']);
  // terceira execução: nada a fazer
  posts.length = 0;
  assert.equal((await runPhase1(ctx, { dryRun: false })).exitCode, 0);
  assert.deepEqual(posts, []);
  assert.ok(logs.includes('nenhuma publicação foi apagada (rotina só usa /save)'));
  const report = readFileSync(path.join(ctx.outDir, 'phase1-report.csv'), 'utf8');
  assert.ok(report.includes(PREVIEW_COLUMN) && /NAO_sao_apagadas/.test(PREVIEW_COLUMN));
  assert.equal(report.split('\r\n').filter((l) => l.includes('EXCLUDE_UNLESS_STRONG')).length, 2);
});

test('fase 1 --dry-run: só previews, para todos os modos', async () => {
  const posts: string[] = [];
  const client: ApiClient = {
    get: async () => ({ inventory: { status: 'READY' }, items: [item('A'), item('B')] }),
    post: async (p) => { posts.push(p.split('/').pop()!); return prev(2); },
  };
  const { ctx } = fakeCtx(client, HEADER + '\ndou;DO3;A;1;KEEP_ALWAYS;g\ndou;DO3;B;1;EXCLUDE_UNLESS_STRONG;g\n');
  const r = await runPhase1(ctx, { dryRun: true });
  assert.equal(r.dry.length, 2);
  assert.deepEqual(posts, ['preview', 'preview']);
});

test('fonte da CLI não contém endpoint de confirmação nem fase 2', () => {
  const src = readFileSync(new URL('../ops/collection-filter/apply-new-types.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('direct-rule/confirm'));
  assert.ok(!/\/confirm\b/.test(src));
  assert.ok(!/phase2/i.test(src));
  assert.ok(!/direct-rule\/(?!preview|save)/.test(src));
  for (const f of ['NOVOS-TIPOS-RUNBOOK.md']) {
    assert.ok(!readFileSync(new URL('../ops/collection-filter/' + f, import.meta.url), 'utf8').includes('direct-rule/confirm'));
  }
});

test('cliente HTTP: 401 faz um único novo login; token e senha nunca aparecem em erros', async () => {
  let logins = 0, calls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/login')) { logins++; return new Response(JSON.stringify({ accessToken: 'tok' + logins }), { status: 200 }); }
    calls++;
    const auth = (init?.headers as Record<string, string>).authorization;
    return new Response(JSON.stringify({ error: auth === 'Bearer tok2' ? 'boom' : 'expired' }), { status: auth === 'Bearer tok2' ? 500 : 401 });
  }) as typeof fetch;
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:9', credentials: async () => ({ email: 'a@b.c', password: 'S3nh4-secreta' }), fetchImpl });
  await assert.rejects(client.get('/x'), (e: Error) => e instanceof ApiError && e.status === 500 && !/S3nh4|tok/.test(e.message));
  assert.deepEqual([logins, calls], [2, 2]);
});
