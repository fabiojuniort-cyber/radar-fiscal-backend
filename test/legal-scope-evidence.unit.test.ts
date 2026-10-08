import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  brazilLegalReferenceDate,
  renderedLegalText,
  validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
  type LegalScopeValidationContext,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';

import { verifyPersistedLegalScopeRow, type AttestationRow } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const html = '<p>ANEXO II</p><table><tr><td>8701.90.00 revogado</td>' +
  '<td>7307.19.20 vigente</td></tr></table>';
const text = renderedLegalText(html);
const current = '7307.19.20 vigente';
const start = text.indexOf(current);
const ctx: LegalScopeValidationContext = {
  publicationVersionId: '00000000-0000-4000-8000-000000000001',
  sourceId: 'registered-confaz-id',
  officialUrl: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91',
  sanitizedHtml: html,
  validAsOf: '2026-10-08',
  trustedAttestor: true,
  trustedEvidenceHosts: ['www.confaz.fazenda.gov.br'],
};
const manifest = (): LegalScopeEvidenceV1 => ({
  version: 1,
  publicationVersionId: ctx.publicationVersionId,
  sourceId: ctx.sourceId,
  officialUrl: ctx.officialUrl,
  htmlSha256: digest(html),
  validAsOf: ctx.validAsOf,
  verifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
  recheckOn: '2026-10-20',
  coverage: 'PARTIAL',
  segments: [{
    start, end: start + current.length,
    textSha256: digest(current),
    status: 'CURRENT',
    method: 'OFFICIAL_CONSOLIDATION',
    evidenceUrls: ['https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91'],
    supportingActs: ['CONVÊNIO ICMS 52/91'],
  }],
});

test('TAX13 B4 accepts only the attested cell and excludes older sibling', () => {
  assert.ok(start > 0);
  assert.equal(text.slice(start, start + current.length), current);
  const r = validateLegalScopeEvidence(manifest(), ctx);
  assert.equal(r.valid, true);
  assert.equal(r.currentText, current);
  assert.deepEqual(r.currentFragments, [current]);
  assert.equal(r.coverage, 'PARTIAL');
  assert.equal(r.currentSegments, 1);
  assert.doesNotMatch(r.currentText, /8701\.90\.00|ANEXO II/);
});

test('TAX13 B4 preserves separate CURRENT fragments without manufacturing legal text', () => {
  const splitHtml = '<p>Crédito</p><p>presumido</p>';
  const splitText = renderedLegalText(splitHtml);
  const first = 'Crédito';
  const second = 'presumido';
  assert.equal(splitText, first + second);
  const attestation = manifest();
  attestation.htmlSha256 = digest(splitHtml);
  attestation.segments = [
    { start: 0, end: first.length, textSha256: digest(first), status: 'CURRENT',
      method: 'OFFICIAL_CONSOLIDATION', evidenceUrls: [ctx.officialUrl] },
    { start: first.length, end: splitText.length, textSha256: digest(second), status: 'CURRENT',
      method: 'OFFICIAL_CONSOLIDATION', evidenceUrls: [ctx.officialUrl] },
  ];
  const result = validateLegalScopeEvidence(attestation, { ...ctx, sanitizedHtml: splitHtml });
  assert.equal(result.valid, true);
  assert.equal(result.currentText, 'Crédito\\npresumido'.replace('\\n', '\n'));
  assert.deepEqual(result.currentFragments, [first, second]);
});

test('TAX13 B4 refuses forged status in source HTML without internal attestation', () => {
  const forged = html.replace('<td>7307', '<td data-legal-status="current">7307');
  const untrusted = validateLegalScopeEvidence(manifest(), { ...ctx, sanitizedHtml: forged, trustedAttestor: false });
  assert.deepEqual({valid:untrusted.valid, reason:untrusted.reason}, {valid:false,reason:'UNTRUSTED_ATTESTOR'});
  const drifted = validateLegalScopeEvidence(manifest(), { ...ctx, sanitizedHtml: forged });
  assert.equal(drifted.reason, 'HTML_HASH_MISMATCH');
  assert.equal(drifted.currentText, '');
});

test('TAX13 B4 rejects a scope from a different publication/version/source or date', () => {
  const mismatches = [
    [ctx.publicationVersionId + '-other', 'WRONG_PUBLICATION_OR_SOURCE', 'publicationVersionId'],
    ['different-source', 'WRONG_PUBLICATION_OR_SOURCE', 'sourceId'],
    ['2026-10-09', 'REFERENCE_DATE_MISMATCH', 'validAsOf'],
  ] as const;
  for (const [value, reason, key] of mismatches) {
    const actual = validateLegalScopeEvidence(manifest(), { ...ctx, [key]: value });
    assert.equal(actual.reason, reason);
  }
  const unregistered = validateLegalScopeEvidence(manifest(), { ...ctx, trustedEvidenceHosts: [] });
  assert.equal(unregistered.reason, 'SOURCE_NOT_REGISTERED');
});

test('TAX13 B4 rejects expired, undated and untrusted legal evidence', () => {
  assert.equal(validateLegalScopeEvidence({...manifest(), recheckOn:'2026-10-08'},ctx).reason, 'EVIDENCE_EXPIRED');
  assert.equal(validateLegalScopeEvidence({...manifest(), validAsOf:'2026-02-30'},ctx).reason,'REFERENCE_DATE_MISMATCH');
  assert.equal(validateLegalScopeEvidence({...manifest(), officialUrl:'https://example.invalid/act'},ctx).reason,'SOURCE_URL_MISMATCH');
  const badUrl=manifest();
  badUrl.segments[0]!.evidenceUrls=['https://attacker.example/act'];
  assert.equal(validateLegalScopeEvidence(badUrl,ctx).reason,'UNTRUSTED_EVIDENCE_URL');
  badUrl.segments[0]!.evidenceUrls=['https://www.confaz.fazenda.gov.br:8443/alteracao'];
  assert.equal(validateLegalScopeEvidence(badUrl,ctx).reason,'UNTRUSTED_EVIDENCE_URL');
  const original=manifest();
  original.segments[0]!.method='ORIGINAL_PUBLICATION';
  assert.equal(validateLegalScopeEvidence(original,ctx).reason,'CURRENT_WITHOUT_OFFICIAL_PROOF');
});

test('TAX13 B4 refuses changed fragment, gaps with overlapping attestations, and missing proof', () => {
  const tamper=manifest();
  tamper.segments[0]!.textSha256=digest('pretended current');
  assert.equal(validateLegalScopeEvidence(tamper,ctx).reason,'FRAGMENT_HASH_MISMATCH');
  const overlapping=manifest();
  overlapping.segments.push({...overlapping.segments[0]!});
  assert.equal(validateLegalScopeEvidence(overlapping,ctx).reason,'INVALID_SEGMENT_BOUNDS');
  const noUrl=manifest();
  noUrl.segments[0]!.evidenceUrls=[];
  assert.equal(validateLegalScopeEvidence(noUrl,ctx).reason,'CURRENT_WITHOUT_OFFICIAL_PROOF');
  const noManifest=validateLegalScopeEvidence(null,ctx);
  assert.equal(noManifest.reason,'EVIDENCE_MISSING');
  assert.equal(noManifest.currentText,'');
});

test('TAX13 B4 allows recorded UNVERIFIED fragment but never promotes it to current', () => {
  const uncertain=manifest();
  uncertain.segments[0]!.status='UNVERIFIED';
  uncertain.segments[0]!.method='ORIGINAL_PUBLICATION';
  uncertain.segments[0]!.evidenceUrls=[];
  const result=validateLegalScopeEvidence(uncertain,ctx);
  assert.equal(result.valid,true);
  assert.equal(result.currentText,'');
  assert.equal(result.currentSegments,0);
});

test('TAX13 B4 fails closed on malformed persisted evidence JSON', () => {
  const invalid = manifest() as unknown as { segments: unknown };
  invalid.segments = null;
  assert.equal(validateLegalScopeEvidence(invalid as unknown as LegalScopeEvidenceV1, ctx).reason, 'INVALID_SEGMENTS');
  invalid.segments = [null];
  assert.equal(validateLegalScopeEvidence(invalid as unknown as LegalScopeEvidenceV1, ctx).reason, 'INVALID_SEGMENT');
});

test('TAX13 B4 verified ledger row is the only trusted source of active fragment', () => {
  const valid=manifest();
  const row: AttestationRow = {
    id:'00000000-0000-4000-8000-000000000002',
    manifest:valid,
    source_id:ctx.sourceId,
    source_code:'confaz',
    official_url:ctx.officialUrl,
    origin_url:ctx.officialUrl,
    html_sha256:valid.htmlSha256,
    valid_as_of:valid.validAsOf,
    recheck_on:valid.recheckOn,
    verified_at:new Date(valid.verifiedAt),
    coverage:valid.coverage,
    attestor_kind:'HUMAN_REVIEW',
  };
  const input={publicationVersionId:ctx.publicationVersionId,sanitizedHtml:html,asOf:ctx.validAsOf};
  const result=verifyPersistedLegalScopeRow(row,input);
  assert.equal(result.valid,true);
  assert.equal(result.currentText,current);
  assert.equal(result.attestationId,row.id);
  assert.equal(verifyPersistedLegalScopeRow(undefined,input).reason,'ATTESTATION_MISSING');
  assert.equal(verifyPersistedLegalScopeRow({...row,source_code:'unknown-source'},input).reason,'SOURCE_ADAPTER_NOT_ATTESTED');
  assert.equal(verifyPersistedLegalScopeRow({...row,html_sha256:digest('other')},input).reason,'ATTESTATION_RECORD_MISMATCH');
  assert.equal(verifyPersistedLegalScopeRow({...row,origin_url:'https://attacker.example'},input).reason,'ATTESTATION_RECORD_MISMATCH');
  assert.equal(verifyPersistedLegalScopeRow({...row,attestor_kind:'REMOTE_METADATA'},input).reason,'ATTESTATION_RECORD_MISMATCH');
});

test('TAX13 B4 normative date is Brazil-local at UTC midnight boundary', () => {
  assert.equal(brazilLegalReferenceDate(new Date('2026-10-08T01:59:59.000Z')), '2026-10-07');
  assert.equal(brazilLegalReferenceDate(new Date('2026-10-08T03:00:00.000Z')), '2026-10-08');
});

test('TAX13 B4 COMPLETE must cover all non-whitespace legal text, including history', () => {
  const partial = manifest();
  partial.coverage = 'COMPLETE';
  assert.equal(validateLegalScopeEvidence(partial, ctx).reason, 'INCOMPLETE_SCOPE_COVERAGE');

  const reviewed = manifest();
  reviewed.coverage = 'COMPLETE';
  const leading = text.slice(0, start);
  const tail = text.slice(start + current.length);
  reviewed.segments = [
    {start:0,end:start,textSha256:digest(leading),status:'PREVIOUS',
      method:'ORIGINAL_PUBLICATION', evidenceUrls:[]},
    {...reviewed.segments[0]!},
  ];
  if (tail.trim()) {
    reviewed.segments.push({
      start:start + current.length,end:text.length,textSha256:digest(tail),
      status:'UNVERIFIED',method:'ORIGINAL_PUBLICATION',evidenceUrls:[],
    });
  }
  const accepted=validateLegalScopeEvidence(reviewed,ctx);
  assert.equal(accepted.valid,true);
  assert.equal(accepted.currentText,current);
});

test('TAX13 refuses CURRENT crossing adjacent clauses and table cells', () => {
  const cases = [
    '<p>Crédito</p><p>presumido</p>',
    '<table><tr><td>Crédito</td><td>presumido</td></tr></table>',
    '<p>cClassTrib</p><span>200034</span>',
  ];
  for (const legalHtml of cases) {
    const joined = renderedLegalText(legalHtml);
    const row = manifest();
    row.htmlSha256 = digest(legalHtml);
    row.segments = [{
      start: 0,
      end: joined.length,
      textSha256: digest(joined),
      status: 'CURRENT',
      method: 'OFFICIAL_CONSOLIDATION',
      evidenceUrls: [ctx.officialUrl],
    }];
    const result = validateLegalScopeEvidence(row, {
      ...ctx, sanitizedHtml: legalHtml,
    });
    assert.equal(result.reason, 'CURRENT_SPANS_DISTINCT_TEXT_NODES', legalHtml);
    assert.equal(result.currentText, '', legalHtml);
    assert.deepEqual(result.currentFragments, [], legalHtml);
  }
});

test('TAX13 accepts single-node CURRENT but never joins separately attested cells', () => {
  const legalHtml = '<table><tr><td>Crédito</td><td>presumido</td></tr></table>';
  const first = 'Crédito';
  const second = 'presumido';
  const row = manifest();
  row.htmlSha256 = digest(legalHtml);
  row.segments = [first, second].map((value, i) => ({
    start: i === 0 ? 0 : first.length,
    end: i === 0 ? first.length : first.length + second.length,
    textSha256: digest(value),
    status: 'CURRENT' as const,
    method: 'OFFICIAL_CONSOLIDATION' as const,
    evidenceUrls: [ctx.officialUrl],
  }));
  const result = validateLegalScopeEvidence(row, {
    ...ctx, sanitizedHtml: legalHtml,
  });
  assert.equal(result.valid, true);
  assert.equal(result.currentSegments, 2);
  assert.deepEqual(result.currentFragments, [first, second]);
});

test('TAX13 preserves COMPLETE historical coverage across nodes but refuses spanning CURRENT', () => {
  const legalHtml = '<p>Redação anterior</p><p>texto revogado</p><p>Texto atual</p>';
  const plain = renderedLegalText(legalHtml);
  const current = 'Texto atual';
  const offset = plain.indexOf(current);
  const row = manifest();
  row.htmlSha256 = digest(legalHtml);
  row.coverage = 'COMPLETE';
  row.segments = [
    { start: 0, end: offset, textSha256: digest(plain.slice(0, offset)),
      status: 'PREVIOUS', method: 'ORIGINAL_PUBLICATION', evidenceUrls: [] },
    { start: offset, end: plain.length, textSha256: digest(current),
      status: 'CURRENT', method: 'OFFICIAL_CONSOLIDATION', evidenceUrls: [ctx.officialUrl] },
  ];
  const result = validateLegalScopeEvidence(row, {
    ...ctx, sanitizedHtml: legalHtml,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.currentFragments, [current]);
});

test('TAX13 refuses malformed or excessive supportingActs and URL arrays', () => {
  const variations: Array<[unknown, string]> = [
    ['CONVÊNIO 10/26', 'INVALID_SUPPORTING_ACTS'],
    [[42], 'INVALID_SUPPORTING_ACTS'],
    [[''], 'INVALID_SUPPORTING_ACTS'],
    [['CONVÊNIO 10/26'.repeat(30)], 'INVALID_SUPPORTING_ACTS'],
    [Array.from({length: 26}, (_, i) => 'ACT ' + i), 'INVALID_SUPPORTING_ACTS'],
    [['ACT\nWITH NEWLINE'], 'INVALID_SUPPORTING_ACTS'],
  ];
  for (const [value, reason] of variations) {
    const row = manifest();
    row.segments[0]!.supportingActs = value as string[];
    assert.equal(validateLegalScopeEvidence(row, ctx).reason, reason);
  }
  const excessiveUrls = manifest();
  excessiveUrls.segments[0]!.evidenceUrls = Array.from({
    length: 26,
  }, () => ctx.officialUrl);
  assert.equal(validateLegalScopeEvidence(excessiveUrls, ctx).reason,
    'INVALID_EVIDENCE_URLS');
});

test('TAX13 refuses a valid raw hash for HTML that the public API would sanitize differently', () => {
  const variants = [
    // Removed attributes and hidden elements change the actual public body.
    '<p onclick="fakeCurrent()">NCM 7307.19.20 vigente</p>',
    '<p>NCM 7307.19.20 vigente</p><script>Revogado 8451.21.00</script>',
    // Legitimate attributes but different serialization order is still a
    // different HTML byte stream from the one shown by the product API.
    '<p data-legal-status="current" class="TextoAcordo">NCM 7307.19.20 vigente</p>',
  ];
  for (const raw of variants) {
    const row = manifest();
    row.htmlSha256 = digest(raw);
    const body = renderedLegalText(raw);
    const scoped = 'NCM 7307.19.20 vigente';
    const scopedStart = body.indexOf(scoped);
    row.segments = [{
      start: scopedStart,
      end: scopedStart + scoped.length,
      textSha256: digest(scoped),
      status: 'CURRENT',
      method: 'OFFICIAL_CONSOLIDATION',
      evidenceUrls: [ctx.officialUrl],
    }];
    const result = validateLegalScopeEvidence(row, {
      ...ctx, sanitizedHtml: raw,
    });
    assert.equal(result.reason, 'LEGAL_SCOPE_HTML_NOT_CANONICAL', raw);
    assert.equal(result.currentSegments, 0);
    assert.deepEqual(result.currentFragments, []);
  }
});

test('TAX13 accepts canonical sanitized legal HTML with unchanged bytes', () => {
  const html = '<p class="TextoAcordo" data-legal-status="current">NCM 7307.19.20 vigente</p>';
  const row = manifest();
  const scoped = renderedLegalText(html);
  row.htmlSha256 = digest(html);
  row.segments = [{
    start: 0,
    end: scoped.length,
    textSha256: digest(scoped),
    status: 'CURRENT',
    method: 'OFFICIAL_CONSOLIDATION',
    evidenceUrls: [ctx.officialUrl],
  }];
  const result = validateLegalScopeEvidence(row, {...ctx, sanitizedHtml: html});
  assert.equal(result.valid, true);
  assert.deepEqual(result.currentFragments, [scoped]);
});

test('TAX13 refuses CURRENT in legal titles, ementas, previous wording and explicit revoked cells', () => {
  const cases = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 100/97</p>',
    '<p class="Ementa">Crédito presumido para grãos</p>',
    '<p class="RedaoAnt"><strong>NCM 8451.21.00</strong></p>',
    '<table><tr><td class="A8-3TabelaTextoverde">8451.21.00</td></tr></table>',
    '<p data-legal-status="previous">Crédito presumido para grãos</p>',
    '<h2>Crédito presumido para grãos</h2>',
    '<p>Publicado no Diário Oficial da União em 2026.</p>',
    '<p>Cláusula terceira REVOGADA</p>',
  ];
  for (const legalHtml of cases) {
    const phrase = legalHtml.includes('<strong>')
      ? 'NCM 8451.21.00'
      : renderedLegalText(legalHtml);
    const decoded = renderedLegalText(legalHtml);
    const start = decoded.indexOf(phrase);
    const row = manifest();
    row.htmlSha256 = digest(legalHtml);
    row.segments = [{
      start, end: start + phrase.length,
      textSha256: digest(phrase),
      status: 'CURRENT', method: 'OFFICIAL_CONSOLIDATION',
      evidenceUrls: [ctx.officialUrl],
    }];
    const result = validateLegalScopeEvidence(row, {...ctx, sanitizedHtml: legalHtml});
    assert.equal(result.reason, 'CURRENT_IN_NON_NORMATIVE_SCOPE', legalHtml);
    assert.deepEqual(result.currentFragments, [], legalHtml);
  }
});

test('TAX13 propagates explicitly revoked annex context until a later annex heading', () => {
  const html = [
    '<p>ANEXO II - REVOGADO</p>',
    '<table><tr><td>8451.21.00</td></tr></table>',
    '<p>ANEXO III</p>',
    '<table><tr><td>3102.10.90</td></tr></table>',
  ].join('');
  const plain = renderedLegalText(html);
  for (const [fragment, expected] of [
    ['8451.21.00', 'CURRENT_IN_NON_NORMATIVE_SCOPE'],
    ['3102.10.90', null],
  ] as const) {
    const row = manifest();
    row.htmlSha256 = digest(html);
    const start = plain.indexOf(fragment);
    row.segments = [{
      start, end: start + fragment.length,
      textSha256: digest(fragment), status: 'CURRENT',
      method: 'OFFICIAL_CONSOLIDATION', evidenceUrls: [ctx.officialUrl],
    }];
    const result = validateLegalScopeEvidence(row, {...ctx, sanitizedHtml: html});
    assert.equal(result.reason, expected, fragment);
    assert.deepEqual(result.currentFragments, expected ? [] : [fragment], fragment);
  }
});

test('TAX13 preserves legal revocation language when it is operative normative text', () => {
  const html = '<p class="TextoAcordo">Ficam revogadas as disposições em contrário.</p>';
  const phrase = renderedLegalText(html);
  const row = manifest();
  row.htmlSha256 = digest(html);
  row.segments = [{
    start: 0, end: phrase.length, textSha256: digest(phrase),
    status: 'CURRENT', method: 'OFFICIAL_CONSOLIDATION',
    evidenceUrls: [ctx.officialUrl],
  }];
  const result = validateLegalScopeEvidence(row, {...ctx, sanitizedHtml: html});
  assert.equal(result.valid, true);
  assert.deepEqual(result.currentFragments, [phrase]);
});
