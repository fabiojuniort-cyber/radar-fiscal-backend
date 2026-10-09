/**
 * TAX13-ARCH-02: offline, read-only structural compatibility corpus.
 * Uses user-supplied CONFAZ XML body HTML (NOT the raw HTTP page).
 * No database, no legal CURRENT promotion, no network dependency.
 *
 * Fixture is deliberately pinned to SHA256; never silently substitute data.
 * Required file: test/fixtures/tax13-confaz-offline-20.zip
 * Download package and SHA256 are recorded in tribusca-control#101.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { extractActBodyHtml } from '../src/modules/collection/confaz.connector.js';
import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';
import {
  brazilLegalReferenceDate, renderedLegalText, validateLegalScopeEvidence,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { buildLegalProofV2 } from '../src/modules/taxonomy/legal-scope/legal-proof-v2.js';

assert.equal(process.env.NODE_ENV, 'test', 'TAX13_OFFLINE_DISPOSABLE_TEST_ONLY');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'TAX13_OFFLINE_GITHUB_RUNNER_ONLY');
assert.equal(process.env.TAX13_ARCH02_OFFICIAL_CORPUS_READONLY, 'true',
  'TAX13_OFFLINE_CORPUS_EXPLICIT_OPT_IN_ONLY');

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const fixturePath = join(process.cwd(), 'test', 'fixtures', 'tax13-confaz-offline-20.zip');
const EXPECTED_ZIP_SHA = '892970d8891868d37350bb1403ceff218f551eb91f2c59441a000bc5331d4de0';

type CorpusDoc = {
  sourceUrl: string;
  xmlPath: string;
  bodyHtmlPath: string;
  xmlSha256: string;
  bodyHtmlSha256: string;
  bodyHtmlBytes: number;
  declaredOriginalHttpSha256_Unverified: string;
};
type CorpusManifest = {
  schema: string;
  kind: string;
  count: number;
  legalAuthority: string;
  documents: CorpusDoc[];
};

const cases = [
  ...Array.from({ length: 7 }, (_, i) => [2025, i + 1]),
  ...Array.from({ length: 10 }, (_, i) => [2026, i + 1]),
  [1991, 52], [1997, 100], [2018, 142],
] as const;
const outputDir = join(process.cwd(), 'audit-artifacts', 'tax13-confaz-offline-20');

function unzipEntry(entry: string): Buffer {
  assert.ok(
    /^(?:documentos_xml|corpo_html)\/[A-Za-z0-9_.\/-]+$/.test(entry) &&
      !entry.split('/').includes('..'),
    'TAX13_OFFLINE_UNSAFE_ENTRY_PATH',
  );
  return execFileSync('unzip', ['-p', fixturePath, entry], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
  });
}

test('TAX13 OFFLINE: 20 archived CONFAZ body HTML fixtures and legal fail-closed', async () => {
  // Deliberate FAIL/NOT VERIFIED until the exact, independently hash-pinned
  // corpus ZIP is staged. A missing fixture must never become a green result.
  const fixtureBytes = readFileSync(fixturePath);
  assert.equal(hash(fixtureBytes), EXPECTED_ZIP_SHA,
    'TAX13_OFFLINE_ARCHIVE_SHA_MISMATCH');
  const metadata = JSON.parse(execFileSync('unzip', ['-p', fixturePath, 'manifest.json'],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })) as CorpusManifest;
  assert.equal(metadata.schema, 'TRIBUSCA_CONFAZ_OFFLINE_CORPUS_V1');
  assert.equal(metadata.kind, 'LEGACY_CI_COMPATIBILITY_20');
  assert.equal(metadata.count, 20);
  assert.equal(metadata.documents.length, 20);
  assert.ok(metadata.legalAuthority.startsWith('NONE'));
  mkdirSync(outputDir, { recursive: true });

  const referenceDay = brazilLegalReferenceDate();
  const recheckOn = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const observations: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (const [year, number] of cases) {
    const label = 'CV' + String(number).padStart(3, '0') +
      '_' + String(year).slice(-2);
    const sourceUrl = 'https://www.confaz.fazenda.gov.br/legislacao/convenios/' +
      year + '/' + label;
    const row = metadata.documents.find((d) => d.sourceUrl === sourceUrl);
    assert.ok(row, label + ': official source URL absent from archived index');
    const audit: Record<string, unknown> = {
      label, sourceUrl,
      archiveSha256: EXPECTED_ZIP_SHA, transport: 'USER_XML_BODY_HTML_OFFLINE',
      originalHttpBytesAvailable: false, legallyAttested: false,
    };
    try {
      const xml = unzipEntry(row.xmlPath);
      const bodyBytes = unzipEntry(row.bodyHtmlPath);
      assert.equal(hash(xml), row.xmlSha256, label + ': XML SHA mismatch');
      assert.equal(hash(bodyBytes), row.bodyHtmlSha256,
        label + ': body HTML SHA mismatch');
      assert.equal(bodyBytes.length, row.bodyHtmlBytes,
        label + ': body HTML size mismatch');
      const bodyHtml = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
      // This div is SYNTHETIC: a scope-extractor contract probe, not a
      // reconstruction of the CONFAZ original HTTP wrapper.
      const wrapped = '<div id="parent-fieldname-text">' + bodyHtml + '</div>';
      assert.equal(extractActBodyHtml(wrapped), bodyHtml.trim(),
        label + ': synthetic Plone wrapper failed round trip');
      const sanitized = sanitizeLegalPresentationHtml(bodyHtml);
      assert.ok(sanitized, label + ': HTML sanitizer returned UNSUPPORTED');
      assert.equal(sanitizeLegalPresentationHtml(sanitized), sanitized,
        label + ': sanitizer is not idempotent');
      const text = renderedLegalText(sanitized);
      assert.ok(text.trim(), label + ': no legal text rendered');

      const evidence = {
        version: 1 as const,
        publicationVersionId: randomUUID(), sourceId: randomUUID(),
        officialUrl: sourceUrl, htmlSha256: hash(sanitized),
        validAsOf: referenceDay,
        verifiedAt: new Date(Date.now() - 60_000).toISOString(),
        recheckOn, coverage: 'COMPLETE' as const,
        segments: [{
          start: 0, end: text.length, textSha256: hash(text),
          status: 'EDITORIAL' as const, method: 'ORIGINAL_PUBLICATION' as const,
          evidenceUrls: [sourceUrl],
        }],
      };
      const ctx = {
        publicationVersionId: evidence.publicationVersionId,
        sourceId: evidence.sourceId,
        officialUrl: sourceUrl, sanitizedHtml: sanitized,
        validAsOf: referenceDay, trustedAttestor: true,
        trustedEvidenceHosts: ['www.confaz.fazenda.gov.br'],
      };
      const result = validateLegalScopeEvidence(evidence, ctx);
      assert.equal(result.valid, true,
        label + ': Node structural parser rejected synthetic ALL-EDITORIAL:' +
          result.reason);
      assert.equal(result.currentSegments, 0);
      assert.throws(() => buildLegalProofV2(evidence, ctx, {
        proofId: randomUUID(), attestationId: randomUUID(),
        rawArtifactSha256: row.declaredOriginalHttpSha256_Unverified,
        presentationArtifactSha256: hash(sanitized),
        parserBuildDigest: 'a'.repeat(64),
        parserVersion: 'OFFLINE_STRUCTURAL_ONLY',
        sanitizerVersion: 'OFFLINE_STRUCTURAL_ONLY',
        legalPolicyVersion: 'OFFLINE_STRUCTURAL_ONLY',
        issuerId: 'OFFLINE_TEST',
        reviewDecisionId: 'NO_OFFICIAL_LEGAL_REVIEW',
      }), /TAX13_V2_COMPLETE_CURRENT_PROOF_REQUIRED/,
      label + ': no synthetic document may become CURRENT');

      audit.outcome = 'PASS_STRUCTURAL_ONLY';
      audit.sanitizedHtmlSha256 = hash(sanitized);
      audit.textUnitsUtf16 = text.length;
      audit.legalCurrentAttested = false;
    } catch (error) {
      audit.outcome = 'FAIL_OR_UNSUPPORTED';
      audit.error = error instanceof Error ? error.message : String(error);
      failures.push(label + ': ' + audit.error);
    }
    observations.push(audit);
  }

  writeFileSync(join(outputDir, 'manifest.json'),
    JSON.stringify({
      corpusKind: 'USER_XML_OFFLINE_20_NOT_RAW_HTTP',
      originalHttpResponseAvailability: false,
      legallyAttested: false,
      referenceDay,
      cases: observations.length, failures,
      observations,
    }, null, 2));
  assert.equal(observations.length, 20);
  assert.deepEqual(failures, [],
    'Unsupported HTML is NOT VERIFIED; never silently mark CURRENT');
});
