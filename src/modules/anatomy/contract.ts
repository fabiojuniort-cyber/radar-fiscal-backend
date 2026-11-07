import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ANATOMY_CONTRACT_VERSION = 'ANAT-TAX/1.0.0' as const;
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const confidence = z.number().min(0).max(1);
export const spanSchema = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
export const sourcePointerSchema = z.strictObject({
  resourceId: id,
  representation: z.enum(['text', 'html', 'xml', 'attachment']),
  locator: z.string().min(1).max(4096),
  sourceSpan: spanSchema.nullable(),
});
export const anatomyIdentitySchema = z.strictObject({
  publicationVersionId: id,
  representationId: id,
  inputTextHash: hash,
  inputPresentationHash: hash.nullable(),
  attachmentManifestHash: hash,
  engineVersion: id,
  engineHash: hash,
  ruleSetId: id,
  ruleSetVersion: id,
  ruleSetHash: hash,
  contractVersion: z.literal(ANATOMY_CONTRACT_VERSION),
});
export const partSchema = z.strictObject({
  id,
  parentId: id.nullable(),
  order: z.number().int().nonnegative(),
  type: z.enum(['document', 'internal_act', 'publication_header', 'epigraph', 'summary', 'preamble',
    'consideration', 'group', 'article', 'clause', 'caput', 'paragraph', 'inciso', 'alinea', 'item',
    'annex', 'table', 'row', 'cell', 'signature', 'footer', 'editorial_note', 'quoted_text', 'body', 'unidentified']),
  label: z.string(),
  span: spanSchema,
  sourcePointers: z.array(sourcePointerSchema).min(1),
  recognition: z.enum(['explicit', 'inferred', 'reviewed', 'unidentified']),
  ruleId: id,
  confidence,
  coverage: z.enum(['complete', 'partial', 'unidentified']),
  context: z.enum(['operative_candidate', 'historical', 'prohibited', 'unknown']),
  contextReasons: z.array(id),
  legalStatus: z.enum(['unknown', 'current', 'repealed', 'replaced', 'future', 'suspended']),
  table: z.strictObject({ row: z.number().int().nonnegative(), column: z.number().int().nonnegative(),
    rowSpan: z.number().int().positive(), columnSpan: z.number().int().positive(),
    geometry: z.enum(['original', 'uniquely_reconstructed', 'unknown']) }).nullable(),
});
export const entitySchema = z.strictObject({
  id,
  partId: id,
  domain: z.enum(['NCM', 'NCM_RANGE', 'NCM_EXCEPTION', 'CITATION', 'LAW_NUMBER', 'CNPJ', 'CEP', 'PROCESS', 'DATE', 'CNAE', 'CFOP',
    'CST', 'CCLASSTRIB', 'CEST', 'REVENUE_CODE', 'NBM', 'SH', 'TIPI', 'OTHER']),
  literal: z.string().min(1),
  normalized: z.string().min(1),
  span: spanSchema,
  ruleId: id,
  confidence,
  validation: z.strictObject({ status: z.enum(['valid', 'invalid', 'unknown', 'informative']),
    method: z.enum(['format', 'catalog', 'none']), catalogEdition: id.nullable(), reason: id }),
  relation: z.strictObject({ kind: z.enum(['range', 'range_start', 'range_end', 'exception', 'exception_target']),
    groupId: id, targetEntityIds: z.array(id), operator: z.string().min(1),
    scopePartId: id, condition: z.string().nullable(), expansion: z.array(z.string()) }).nullable(),
});
export const evidenceSchema = z.strictObject({
  id,
  partId: id,
  scope: spanSchema,
  origin: z.literal('controlled_fixture'),
  approval: z.literal('approved'),
  reviewer: id,
  reviewedAt: z.string().datetime(),
  identityHash: hash,
  referenceDate: day,
  validFrom: day,
  validThrough: day,
  conclusion: z.enum(['current', 'repealed', 'replaced', 'future', 'suspended']),
  basis: z.string().min(1),
  officialUrl: z.string().url(),
  dependencies: z.array(z.strictObject({ reference: id, approvedHash: hash, observedHash: hash,
    effectsFrom: day, validThrough: day })),
});
export const eligibilitySchema = z.strictObject({
  id,
  purpose: z.enum(['thematic_text', 'ncm']),
  partId: id,
  entityId: id.nullable(),
  span: spanSchema,
  eligible: z.boolean(),
  evidenceIds: z.array(id),
  exclusionReasons: z.array(id),
});

/** Shape is JSON Schema exportable. Cross-reference rules are enforced by anatomyResultSchema. */
export const anatomyResultShapeSchema = z.strictObject({
  contractVersion: z.literal(ANATOMY_CONTRACT_VERSION),
  analysisId: hash,
  identity: anatomyIdentitySchema,
  canonicalText: z.string(),
  referenceDate: day,
  status: z.enum(['complete', 'partial', 'failed']),
  parts: z.array(partSchema).min(1),
  entities: z.array(entitySchema),
  evidence: z.array(evidenceSchema),
  eligibility: z.array(eligibilitySchema),
  sourceMap: z.array(z.strictObject({ span: spanSchema, pointer: sourcePointerSchema })),
  coverage: z.strictObject({
    unit: z.literal('UTF-16'),
    textLength: z.number().int().nonnegative(),
    accountedLength: z.number().int().nonnegative(),
    recognizedLength: z.number().int().nonnegative(),
    // Exclusive ownership segments; parent/container spans are not counted again.
    segments: z.array(z.strictObject({ span: spanSchema, partId: id, classification: z.enum(['recognized', 'unidentified']) })),
    missingResources: z.array(id),
  }),
  limitations: z.array(z.strictObject({ code: id, message: z.string().min(1), partId: id.nullable(),
    span: spanSchema.nullable() })),
  outputHash: hash,
});
export type AnatomyResult = z.infer<typeof anatomyResultShapeSchema>;
export type AnatomyIdentity = z.infer<typeof anatomyIdentitySchema>;
export type AnatomyPart = z.infer<typeof partSchema>;
export type AnatomyEntity = z.infer<typeof entitySchema>;

/** Objects sorted by key; arrays preserve semantic order. JSON primitives only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TypeError('Only finite JSON values are accepted');
}
export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const anatomyIdentityHash = (identity: AnatomyIdentity): string => sha256(canonicalJson(identity));
export function anatomyOutputHash(result: Omit<AnatomyResult, 'outputHash'> | AnatomyResult): string {
  const { outputHash: _ignored, ...semantic } = result as AnatomyResult;
  return sha256(canonicalJson(semantic));
}
const inside = (inner: { start: number; end: number }, outer: { start: number; end: number }): boolean =>
  inner.start >= outer.start && inner.end <= outer.end && inner.end >= inner.start;
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end;
const forbiddenTypes = new Set(['publication_header', 'epigraph', 'summary', 'preamble', 'consideration',
  'signature', 'footer', 'editorial_note', 'quoted_text', 'unidentified']);
const safeBoundary = (text: string, offset: number): boolean => !(offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));

export const anatomyResultSchema = anatomyResultShapeSchema.superRefine((result, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
  const text = result.canonicalText;
  const full = { start: 0, end: text.length };
  const checkSpan = (span: { start: number; end: number }, label: string): void => {
    if (!inside(span, full) || !safeBoundary(text, span.start) || !safeBoundary(text, span.end)) issue(`Invalid UTF-16 span: ${label}`);
  };
  if (sha256(text) !== result.identity.inputTextHash) issue('Input text hash mismatch');
  if (anatomyIdentityHash(result.identity) !== result.analysisId) issue('Analysis identity hash mismatch');
  if (anatomyOutputHash(result) !== result.outputHash) issue('Output hash mismatch');
  const dates = [result.referenceDate, ...result.evidence.flatMap((e) => [e.referenceDate, e.validFrom, e.validThrough,
    ...e.dependencies.flatMap((d) => [d.effectsFrom, d.validThrough])])];
  if (dates.some((date) => !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) issue('Invalid calendar date');
  const unique = <T extends { id: string }>(values: T[], label: string): Map<string, T> => {
    const map = new Map(values.map((value) => [value.id, value]));
    if (map.size !== values.length) issue(`Duplicate ${label} id`);
    return map;
  };
  const parts = unique(result.parts, 'part');
  const entities = unique(result.entities, 'entity');
  const evidence = unique(result.evidence, 'evidence');
  unique(result.eligibility, 'eligibility');
  const roots = result.parts.filter((part) => part.parentId === null);
  if (roots.length !== 1 || roots[0]?.type !== 'document' || roots[0].span.start !== 0 || roots[0].span.end !== text.length) issue('Exactly one full-text document root required');
  const positions = new Map(result.parts.map((part, index) => [part.id, index]));
  const siblings = new Map<string | null, AnatomyPart[]>();
  for (const part of result.parts) {
    checkSpan(part.span, part.id);
    if (part.sourcePointers.some((pointer) => pointer.sourceSpan && pointer.sourceSpan.end < pointer.sourceSpan.start)) issue(`Invalid part source span: ${part.id}`);
    if (part.parentId !== null) {
      const parent = parts.get(part.parentId);
      if (!parent || !inside(part.span, parent.span) || (positions.get(parent.id) ?? Infinity) >= (positions.get(part.id) ?? -1)) issue(`Invalid parent or tree order: ${part.id}`);
    }
    const group = siblings.get(part.parentId) ?? [];
    group.push(part); siblings.set(part.parentId, group);
    if ((part.coverage === 'unidentified' || part.recognition === 'unidentified') && part.type !== 'unidentified') issue(`Unidentified part must retain its explicit type: ${part.id}`);
    // ANAT-D05: an unidentified part is never operative. It may be 'historical' ONLY with traceable source evidence of
    // struck-through wording: the reason rfb_tachado_source AND a matching rfb_tachado_evidence record (same partId and
    // span). A reason alone, or evidence for another part/span, is refused. legalStatus is untouched (stays unknown).
    if (part.type === 'unidentified' && part.context !== 'unknown') {
      const evidenced = part.context === 'historical' && part.contextReasons.includes('rfb_tachado_source')
        && result.limitations.some((l) => l.code === 'rfb_tachado_evidence' && l.partId === part.id && l.span !== null && l.span.start === part.span.start && l.span.end === part.span.end);
      if (!evidenced) issue(`Unidentified part cannot assert operative context: ${part.id}`);
    }
  }
  for (const group of siblings.values()) {
    group.forEach((part, index) => {
      if (part.order !== index) issue(`Sibling order must be contiguous: ${part.id}`);
      if (index && part.span.start < group[index - 1]!.span.end) issue(`Overlapping siblings: ${part.id}`);
    });
  }
  for (const entity of result.entities) {
    checkSpan(entity.span, entity.id);
    const part = parts.get(entity.partId);
    if (!part || !inside(entity.span, part.span) || text.slice(entity.span.start, entity.span.end) !== entity.literal) issue(`Entity origin/literal mismatch: ${entity.id}`);
    if (entity.validation.method === 'catalog' && !entity.validation.catalogEdition) issue(`Catalog edition required: ${entity.id}`);
    if (entity.domain === 'NCM') {
      const digits = entity.literal.replace(/\./g, '');
      // Both common 4.2.2 and legacy 4.4 formatting survive; arbitrary dots do not.
      const validLiteral = /^(?:\d{2}|\d{4,8}|\d{4}\.\d{1,4}|\d{4}\.\d{2}\.\d{1,2})$/.test(entity.literal);
      if (!validLiteral || digits !== entity.normalized) issue(`Invalid NCM literal/normalization: ${entity.id}`);
      if (digits.length === 2 && entity.validation.status !== 'informative') issue(`Two-digit NCM is informative only: ${entity.id}`);
    }
    if (entity.relation) {
      if (!parts.has(entity.relation.scopePartId) || entity.relation.targetEntityIds.some((target) => !entities.has(target) || target === entity.id)) issue(`Invalid relation reference: ${entity.id}`);
      if (entity.relation.expansion.length && entity.relation.kind !== 'range') issue(`Only a range can carry an explicit expansion: ${entity.id}`);
    }
  }
  for (const item of result.evidence) {
    const part = parts.get(item.partId);
    checkSpan(item.scope, item.id);
    if (!part || !inside(item.scope, part.span) || item.identityHash !== result.analysisId) issue(`Evidence belongs to incompatible snapshot/part: ${item.id}`);
    if (item.referenceDate !== result.referenceDate || item.validThrough < item.validFrom) issue(`Evidence reference date/interval mismatch: ${item.id}`);
  }
  for (const selection of result.eligibility) {
    const part = parts.get(selection.partId);
    const entity = selection.entityId === null ? null : entities.get(selection.entityId);
    checkSpan(selection.span, selection.id);
    if (!part || !inside(selection.span, part.span) || (selection.entityId !== null && (!entity || entity.partId !== part.id || !inside(selection.span, entity.span)))) issue(`Invalid selection origin: ${selection.id}`);
    if (selection.evidenceIds.some((eid) => !evidence.has(eid))) issue(`Missing evidence reference: ${selection.id}`);
    if ((selection.purpose === 'ncm' && selection.entityId === null)
      || (selection.purpose === 'thematic_text' && selection.entityId !== null)) issue(`Selection purpose/target mismatch: ${selection.id}`);
    if (selection.purpose === 'ncm' && entity && (selection.span.start !== entity.span.start
      || selection.span.end !== entity.span.end || selection.span.end <= selection.span.start)) issue(`NCM selection must cover the entire occurrence: ${selection.id}`);
    if (!selection.eligible) {
      if (!selection.exclusionReasons.length) issue(`Excluded selection needs a reason: ${selection.id}`);
      continue;
    }
    if (selection.exclusionReasons.length || !part || part.context !== 'operative_candidate' || forbiddenTypes.has(part.type) || part.legalStatus !== 'current' || result.status !== 'complete') issue(`Selection lacks safe operative context: ${selection.id}`);
    let ancestor = part;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (['historical', 'prohibited', 'unknown'].includes(ancestor.context) || forbiddenTypes.has(ancestor.type)) issue(`Unsafe ancestor of selection: ${selection.id}`);
      ancestor = ancestor.parentId === null ? undefined : parts.get(ancestor.parentId);
    }
    if (entity && (entity.domain !== 'NCM' || entity.validation.status !== 'valid' || entity.validation.method !== 'catalog' || entity.normalized.length === 2 || entity.relation !== null)) issue(`Entity cannot be selected independently: ${selection.id}`);
    if (entity && result.entities.some(occurrence => occurrence.relation?.targetEntityIds.includes(entity.id))) issue(`Entity is constrained by another range or exception: ${selection.id}`);
    if (selection.purpose === 'ncm' && result.entities.some((occurrence) => overlaps(occurrence.span, selection.span)
      && (occurrence.relation !== null || occurrence.domain !== 'NCM'))) issue(`NCM selection overlaps a compound or protected domain: ${selection.id}`);
    // A broad thematic selection cannot smuggle forbidden structural descendants.
    for (const descendant of result.parts) {
      if (descendant.id === selection.partId || !overlaps(descendant.span, selection.span)) continue;
      let candidate = descendant;
      const seen = new Set<string>();
      let belongs = false;
      while (candidate.parentId !== null && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        if (candidate.parentId === selection.partId) { belongs = true; break; }
        const parent = parts.get(candidate.parentId);
        if (!parent) break;
        candidate = parent;
      }
      if (belongs && (descendant.context !== 'operative_candidate' || descendant.legalStatus !== 'current'
        || forbiddenTypes.has(descendant.type))) issue(`Selection includes an unsafe descendant: ${selection.id}`);
    }
    if (result.evidence.some((proof) => proof.identityHash === result.analysisId && proof.referenceDate === result.referenceDate
      && proof.validFrom <= result.referenceDate && proof.validThrough >= result.referenceDate
      && overlaps(proof.scope, selection.span) && proof.conclusion !== 'current')) issue(`Conflicting approved evidence: ${selection.id}`);
    const proofs = selection.evidenceIds.map((eid) => evidence.get(eid));
    if (!proofs.length || !proofs.some((proof) => proof && proof.conclusion === 'current' && proof.partId === selection.partId
      && inside(selection.span, proof.scope) && proof.validFrom <= result.referenceDate && proof.validThrough >= result.referenceDate
      && proof.dependencies.every((dependency) => dependency.approvedHash === dependency.observedHash
        && dependency.effectsFrom <= result.referenceDate && dependency.validThrough >= result.referenceDate))) issue(`Selection requires approved, current, exact-snapshot evidence: ${selection.id}`);
  }
  let offset = 0; let recognized = 0;
  for (const segment of result.coverage.segments) {
    checkSpan(segment.span, 'coverage');
    const part = parts.get(segment.partId);
    if (!part || !inside(segment.span, part.span) || segment.span.start !== offset || segment.span.end <= segment.span.start) issue('Coverage must partition input exactly once');
    if (segment.classification === 'recognized') {
      recognized += segment.span.end - segment.span.start;
      if (!part || part.type === 'unidentified' || part.recognition === 'unidentified') issue('Unidentified does not count as recognized');
    }
    offset = segment.span.end;
  }
  if (offset !== text.length || result.coverage.textLength !== text.length || result.coverage.accountedLength !== text.length || result.coverage.recognizedLength !== recognized) issue('Coverage totals mismatch');
  let sourceOffset = 0;
  for (const mapping of result.sourceMap) {
    checkSpan(mapping.span, 'sourceMap');
    if (mapping.span.start !== sourceOffset || mapping.span.end <= mapping.span.start) issue('Source map must partition canonical text');
    if (mapping.pointer.sourceSpan && mapping.pointer.sourceSpan.end < mapping.pointer.sourceSpan.start) issue('Invalid source span');
    sourceOffset = mapping.span.end;
  }
  if (sourceOffset !== text.length) issue('Source map does not account for all canonical text');
  for (const limitation of result.limitations) {
    if (limitation.partId !== null && !parts.has(limitation.partId)) issue('Limitation references missing part');
    if (limitation.span) checkSpan(limitation.span, 'limitation');
  }
  if (result.status === 'complete' && (result.coverage.missingResources.length || result.limitations.length
    || result.parts.some((part) => part.coverage !== 'complete' || part.type === 'unidentified' || part.recognition === 'unidentified')
    || result.coverage.segments.some((segment) => segment.classification === 'unidentified'))) issue('Missing/unidentified/limited input must be partial');
});

export const validateAnatomyResult = (value: unknown): AnatomyResult => anatomyResultSchema.parse(value);
export const anatomyContractJsonSchema = (): Record<string, unknown> => z.toJSONSchema(anatomyResultShapeSchema) as Record<string, unknown>;
