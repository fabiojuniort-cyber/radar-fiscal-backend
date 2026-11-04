/**
 * ANAT-OFFICIAL-01 R1-4/R1-5: promotion check of OFFICIAL_SAMPLES against verified snapshots. Each official sample
 * must have (a) a manifest entry with the same id and urlStatus 'verified', (b) <dir>/<id>.meta.json with the same URL,
 * verified=true and sha256 = provenance.snapshotSha256, (c) a snapshot file whose bytes hash to that sha256, and
 * (d) its content as an exact substring of the snapshot (no edited text).
 * R2-04: for a PDF snapshot, (d) is checked against the traceable extracted text (pdf-text.ts), never against the PDF
 * bytes decoded as UTF-8: the metadata must record `extraction: { tool, textSha256 }`, the tool must be the current
 * one, the text re-extracted now must hash to textSha256, and the sample content must be an exact substring of it.
 * The binary sha256 remains the identity of the original. HTML keeps the byte-level check.
 * ANAT-D03: for an RFB JSON snapshot, (d) is checked against the HTML PREPARED from the JSON by
 * `prepareRfbRepresentation` (the same preparation the anatomy reads): the metadata must record
 * `preparation.htmlSha256`, the JSON re-prepared now must hash to it, and the sample content must be an exact
 * substring of that prepared HTML. Traceability JSON pointer ↔ prepared text ↔ anatomy goes through
 * `locateJsonHtmlSpan`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SampleInput } from '../../src/modules/anatomy/config/sample-inputs.js';
import type { ManifestAct } from './fetch-official-core.js';
import { PDF_TEXT_TOOL, pdfText } from './pdf-text.js';
import { prepareRfbRepresentation } from '../../src/modules/anatomy/json-preparation.js';

export async function bindingIssues(samples: readonly SampleInput[], dir: string, manifest: readonly ManifestAct[], extract: (bytes: Uint8Array) => Promise<string> = pdfText): Promise<string[]> {
  const issues: string[] = [];
  for (const s of samples) {
    if (s.provenance.kind !== 'official') continue;
    const p = s.provenance; const bad = (m: string) => issues.push(`${s.id}: ${m}`);
    const entry = manifest.find((a) => a.id === s.id);
    if (!entry) { bad('sem entrada no manifesto'); continue; }
    if (entry.urlStatus !== 'verified') bad(`URL do manifesto não verificada (${entry.urlStatus})`);
    if (entry.url !== p.url) bad('URL difere do manifesto');
    const metaPath = join(dir, `${s.id}.meta.json`);
    if (!existsSync(metaPath)) { bad('sem metadados de snapshot'); continue; }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { url: string; sha256: string; verified: boolean; contentType: string; extraction?: { tool: string; textSha256: string };
      representation?: string; identification?: { idAto: number }; preparation?: { htmlSha256: string } };
    if (!meta.verified) bad('snapshot de URL candidata, não promovível');
    if (meta.url !== p.url) bad('URL difere do snapshot');
    if (meta.sha256 !== p.snapshotSha256) bad('SHA-256 difere do snapshot registrado');
    const isPdf = /pdf/iu.test(meta.contentType);
    const isJson = meta.representation === 'json';
    const file = join(dir, `${s.id}.${isJson ? 'json' : isPdf ? 'pdf' : 'html'}`);
    if (!existsSync(file)) { bad('arquivo de snapshot ausente'); continue; }
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) bad('snapshot adulterado: hash do arquivo não confere');
    if (isJson) {
      if (!meta.identification || !meta.preparation) { bad('JSON da RFB sem identificação/preparação registradas'); continue; }
      let html: string;
      try { const p = prepareRfbRepresentation({ resourceId: s.id, bytes: new Uint8Array(bytes) }, meta.identification.idAto); html = p.html;
        if (p.htmlSha256 !== meta.preparation.htmlSha256) bad('texto preparado do JSON não confere com preparation.htmlSha256'); }
      catch (e) { bad(`JSON da RFB não preparável: ${(e as Error).message}`); continue; }
      if (!html.includes(s.content)) bad('conteúdo da amostra não é recorte exato do texto preparado do JSON');
      continue;
    }
    if (!isPdf) { if (!bytes.toString('utf8').includes(s.content)) bad('conteúdo da amostra não é recorte exato do snapshot'); continue; }
    if (!meta.extraction) { bad('PDF sem extração rastreável registrada (extraction.tool/textSha256)'); continue; }
    if (meta.extraction.tool !== PDF_TEXT_TOOL) bad(`extração registrada com ferramenta diferente (${meta.extraction.tool})`);
    let text: string;
    try { text = await extract(new Uint8Array(bytes)); } catch (e) { bad(`PDF ilegível: ${(e as Error).message}`); continue; }
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== meta.extraction.textSha256) bad('texto extraído do PDF não confere com textSha256 registrado');
    if (!text.includes(s.content)) bad('conteúdo da amostra não é recorte exato do texto extraído do PDF');
  }
  return issues;
}
