/**
 * L-LEG-01 (#116 c.6708512598 §7; design §11.7): regression of the OTHER sources. For each local official input
 * (RFB lot, Sefaz-SP portal, CONFAZ HTTP package, DOU fixtures, Planalto, and the normas.leg.br files read as DOU) the
 * engine payload is digested WITHOUT the identity fields that change legitimately with the build (`identity`,
 * `analysisId`, `outputHash`). Two digests per input:
 * - `payload`: everything else (text, parts with ids, contexts, sourceMap, coverage, limitations, entities, eligibility);
 * - `regions`: the same without part ids/orders (parts compared by span, type, context, reasons).
 * `--write` regenerates docs/anatomy/lleg-regression-baseline.json. Offline: reads committed files only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAnatomy, type AnatomyRequest } from '../../src/modules/anatomy/engine.js';
import { prepareRfbRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { planRfbQuoteResume } from '../../src/modules/anatomy/rfb-quote-resume.js';
import { prepareSefazSpPortalPage } from '../../src/modules/anatomy/sefaz-sp-preparation.js';
import { prepareDouRepresentation } from '../../src/modules/anatomy/dou-preparation.js';
import type { AnatomyResult } from '../../src/modules/anatomy/contract.js';
import { LOT_DIRS } from './official-lot-rfb.js';

const ROOT = fileURLToPath(new URL('./official-identification/', import.meta.url));
const DOU_DIR = fileURLToPath(new URL('../../test/fixtures/dou/', import.meta.url));
export const REGRESSION_BASELINE = fileURLToPath(new URL('../../docs/anatomy/lleg-regression-baseline.json', import.meta.url));
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** Payload digests without the build identity (design §11.7). */
export function payloadDigests(r: AnatomyResult): { payload: string; regions: string } {
  const { identity: _i, analysisId: _a, outputHash: _o, ...payload } = r;
  const ids = new Map(r.parts.map((p) => [p.id, `${p.type}@${p.span.start}-${p.span.end}`]));
  const regions = { canonicalText: r.canonicalText, sourceMap: r.sourceMap, status: r.status,
    parts: r.parts.map((p) => ({ type: p.type, span: p.span, context: p.context, contextReasons: p.contextReasons, legalStatus: p.legalStatus, parent: p.parentId === null ? null : ids.get(p.parentId) ?? '?', sourcePointers: p.sourcePointers, table: p.table }))
      .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.type.localeCompare(b.type)),
    coverage: { ...r.coverage, segments: r.coverage.segments.map((s) => ({ span: s.span, owner: ids.get(s.partId), classification: s.classification })) },
    limitations: r.limitations.map((l) => ({ code: l.code, span: l.span, owner: l.partId === null ? null : ids.get(l.partId) })),
    eligibility: r.eligibility.map((e) => ({ purpose: e.purpose, span: e.span, eligible: e.eligible, exclusionReasons: e.exclusionReasons })) };
  return { payload: sha(canon(payload)), regions: sha(canon(regions)) };
}

const base = { referenceDate: '2026-11-07', ruleSet: { id: 'lleg-regression', version: '1' }, catalog: { edition: 'none', codes: [] as string[] } };
type Case = { id: string; request: () => AnatomyRequest };

export function regressionCases(): Case[] {
  const cases: Case[] = [];
  for (const dir of LOT_DIRS) for (const f of readdirSync(dir).filter((x) => /^\d+\.json$/u.test(x)).sort()) {
    const id = Number(f.slice(0, -5)); const bytes = new Uint8Array(readFileSync(join(dir, f)));
    cases.push({ id: `RFB:${id}`, request: () => { const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes }, id);
      return { ...base, publicationVersionId: `rfb:${id}`, input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html, rfbQuoteResume: planRfbQuoteResume({ resourceId: `rfb:${id}`, bytes }, id) } }; } });
  }
  const sp = join(ROOT, 'doesp-ricms');
  for (const f of readdirSync(sp).filter((x) => x.endsWith('.html')).sort()) {
    const m = JSON.parse(readFileSync(join(sp, f.replace(/\.html$/u, '.meta.json')), 'utf8')) as { id: string; url: string };
    const bytes = new Uint8Array(readFileSync(join(sp, f)));
    cases.push({ id: `SEFAZ-SP-PORTAL:${m.id}`, request: () => { const p = prepareSefazSpPortalPage({ resourceId: m.id, url: m.url, bytes });
      return { ...base, publicationVersionId: m.id, input: { source: 'SEFAZ-SP-PORTAL', representationId: m.id, html: p.html, sefazSpPortal: p } }; } });
  }
  for (const id of ['M3', 'M4', 'M5']) cases.push({ id: `CONFAZ:e9-http/${id}`, request: () => ({ ...base, publicationVersionId: id,
    input: { source: 'CONFAZ', representationId: id, html: readFileSync(join(ROOT, 'e9-http', `${id}.html`), 'latin1') } }) });
  const douFiles = readdirSync(DOU_DIR).filter((x) => x.endsWith('.xml')).sort();
  for (const f of douFiles) cases.push({ id: `DOU:${f}`, request: () => { const p = prepareDouRepresentation([{ resourceId: f, bytes: new Uint8Array(readFileSync(join(DOU_DIR, f))) }]);
    return { ...base, publicationVersionId: f, input: { source: 'DOU', representationId: f, html: p.html } }; } });
  for (const id of ['M1', 'M2']) cases.push({ id: `DOU:e9-http/${id} (Planalto)`, request: () => ({ ...base, publicationVersionId: id,
    input: { source: 'DOU', representationId: id, html: readFileSync(join(ROOT, 'e9-http', `${id}.html`), 'latin1') } }) });
  // Design cases 10/11: the normas.leg.br files (original and atualizada) read as DOU must stay unchanged.
  for (const f of readdirSync(join(ROOT, 'leg-normas')).filter((x) => x.endsWith('.html')).sort()) cases.push({ id: `DOU:leg-normas/${f}`,
    request: () => ({ ...base, publicationVersionId: f, input: { source: 'DOU', representationId: f, html: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(ROOT, 'leg-normas', f))).replace(/^﻿/u, '') } }) });
  return cases;
}

export function computeRegression(): { cases: { id: string; payload: string; regions: string }[] } {
  return { cases: regressionCases().map((c) => ({ id: c.id, ...payloadDigests(analyzeAnatomy(c.request())) })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = computeRegression();
  if (process.argv.includes('--write')) writeFileSync(REGRESSION_BASELINE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${out.cases.length} cases`); for (const c of out.cases) console.log(c.id, c.payload.slice(0, 12), c.regions.slice(0, 12));
}
