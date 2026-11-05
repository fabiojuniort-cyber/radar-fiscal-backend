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
import { join } from 'node:path';
import { validateRfbJson } from './fetch-official-core.js';
import { prepareRfbRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';

export const LOT_DIR = new URL('./official-identification/rfb-normasinternet2/', import.meta.url).pathname;
export const BASELINE = new URL('../../docs/anatomy/official-lot-rfb.json', import.meta.url).pathname;

export interface ActMetrics {
  idAto: number; epigrafe: string | null; dadosPublicacao: string | null; bytes: number; sha256: string; promoted: boolean;
  preparationVersion: string; preparedHtmlSha256: string; status: string; canonicalChars: number; unidentifiedChars: number;
  partTypes: Record<string, number>; limitations: Record<string, number>; historicalByTachado: number; struckSegments: number;
  attachmentsWithoutContent: number; missingSegments: number; outputHash: string;
}

export function analyzeLot(dir = LOT_DIR): { engineBuildHash: string; acts: ActMetrics[] } {
  const ids = readdirSync(dir).filter((f) => /^\d+\.json$/u.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b);
  const acts = ids.map((id): ActMetrics => {
    const body = readFileSync(join(dir, `${id}.json`));
    const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), 'utf8')) as { sha256: string; promoted?: boolean };
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (sha256 !== meta.sha256) throw new Error(`${id}: snapshot bytes differ from the recorded SHA-256`);
    const v = validateRfbJson(body, id); if ('problem' in v) throw new Error(`${id}: ${v.problem}`);
    const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id);
    const r = analyzeAnatomy({ publicationVersionId: `rfb:${id}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
      input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html }, catalog: { edition: 'none', codes: [] } });
    const partTypes: Record<string, number> = {}; const limitations: Record<string, number> = {}; let unidentifiedChars = 0;
    for (const x of r.parts) { partTypes[x.type] = (partTypes[x.type] ?? 0) + 1; if (x.type === 'unidentified') unidentifiedChars += x.span.end - x.span.start; }
    for (const l of r.limitations) limitations[l.code] = (limitations[l.code] ?? 0) + 1;
    if (r.parts.some((x) => x.legalStatus !== 'unknown')) throw new Error(`${id}: legalStatus must stay unknown`);
    return { idAto: id, epigrafe: v.identification.epigrafe, dadosPublicacao: v.identification.dadosPublicacao, bytes: body.length, sha256,
      promoted: meta.promoted === true, preparationVersion: p.preparationVersion, preparedHtmlSha256: p.htmlSha256, status: r.status,
      canonicalChars: r.canonicalText.length, unidentifiedChars, partTypes, limitations,
      historicalByTachado: r.parts.filter((x) => x.contextReasons.includes('rfb_tachado_source')).length,
      struckSegments: v.preparation.struckSegments.length, attachmentsWithoutContent: v.preparation.attachments.length,
      missingSegments: v.preparation.missingSegments.length, outputHash: r.outputHash };
  });
  return { engineBuildHash: ANATOMY_ENGINE_BUILD_HASH, acts };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const lot = analyzeLot();
  if (process.argv.includes('--write')) writeFileSync(BASELINE, `${JSON.stringify(lot, null, 2)}\n`);
  for (const a of lot.acts) console.log(`${a.idAto} ${a.epigrafe} | ${a.status} | chars ${a.canonicalChars} | unidentified ${a.unidentifiedChars} | hist ${a.historicalByTachado} | att ${a.attachmentsWithoutContent}`);
}
