import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareDouRepresentation, DOU_PREPARATION_VERSION } from '../../src/modules/anatomy/dou-preparation.js';
import { readAnatomyInput } from '../../src/modules/anatomy/readers.js';

/**
 * Freezes the canonical text of DEVELOPMENT corpus entries only. Reserved entries are refused before
 * any byte is read. Only hashes and lengths are recorded; the text itself is not duplicated.
 * Usage: tsx ops/anatomy/dev-canonical.ts [--write]   (without --write it verifies the frozen file)
 */
const root = new URL('../../', import.meta.url);
const manifestPath = new URL('test/fixtures/anatomy/corpus-manifest.json', root);
export const DEV_CANONICAL_PATH = new URL('test/fixtures/anatomy/canonical/development.json', root);
const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');

interface ManifestEntry { id: string; partition: string; source: 'CONFAZ' | 'DOU' | 'DOE-SP' | 'RFB'; inputs: { path: string; sha256: string }[] }

export function computeDevelopmentCanonical(): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: ManifestEntry[] };
  const entries = [];
  for (const e of manifest.entries) {
    if (e.partition !== 'development') continue; // reserved-final is never opened here
    if (!e.inputs.length) continue;
    const files = e.inputs.map((i) => {
      const bytes = readFileSync(new URL(i.path, root));
      if (sha(bytes) !== i.sha256) throw new Error(`Input hash mismatch for ${i.path}`);
      return { resourceId: i.path, bytes: new Uint8Array(bytes) };
    });
    let preparation: string; let html: string; let preparationId: string | null = null;
    if (e.source === 'DOU') {
      const p = prepareDouRepresentation(files);
      preparation = DOU_PREPARATION_VERSION; html = p.html; preparationId = p.preparationId;
    } else if (e.source === 'CONFAZ' && files.length === 1) {
      preparation = 'confaz-sanitized-html/1.0.0'; html = Buffer.from(files[0]!.bytes).toString('utf8');
    } else throw new Error(`No versioned preparation for ${e.source} entry ${e.id}`);
    const text = readAnatomyInput({ source: e.source, representationId: preparationId ?? e.inputs[0]!.path, html }).canonicalText;
    entries.push({ id: e.id, source: e.source, preparation, preparationId, inputs: e.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
      canonicalTextSha256: sha(Buffer.from(text, 'utf8')), canonicalTextUtf16Length: text.length });
  }
  return JSON.stringify({ version: 1, partition: 'development', unit: 'UTF-16', hash: 'SHA-256 of UTF-8 bytes of canonicalText',
    note: 'Hashes and lengths only. Changing the preparation or reader text extraction requires explicit regeneration and manual re-anchoring of gold.',
    entries }, null, 2) + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = computeDevelopmentCanonical();
  if (process.argv.includes('--write')) { writeFileSync(DEV_CANONICAL_PATH, next); console.log('ANAT development canonical text frozen'); }
  else if (readFileSync(DEV_CANONICAL_PATH, 'utf8').replace(/\r\n/g, '\n') !== next) throw new Error('ANAT development canonical text changed; regenerate explicitly and re-anchor gold');
  else console.log('ANAT development canonical text verified');
}
