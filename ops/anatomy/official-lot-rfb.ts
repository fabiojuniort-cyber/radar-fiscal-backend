/**
 * OFFICIAL-LOT-RFB: reproducible analysis of the official RFB snapshots already collected (never promoted).
 * For each `<idAto>.json` + meta: check bytes against the recorded SHA-256, re-validate the representation (D03),
 * prepare (json-preparation) and run the full engine; record per-act metrics. `--write` regenerates the committed
 * baseline (`docs/anatomy/official-lot-rfb.json`); the unit test re-runs the lot and fails on any drift, so a change
 * that worsens the official acts (more unidentified text, lost parts, new limitations) cannot pass silently.
 * Synthetic-only rules do not apply here: these are official texts, read-only, outside corpus/gold/reserve.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRfbJson } from './fetch-official-core.js';
import { prepareRfbRepresentation, RFB_PREPARATION_VERSION, type JsonPreparation } from '../../src/modules/anatomy/json-preparation.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';

// R1-LOT-02: portable paths (fileURLToPath handles Windows drive letters and percent-encoding; URL.pathname does not).
export const LOT_DIR = fileURLToPath(new URL('./official-identification/rfb-normasinternet2/', import.meta.url));
export const BASELINE = fileURLToPath(new URL('../../docs/anatomy/official-lot-rfb.json', import.meta.url));

/** Preparation recorded in the snapshot meta at capture time (historical; never rewritten). */
export interface CapturedPreparation { preparationVersion: string; htmlSha256: string; pieces: number }
/**
 * R2-LOT-01: the preparation re-executed now is confronted with the one recorded at capture.
 * - `identical`: same version, same prepared-HTML hash and piece count;
 * - `d04_annotation_only`: captured with rfb-api-original/0.1.0, re-executed with 0.2.0 (ANAT-D04). The only change
 *   0.2.0 makes is adding `data-rfb-type`, `data-rfb-type-issue` and `data-rfb-tachado` attributes to the neutral
 *   `<section>` wrappers; removing exactly those attributes must reproduce the captured hash byte for byte.
 * Anything else (unknown version, hash or piece mismatch) throws: a provenance divergence is never silent.
 */
export type PreparationReconciliation = 'identical' | 'd04_annotation_only';
const D04_ATTRS = / data-rfb-type="[^"]*"| data-rfb-type-issue="[^"]*"| data-rfb-tachado="true"/gu;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export function reconcilePreparation(id: number, captured: CapturedPreparation | undefined, current: JsonPreparation): PreparationReconciliation {
  if (!captured) throw new Error(`${id}: snapshot meta has no captured preparation`);
  if (captured.pieces !== current.pieces.length) throw new Error(`${id}: piece count differs from the captured preparation`);
  if (captured.preparationVersion === current.preparationVersion) {
    if (captured.htmlSha256 !== current.htmlSha256) throw new Error(`${id}: same preparation version but prepared HTML differs from capture`);
    return 'identical';
  }
  if (captured.preparationVersion === 'rfb-api-original/0.1.0-provisional' && current.preparationVersion === RFB_PREPARATION_VERSION
    && RFB_PREPARATION_VERSION === 'rfb-api-original/0.2.0-provisional') {
    if (sha(current.html.replace(D04_ATTRS, '')) !== captured.htmlSha256) throw new Error(`${id}: 0.1.0 -> 0.2.0 delta is not annotation-only`);
    return 'd04_annotation_only';
  }
  throw new Error(`${id}: no proven transition ${captured.preparationVersion} -> ${current.preparationVersion}`);
}

export interface ActMetrics {
  idAto: number; epigrafe: string | null; dadosPublicacao: string | null; bytes: number; sha256: string; promoted: boolean;
  capturedPreparation: CapturedPreparation; preparationReconciliation: PreparationReconciliation;
  preparationVersion: string; preparedHtmlSha256: string; status: string; canonicalChars: number; unidentifiedChars: number;
  partTypes: Record<string, number>; limitations: Record<string, number>; /** Parts carrying the `rfb_tachado_source` reason (source evidence), not a count of `context === 'historical'`. */
  historicalByTachado: number; historicalContextParts: number; struckSegments: number;
  attachmentsWithoutContent: number; missingSegments: number; outputHash: string;
}

export function analyzeLot(dir = LOT_DIR): { engineBuildHash: string; acts: ActMetrics[] } {
  const ids = readdirSync(dir).filter((f) => /^\d+\.json$/u.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b);
  const acts = ids.map((id): ActMetrics => {
    const body = readFileSync(join(dir, `${id}.json`));
    const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), 'utf8')) as { sha256: string; promoted?: boolean; preparation?: CapturedPreparation };
    const sha256 = sha(body);
    if (sha256 !== meta.sha256) throw new Error(`${id}: snapshot bytes differ from the recorded SHA-256`);
    const v = validateRfbJson(body, id); if ('problem' in v) throw new Error(`${id}: ${v.problem}`);
    const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id);
    const preparationReconciliation = reconcilePreparation(id, meta.preparation, p);
    const capturedPreparation: CapturedPreparation = { preparationVersion: meta.preparation!.preparationVersion, htmlSha256: meta.preparation!.htmlSha256, pieces: meta.preparation!.pieces };
    const r = analyzeAnatomy({ publicationVersionId: `rfb:${id}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
      input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html }, catalog: { edition: 'none', codes: [] } });
    const partTypes: Record<string, number> = {}; const limitations: Record<string, number> = {}; let unidentifiedChars = 0;
    for (const x of r.parts) { partTypes[x.type] = (partTypes[x.type] ?? 0) + 1; if (x.type === 'unidentified') unidentifiedChars += x.span.end - x.span.start; }
    for (const l of r.limitations) limitations[l.code] = (limitations[l.code] ?? 0) + 1;
    if (r.parts.some((x) => x.legalStatus !== 'unknown')) throw new Error(`${id}: legalStatus must stay unknown`);
    return { idAto: id, epigrafe: v.identification.epigrafe, dadosPublicacao: v.identification.dadosPublicacao, bytes: body.length, sha256,
      promoted: meta.promoted === true, capturedPreparation, preparationReconciliation, preparationVersion: p.preparationVersion, preparedHtmlSha256: p.htmlSha256, status: r.status,
      canonicalChars: r.canonicalText.length, unidentifiedChars, partTypes, limitations,
      historicalByTachado: r.parts.filter((x) => x.contextReasons.includes('rfb_tachado_source')).length,
      historicalContextParts: r.parts.filter((x) => x.context === 'historical').length,
      struckSegments: v.preparation.struckSegments.length, attachmentsWithoutContent: v.preparation.attachments.length,
      missingSegments: v.preparation.missingSegments.length, outputHash: r.outputHash };
  });
  return { engineBuildHash: ANATOMY_ENGINE_BUILD_HASH, acts };
}

/** R1-LOT-02: portable entry-point check (resolved filesystem paths, not a suffix match on the URL). */
export function isCliEntry(metaUrl: string, argv1: string | undefined): boolean {
  return !!argv1 && resolve(argv1) === fileURLToPath(metaUrl);
}

export function runCli(argv: string[]): void {
  const lot = analyzeLot();
  const at = argv.indexOf('--baseline'); const out = at >= 0 && argv[at + 1] ? resolve(argv[at + 1]!) : BASELINE;
  if (argv.includes('--write')) writeFileSync(out, `${JSON.stringify(lot, null, 2)}\n`);
  for (const a of lot.acts) console.log(`${a.idAto} ${a.epigrafe} | ${a.status} | prep ${a.preparationReconciliation} | chars ${a.canonicalChars} | unidentified ${a.unidentifiedChars} | hist ${a.historicalByTachado} | att ${a.attachmentsWithoutContent}`);
}

if (isCliEntry(import.meta.url, process.argv[1])) runCli(process.argv.slice(2));
