import { z } from 'zod';
import { ANATOMY_ENGINE_BUILD_HASH } from './build-identity.js';
import { ANATOMY_CONTRACT_VERSION, anatomyIdentityHash, anatomyOutputHash, canonicalJson, sha256,
  validateAnatomyResult, type AnatomyResult } from './contract.js';
import { extractAnatomyEntities, extractRecoveredEntities } from './entities.js';
import { NfcQuarantineError } from './nfc-recovery.js';
import { readAnatomyInput, identifyNcmPartIds, ANATOMY_READER_LIMITS, NON_NFC_TEXT, shadowContextOf } from './readers.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, resolveEffectiveProfile } from './profile.js';
import { compileProfileRules } from './profile-rules.js';
import type { SefazSpPortalPreparation } from './sefaz-sp-preparation.js';

export const ANATOMY_ENGINE_VERSION = 'anatomy/0.1.0' as const;
const requestSchema = z.strictObject({
  publicationVersionId: z.string().min(1).max(256),
  referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ruleSet: z.strictObject({ id: z.string().min(1).max(256), version: z.string().min(1).max(256) }),
  input: z.strictObject({ source: z.enum(['CONFAZ', 'DOU', 'DOE-SP', 'RFB', 'SEFAZ-SP-PORTAL']), representationId: z.string().min(1).max(256),
    html: z.string().optional(), text: z.string().optional(), missingResources: z.array(z.string().min(1)).optional(),
    // ANAT-L17: out-of-band provenance for SEFAZ-SP-PORTAL. Kept by reference (never cloned or rebuilt from data), so
    // only the object issued by prepareSefazSpPortalPage can pass verification; serialized JSON never does.
    sefazSpPortal: z.custom<SefazSpPortalPreparation>((v) => typeof v === 'object' && v !== null).optional() }),
  // A manifest is not proof that attachment contents were read. Unread material is always partial.
  attachments: z.array(z.strictObject({ resourceId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    state: z.enum(['missing', 'unprocessed']) })).default([]),
  catalog: z.strictObject({ edition: z.string().min(1), codes: z.array(z.string().regex(/^\d{4,8}$/)) }).optional(),
  // Rule profiles (ANAT-PROFILE/1). Omitted = the shipped DEFAULT_PROFILES. Validated and resolved fail-closed.
  profiles: z.array(z.unknown()).optional(),
  family: z.string().min(1).max(64).nullable().optional(),
});
export type AnatomyRequest = z.input<typeof requestSchema>;

/** Offline analysis of supplied bytes only. This function has no persistence, HTTP or classification path. */
export function analyzeAnatomy(rawRequest: AnatomyRequest): AnatomyResult {
  const request = requestSchema.parse(rawRequest);
  if (request.input.html !== undefined && request.input.text !== undefined) throw new TypeError('Choose one concrete input representation');
  // ANAT-L17: the portal proof belongs to its typed source only; any other source carrying it is refused (no mixing).
  if (request.input.sefazSpPortal !== undefined && request.input.source !== 'SEFAZ-SP-PORTAL') throw new TypeError('sefazSpPortal provenance is only valid for source SEFAZ-SP-PORTAL');
  if (new Set(request.attachments.map(item => item.resourceId)).size !== request.attachments.length) throw new TypeError('Duplicate attachment identity');
  const attachments = [...request.attachments].sort((a, b) => a.resourceId.localeCompare(b.resourceId, 'en'));
  const missingResources = [...new Set([...(request.input.missingResources ?? []),
    ...attachments.map(item => `${item.state}:${item.resourceId}`)])].sort();
  const effective = resolveEffectiveProfile(request.profiles ?? [...DEFAULT_PROFILES], { source: request.input.source, family: request.family ?? null });
  const rules = compileProfileRules(effective, request.input.source);
  const read = readAnatomyInput({ ...request.input, missingResources, rules });
  const catalog = request.catalog && { edition: request.catalog.edition, codes: [...new Set(request.catalog.codes)].sort() };
  let entities: ReturnType<typeof extractAnatomyEntities> = [];
  // UNICODE-01a/01b: a non-NFC document is either recovered through the reader's own NFC context (exact mapping,
  // partial, no positive selection) or quarantined: no entities, relations or NCM eligibility entries. A late
  // failure on the recovery path discards the WHOLE extraction (never only the failing exception or range).
  const recovered = shadowContextOf(read) !== undefined;
  const quarantined = !recovered && read.limitations.some((l) => l.code === NON_NFC_TEXT);
  if (!quarantined) try {
    const options = { ncmPartIds: identifyNcmPartIds(read, rules), ...(catalog ? { catalog } : {}), rules };
    entities = recovered ? extractRecoveredEntities(read, options)
      : extractAnatomyEntities({ canonicalText: read.canonicalText, parts: read.parts, ...options });
  } catch (error) {
    entities = [];
    read.status = 'partial';
    if (error instanceof NfcQuarantineError) {
      read.limitations.push({ code: error.code, partId: null, span: { start: 0, end: read.canonicalText.length },
        message: `NFC recovery could not be shown exact (${error.message}). Entity and relation extraction was not performed for this document (Unicode quarantine); text and positions are unchanged.` });
    } else {
      read.limitations.push({ code: 'entity_extraction_failed', message: 'Entity extraction failed; no positive selection is available.',
        partId: null, span: null });
    }
  }
  const identity = { publicationVersionId: request.publicationVersionId, representationId: request.input.representationId,
    inputTextHash: sha256(read.canonicalText),
    inputPresentationHash: request.input.html === undefined ? null : sha256(request.input.html),
    attachmentManifestHash: sha256(canonicalJson(attachments)), engineVersion: ANATOMY_ENGINE_VERSION,
    engineHash: ANATOMY_ENGINE_BUILD_HASH,
    ruleSetId: request.ruleSet.id, ruleSetVersion: request.ruleSet.version,
    // The effective profile (behaviour hash) replaces the former fixed label 'conservative/0.1.0'.
    ruleSetHash: sha256(canonicalJson({ source: request.input.source, limits: ANATOMY_READER_LIMITS,
      profile: { format: PROFILE_FORMAT_VERSION, effectiveHash: effective.effectiveHash }, entityRules: 'entities/0.1.0', catalog: catalog ?? null })),
    contractVersion: ANATOMY_CONTRACT_VERSION };
  const result: AnatomyResult = { ...read, contractVersion: ANATOMY_CONTRACT_VERSION,
    analysisId: anatomyIdentityHash(identity), identity, referenceDate: request.referenceDate, entities, evidence: [],
    eligibility: [], outputHash: '' };
  for (const part of result.parts.filter(part => !['document', 'table', 'row', 'caput'].includes(part.type))) {
    result.eligibility.push({ id: `text:${part.id}`, purpose: 'thematic_text', partId: part.id,
      entityId: null, span: part.span, eligible: false, evidenceIds: [],
      exclusionReasons: ['missing_approved_evidence', ...(part.context !== 'operative_candidate' ? [`context_${part.context}`] : [])] });
  }
  for (const entity of entities.filter(entity => ['NCM', 'NCM_RANGE', 'NCM_EXCEPTION'].includes(entity.domain))) {
    result.eligibility.push({ id: `ncm:${entity.id}`, purpose: 'ncm', partId: entity.partId,
      entityId: entity.id, span: entity.span, eligible: false, evidenceIds: [],
      exclusionReasons: ['missing_approved_evidence', ...(entity.relation ? ['compound_or_exception_scope'] : []),
        ...(entity.validation.status !== 'valid' ? [`validation_${entity.validation.status}`] : [])] });
  }
  result.outputHash = anatomyOutputHash(result);
  return validateAnatomyResult(result);
}
