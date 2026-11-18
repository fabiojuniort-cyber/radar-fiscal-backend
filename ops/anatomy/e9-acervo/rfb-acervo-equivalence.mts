// Offline: compare RFB reading of the preserved JSON vs the Acervo-equivalent (connector path + sanitizer).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const R = process.argv[2]!;
const { prepareRfbRepresentation } = await import(join(R, 'src/modules/anatomy/json-preparation.ts'));
const { analyzeAnatomy } = await import(join(R, 'src/modules/anatomy/engine.ts'));
const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(R, 'src/modules/anatomy/build-identity.ts'));
const { parseRfbApiRepresentation } = await import(join(R, 'src/modules/collection/rfb-normas.parser.ts'));
const { sanitizeLegalPresentationHtml } = await import(join(R, 'src/modules/collection/legal-presentation.ts'));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const dirs = ['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c'].map((d) => join(R, 'ops/anatomy/official-identification', d));
const size = (n: number) => (n < 10000 ? 'pequeno' : n < 50000 ? 'médio' : 'grande');
const run = (source: string, id: string, html: string) => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-09', ruleSet: { id: 'e9-acervo-equiv', version: '1' },
  input: { source, representationId: id, html }, catalog: { edition: 'none', codes: [] } });
const sum = (r: any) => {
  const unid = r.parts.filter((p: any) => p.type === 'unidentified').reduce((a: number, p: any) => a + p.span.end - p.span.start, 0);
  return { chars: r.canonicalText.length, status: r.status, parts: r.parts.length, unidentifiedChars: unid,
    declaredTypeParts: r.parts.filter((p: any) => p.contextReasons?.some((c: string) => c.startsWith('rfb_declared')) || /^rfb_declared/.test(p.reason ?? '')).length,
    historical: r.parts.filter((p: any) => p.context === 'historical').length,
    tachado: r.parts.filter((p: any) => p.contextReasons?.includes('rfb_tachado_source')).length,
    legalStatusNotUnknown: r.parts.filter((p: any) => p.legalStatus !== 'unknown').length,
    quotedOperative: r.parts.filter((p: any) => p.type === 'quoted_text' && p.context === 'operative_candidate').length };
};
const out: any[] = [];
for (const d of dirs) for (const f of readdirSync(d).filter((x) => /^\d+\.json$/.test(x))) {
  const id = Number(f.slice(0, -5)); const body = readFileSync(join(d, f)); const meta = JSON.parse(readFileSync(join(d, `${id}.meta.json`), 'utf8'));
  if (sha(body) !== meta.sha256) throw new Error(`${id}: sha mismatch`);
  const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes: new Uint8Array(body) }, id);
  const a = sum(run('RFB', `rfb:${id}`, p.html));
  const parsed = parseRfbApiRepresentation(JSON.parse(body.toString('utf8')));
  const san = sanitizeLegalPresentationHtml(parsed.presentationHtml);
  const b = san ? sum(run('DOU', `acervo-equiv:${id}`, san)) : null;
  out.push({ idAto: id, act: meta.identification?.epigrafe ?? meta.act, inputSha256: meta.sha256, bytes: body.length,
    contentTextChars: (parsed.normalizedText ?? '').length, sizeByContentText: size((parsed.normalizedText ?? '').length), sizeByEngine: size(a.chars),
    preparedRfbHtmlHasDataRfb: /data-rfb-/.test(p.html), sanitizedHasDataRfb: san ? /data-rfb-/.test(san) : null, sanitizedHtmlBytes: san ? Buffer.byteLength(san) : 0,
    rfbJson: a, acervoEquivalentAsDOU: b });
}
console.log(JSON.stringify({ engineBuildHash: ANATOMY_ENGINE_BUILD_HASH, acts: out }, null, 1));
