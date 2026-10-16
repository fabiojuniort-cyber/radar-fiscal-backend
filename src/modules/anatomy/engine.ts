import { z } from 'zod';
import { ANATOMY_ENGINE_BUILD_HASH } from './build-identity.js';
import { ANATOMY_CONTRACT_VERSION, anatomyIdentityHash, anatomyOutputHash, canonicalJson, sha256,
  validateAnatomyResult, type AnatomyResult } from './contract.js';
import { extractAnatomyEntities } from './entities.js';
import { readAnatomyInput, identifyNcmPartIds, ANATOMY_READER_LIMITS } from './readers.js';

export const ANATOMY_ENGINE_VERSION = 'anatomy/0.1.0' as const;
const requestSchema = z.strictObject({
  publicationVersionId: z.string().min(1).max(256),
  referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ruleSet: z.strictObject({ id: z.string().min(1).max(256), version: z.string().min(1).max(256) }),
  input: z.strictObject({ source: z.enum(['CONFAZ', 'DOU', 'DOE-SP', 'RFB']), representationId: z.string().min(1).max(256),
    html: z.string().optional(), text: z.string().optional(), missingResources: z.array(z.string().min(1)).optional() }),
  // A manifest is not proof that attachment contents were read. Unread material is always partial.
  attachments: z.array(z.strictObject({ resourceId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    state: z.enum(['missing', 'unprocessed']) })).default([]),
  catalog: z.strictObject({ edition: z.string().min(1), codes: z.array(z.string().regex(/^\d{4,8}$/)) }).optional(),
});
export type AnatomyRequest = z.input<typeof requestSchema>;

/** Offline analysis of supplied bytes only. This function has no persistence, HTTP or classification path. */
export function analyzeAnatomy(rawRequest: AnatomyRequest): AnatomyResult {
  const request = requestSchema.parse(rawRequest);
  if (request.input.html !== undefined && request.input.text !== undefined) throw new TypeError('Choose one concrete input representation');
  if (new Set(request.attachments.map(item => item.resourceId)).size !== request.attachments.length) throw new TypeError('Duplicate attachment identity');
  const attachments = [...request.attachments].sort((a, b) => a.resourceId.localeCompare(b.resourceId, 'en'));
  const missingResources = [...new Set([...(request.input.missingResources ?? []),
    ...attachments.map(item => `${item.state}:${item.resourceId}`)])].sort();
  const read = readAnatomyInput({ ...request.input, missingResources });
  const catalog = request.catalog && { edition: request.catalog.edition, codes: [...new Set(request.catalog.codes)].sort() };
  let entities: ReturnType<typeof extractAnatomyEntities> = [];
  try {
    entities = extractAnatomyEntities({ canonicalText: read.canonicalText, parts: read.parts, ncmPartIds: identifyNcmPartIds(read),
      ...(catalog ? { catalog } : {}) });
  } catch {
    read.status = 'partial';
    read.limitations.push({ code: 'entity_extraction_failed', message: 'Entity extraction failed; no positive selection is available.',
      partId: null, span: null });
  }
  const identity = { publicationVersionId: request.publicationVersionId, representationId: request.input.representationId,
    inputTextHash: sha256(read.canonicalText),
    inputPresentationHash: request.input.html === undefined ? null : sha256(request.input.html),
    attachmentManifestHash: sha256(canonicalJson(attachments)), engineVersion: ANATOMY_ENGINE_VERSION,
    engineHash: ANATOMY_ENGINE_BUILD_HASH,
    ruleSetId: request.ruleSet.id, ruleSetVersion: request.ruleSet.version,
    ruleSetHash: sha256(canonicalJson({ source: request.input.source, limits: ANATOMY_READER_LIMITS,
      profile: 'conservative/0.1.0', entityRules: 'entities/0.1.0', catalog: catalog ?? null })),
    contractVersion: ANATOMY_CONTRACT_VERSION };
  const result: AnatomyResult = { ...read, contractVersion: ANATOMY_CONTRACT_VERSION,
    analysisId: anatomyIdentityHash(identity), identity, referenceDate: request.referenceDate, entities, evidence: [],
    eligibility: [], outputHash: '' };
  for (const part of result.parts.filter(part => !['document', 'table', 'row'].includes(part.type))) {
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
