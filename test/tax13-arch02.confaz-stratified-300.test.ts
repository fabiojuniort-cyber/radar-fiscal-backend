/**
 * TAX13-ARCH-02 R8 preparation — 300 archived CONFAZ body HTML sources.
 * This is STRUCTURAL ONLY, never legal validity, and never an NCM positive.
 * Requires an exact, SHA256-pinned fixture; missing => NOT VERIFIED / CI FAIL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';
import { renderedLegalText } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.TAX13_ARCH02_OFFICIAL_CORPUS_READONLY, 'true');

const zipPath = join(process.cwd(), 'test', 'fixtures', 'tax13-confaz-stratified-300.zip');
const EXPECTED_SHA256 = '81709e9ba7e6ae032373ce8adff383e6bab726724ba5f639f1cd232c04e65e3c';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const output = join(process.cwd(), 'audit-artifacts', 'tax13-confaz-offline-300');
const ZIP_TIMEOUT_MS = 30_000;

type Entry = {
  category: string;
  year: string;
  sourceUrl: string;
  xmlPath: string;
  bodyHtmlPath: string;
  xmlSha256: string;
  bodyHtmlSha256: string;
  bodyHtmlBytes: number;
  legalCurrentStatus: string;
};
type Manifest = {
  schema: string;
  kind: string;
  count: number;
  legalAuthority: string;
  documents: Entry[];
};

function readZipEntry(entry: string): Buffer {
  assert.ok(/^(documentos_xml|corpo_html)\/[A-Za-z0-9_./-]+$/.test(entry)
    && !entry.split('/').includes('..'), 'TAX13_UNSAFE_ZIP_PATH');
  return execFileSync('unzip', ['-p', zipPath, entry],
    { timeout: ZIP_TIMEOUT_MS, maxBuffer: 24 * 1024 * 1024 });
}

test('TAX13 R8 preparation: 300 real CONFAZ body HTMLs remain structural-only', () => {
  assert.equal(sha(readFileSync(zipPath)), EXPECTED_SHA256,
    'TAX13_300_CORPUS_SHA256_MISMATCH');
  const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'],
    { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 })) as Manifest;
  assert.equal(manifest.schema, 'TRIBUSCA_CONFAZ_OFFLINE_CORPUS_V1');
  assert.equal(manifest.kind, 'STRATIFIED_300');
  assert.equal(manifest.count, 300);
  assert.equal(manifest.documents.length, 300);
  assert.ok(manifest.legalAuthority.startsWith('NONE'));

  const categories = new Set<string>();
  const years = new Set<string>();
  const sourceUrls = new Set<string>();
  let pass = 0;
  let unsupportedSize = 0;
  const errors: string[] = [];
  const observations: Record<string, unknown>[] = [];

  for (const entry of manifest.documents) {
    const audit: Record<string, unknown> = {
      sourceUrl: entry.sourceUrl, category: entry.category, year: entry.year,
      legalCurrent: 'UNVERIFIED', source: 'XML_EMBEDDED_BODY_HTML_NOT_RAW_HTTP',
      htmlSha256: entry.bodyHtmlSha256,
    };
    try {
      assert.ok(entry.sourceUrl.startsWith('https://www.confaz.fazenda.gov.br/'),
        'non-C ONFAZ hostname');
      assert.equal(entry.legalCurrentStatus, 'NOT_ATTESTED');
      assert.ok(!sourceUrls.has(entry.sourceUrl), 'duplicate URL in stratified sample');
      sourceUrls.add(entry.sourceUrl);
      categories.add(entry.category);
      years.add(entry.year);
      const xml = readZipEntry(entry.xmlPath);
      const bodyBytes = readZipEntry(entry.bodyHtmlPath);
      assert.equal(sha(xml), entry.xmlSha256, 'XML content modified');
      assert.equal(sha(bodyBytes), entry.bodyHtmlSha256, 'HTML body content modified');
      assert.equal(bodyBytes.byteLength, entry.bodyHtmlBytes);
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);

      if (bodyBytes.byteLength > MAX_INPUT_BYTES) {
        assert.equal(sanitizeLegalPresentationHtml(body), undefined,
          'large official HTML must reject, never be silently truncated');
        unsupportedSize++;
        audit.outcome = 'UNSUPPORTED_SIZE_LIMIT';
      } else {
        const sanitized = sanitizeLegalPresentationHtml(body);
        assert.ok(sanitized, 'sanitizer rejected below-limit HTML');
        assert.equal(sanitizeLegalPresentationHtml(sanitized), sanitized,
          'sanitizer not idempotent');
        const rendered = renderedLegalText(sanitized);
        assert.ok(rendered.trim().length > 0, 'rendered text missing');
        audit.outcome = 'PASS_STRUCTURAL_ONLY';
        audit.sanitizedSha256 = sha(sanitized);
        audit.utf16Units = rendered.length;
        pass++;
      }
    } catch (error) {
      audit.outcome = 'FAIL_STRUCTURE_OR_PROVENANCE';
      audit.reason = error instanceof Error ? error.message : String(error);
      errors.push(entry.bodyHtmlPath + ': ' + audit.reason);
    }
    observations.push(audit);
  }

  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'manifest.json'),
    JSON.stringify({
      inputZipSha256: EXPECTED_SHA256, originalHttpResponsesAvailable: false,
      legallyAttested: false, documents: observations.length,
      passedStructure: pass, unsupportedAbove2Mib: unsupportedSize,
      errors, observations,
    }, null, 2));

  assert.equal(categories.size, 6, 'stratified corpus lost one CONFAZ family');
  assert.equal(years.size, 61, 'stratified corpus lost chronological coverage');
  assert.equal(observations.length, 300);
  assert.equal(unsupportedSize, 4,
    'observed size-limit cases changed; inspect before modifying expectations');
  assert.equal(pass + unsupportedSize + errors.length, 300);
  assert.deepEqual(errors, [],
    'Unexpected incompatibility requires named failure, not fabricated CURRENT');
});
