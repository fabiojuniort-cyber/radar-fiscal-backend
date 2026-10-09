/**
 * TAX13-ARCH-02 — non-normative compatibility probe over 20 official CONFAZ HTML pages.
 * HTTP read-only, no production DB, no legal assertions and no CURRENT claims.
 * A synthetic ALL-EDITORIAL manifest tests parser integrity, not legal force.
 * This is a convenience sample; R8 still requires a representative stratified corpus.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractActBodyHtml } from '../src/modules/collection/confaz.connector.js';
import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';
import {
  brazilLegalReferenceDate, renderedLegalText, validateLegalScopeEvidence,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { buildLegalProofV2 } from '../src/modules/taxonomy/legal-scope/legal-proof-v2.js';

assert.equal(process.env.NODE_ENV, 'test', 'disposable test mode only');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub disposable runner only');
assert.equal(process.env.TAX13_ARCH02_OFFICIAL_CORPUS_READONLY, 'true', 'explicit official corpus opt-in');

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const samples = [
  ...Array.from({ length: 7 }, (_, i) => [2025, i + 1]),
  ...Array.from({ length: 10 }, (_, i) => [2026, i + 1]),
  [1991, 52], [1997, 100], [2018, 142],
] as const;
const output = join(process.cwd(), 'audit-artifacts', 'tax13-confaz-20');

test('TAX13 R8-prep: 20 official CONFAZ HTML samples preserve raw bytes and are structurally inspectable', async () => {
  await mkdir(output, { recursive: true });
  const report: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const referenceDate = brazilLegalReferenceDate();
  const recheckOn = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  for (let first = 0; first < samples.length; first += 4) {
    await Promise.all(samples.slice(first, first + 4).map(async ([year, number]) => {
      const name = 'CV' + String(number).padStart(3, '0') + '_' + String(year).slice(-2);
      const url = 'https://www.confaz.fazenda.gov.br/legislacao/convenios/' + year + '/' + name;
      const entry: Record<string, unknown> = { name, url, requestedAt: new Date().toISOString() };
      try {
        let rawBytes: Buffer;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          entry.httpStatus = response.status;
          assert.equal(response.status, 200, 'official response required: ' + name);
          rawBytes = Buffer.from(await response.arrayBuffer());
          entry.transport = 'NODE_FETCH';
          entry.contentType = response.headers.get('content-type');
        } catch (nodeError) {
          // node-fetch/undici and curl use different TLS/proxy stacks on the
          // hosted runner. Do not count either error as an HTML parser failure.
          const nodeReason = nodeError instanceof Error
            ? String(nodeError.cause ?? nodeError.message).slice(0, 400)
            : String(nodeError).slice(0, 400);
          entry.nodeTransportError = nodeReason;
          try {
            rawBytes = execFileSync('curl', [
              '--fail', '--location', '--silent', '--show-error',
              '--proto', '=https', '--proto-redir', '=https',
              '--connect-timeout', '12', '--max-time', '35',
              '--retry', '1', '--retry-delay', '1', '--url', url,
            ], { maxBuffer: 16 * 1024 * 1024, timeout: 40_000 });
            entry.transport = 'CURL_HTTPS_FALLBACK';
          } catch (curlError) {
            const curlReason = curlError instanceof Error ? curlError.message.slice(0, 400)
              : String(curlError).slice(0, 400);
            throw new Error('OFFICIAL_SOURCE_UNAVAILABLE node=' + nodeReason +
              ' curl=' + curlReason);
          }
        }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
        assert.ok(raw.includes('CONVÊNIO') || raw.includes('CONV&Ecirc;NIO'), name + ': unexpected body');
        await writeFile(join(output, name + '.html'), rawBytes);
        entry.rawBytes = rawBytes.length;
        entry.rawSha256 = sha(rawBytes);
        const body = extractActBodyHtml(raw);
        assert.ok(body, name + ': legal body missing');
        const sanitized = sanitizeLegalPresentationHtml(body);
        assert.ok(sanitized, name + ': sanitized body missing');
        assert.equal(sanitizeLegalPresentationHtml(sanitized), sanitized, name + ': sanitizer not idempotent');
        const text = renderedLegalText(sanitized);
        assert.ok(text.trim().length > 0, name + ': empty decoded text');
        const evidence = {
          version: 1 as const,
          publicationVersionId: randomUUID(),
          sourceId: randomUUID(),
          officialUrl: url,
          htmlSha256: sha(sanitized),
          validAsOf: referenceDate,
          verifiedAt: new Date(Date.now() - 60_000).toISOString(),
          recheckOn,
          coverage: 'COMPLETE' as const,
          segments: [{
            start: 0, end: text.length, textSha256: sha(text),
            status: 'EDITORIAL' as const,
            method: 'ORIGINAL_PUBLICATION' as const,
            evidenceUrls: [url],
          }],
        };
        const context = {
          publicationVersionId: evidence.publicationVersionId,
          sourceId: evidence.sourceId,
          officialUrl: url,
          sanitizedHtml: sanitized,
          validAsOf: referenceDate,
          trustedAttestor: true,
          trustedEvidenceHosts: ['www.confaz.fazenda.gov.br'],
        };
        const check = validateLegalScopeEvidence(evidence, context);
        assert.equal(check.valid, true, name + ': structural parser refused editorial-only manifest: ' + check.reason);
        assert.equal(check.currentSegments, 0, name + ': no human/official CURRENT proof was provided');
        assert.throws(() => buildLegalProofV2(evidence, context, {
          proofId: randomUUID(), attestationId: randomUUID(),
          rawArtifactSha256: sha(rawBytes),
          presentationArtifactSha256: sha(sanitized),
          parserBuildDigest: 'a'.repeat(64),
          parserVersion: 'R8_STRUCTURAL_ONLY', sanitizerVersion: 'R8_STRUCTURAL_ONLY',
          legalPolicyVersion: 'R8_STRUCTURAL_ONLY',
          issuerId: 'R8_READONLY_STRUCTURAL_TEST',
          reviewDecisionId: 'NO_LEGAL_REVIEW',
        }), /TAX13_V2_COMPLETE_CURRENT_PROOF_REQUIRED/,
        name + ': parser MUST NOT promote an editorial-only sample to CURRENT');
        entry.structurallyCompatible = true;
        entry.sanitizedBytes = Buffer.byteLength(sanitized, 'utf8');
        entry.sanitizedSha256 = sha(sanitized);
        entry.decodedTextUnitsUtf16 = text.length;
        entry.parserValid = check.valid;
        entry.legalCurrentAttested = false;
      } catch (error) {
        entry.structurallyCompatible = false;
        entry.error = error instanceof Error ? error.message : String(error);
        failures.push(name + ': ' + entry.error);
      }
      report.push(entry);
    }));
  }
  report.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    sampleKind: 'R7_CONVENIENCE_20', representative: false,
    legallyAttested: false, source: 'OFFICIAL_CONFAZ_READONLY',
    referenceDate, recordedAt: new Date().toISOString(),
    total: samples.length, succeeded: samples.length - failures.length, failures, documents: report,
  }, null, 2));
  assert.equal(report.length, 20, 'all documented URLs must be attempted');
  assert.deepEqual(failures, [], 'a failed network/structural check is NOT VERIFIED, not success');
});