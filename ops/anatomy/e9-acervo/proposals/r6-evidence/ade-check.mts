// R6 J: ADE Cofis 30/2025 (rfb:148629) real reading in a given root
import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; import { join } from 'node:path';
const root = process.argv[2]!;
const { prepareRfbRepresentation } = await import(join(root, 'src/modules/anatomy/json-preparation.ts'));
const { analyzeAnatomy } = await import(join(root, 'src/modules/anatomy/engine.ts'));
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(root, 'src/modules/anatomy/build-identity.ts'));
const body = readFileSync(join(root, 'ops/anatomy/official-identification/rfb-p2c/148629.json'));
const p = prepareRfbRepresentation({ resourceId: 'rfb:148629', bytes: new Uint8Array(body) }, 148629);
const r = analyzeAnatomy({ publicationVersionId: 'rfb:148629', referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
  input: { source: 'RFB', representationId: 'rfb:148629', html: p.html }, catalog: { edition: 'none', codes: [] } });
const atts = readRfbInlineAttachments(new Uint8Array(body), 148629, { prep: p, parts: r.parts });
const out = atts.map((a: any) => {
  const parts = a.reading?.parts ?? []; const rows = parts.filter((x: any) => x.type === 'row').length; const cells = parts.filter((x: any) => x.type === 'cell').length;
  const ptrs = parts.flatMap((x: any) => x.sourcePointers ?? []);
  return { id: a.id ?? a.idArquivoBinario, state: a.state, referenceContext: a.referenceContext, evidence: a.referenceContextEvidence, sha256: a.sha256,
    tables: parts.filter((x: any) => x.type === 'table').length, rows, cells, pointers: `${ptrs.filter((q: any) => q?.sourceSpan).length}/${parts.filter((x: any) => x.type !== 'document').length}`, partsSha256: createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12),
    contexts: [...new Set(parts.filter((x: any) => x.type !== 'document').map((x: any) => x.context))], legalStatus: [...new Set(parts.map((x: any) => x.legalStatus))] };
});
console.log(JSON.stringify({ engine: ANATOMY_ENGINE_BUILD_HASH.slice(0, 8), bytesSha256: createHash('sha256').update(body).digest('hex').slice(0, 8), attachments: out }, null, 1));
