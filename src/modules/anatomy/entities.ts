import type { AnatomyEntity, AnatomyPart } from './contract.js';
import { assertCompiledRules, defaultRules, type CompiledRules } from './profile-rules.js';
import { NfcQuarantineError, NFC_DIAGNOSTICS, exactToOriginal, exactToShadow } from './nfc-recovery.js';
import { isNonNfcText, shadowContextOf } from './readers.js';

export interface AnatomyEntityInput {
  canonicalText: string;
  parts: readonly AnatomyPart[];
  /** Only cells/parts whose NCM column was identified unambiguously by the reader. */
  ncmPartIds?: readonly string[];
  /** Controlled, exact-code catalog snapshot; no remote resolution or prefix expansion. */
  catalog?: { edition: string; codes: readonly string[] };
  /** Profile-driven matchers (NCM marker, list tokens, range operators, exception markers). Domain protections stay fixed. */
  rules?: Pick<CompiledRules, 'ncmMarker' | 'codeList' | 'rangeBridge' | 'exceptionMarker'>;
}
type Span = { start: number; end: number };
const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
const numeric = /(?<![\p{L}\p{N}.])(?:\d{4}\.\d{2}\.\d{1,2}|\d{4}\.\d{1,4}|\d{4,8}|\d{2})(?![\p{L}\p{N}]|\.(?!\s|$))/gu;
const protectedPatterns: ReadonlyArray<[AnatomyEntity['domain'], RegExp, string]> = [
  ['CITATION', /\b(?:Lei(?:\s+Complementar)?|LC|Decreto(?:-Lei)?|Conv[eê]nio(?:\s+ICMS)?|Conv\.(?:\s+ICMS)?|Ajuste\s+SINIEF|Protocolo(?:\s+ICMS)?|Portaria(?:\s+[A-Z][A-Z/.-]*)?|Resolu[çc][ãa]o(?:\s+(?:do\s+)?Senado(?:\s+Federal)?)?|Res\.(?:\s+Senado)?|Instru[çc][ãa]o\s+Normativa(?:\s+RFB)?|IN(?:\s+RFB)?|Ato\s+Declarat[oó]rio(?:\s+Executivo)?|AD|ADE(?:\s+[A-Z]+)?|Ato\s+COTEPE(?:\/ICMS)?|Solu[çc][ãa]o\s+de\s+Consulta(?:\s+(?:Cosit|Disit))?|SC\s+(?:Cosit|Disit))\s*(?:n(?:[.º°o]|[úu]mero)*\s*)?\d+(?:\.\d+)*(?:\s*\/\s*\d{2,4})?(?!\d)/giu, 'unresolved_explicit_citation'],
  ['OTHER', /(?:\bart(?:igo)?\.?|§|\binciso|\bcl[áa]usula)\s*\d+(?:\.[0-9]+)*(?:[º°]|-[A-Z])?/giu, 'legal_device_identifier_not_ncm'],
  ['PROCESS', /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b|\b\d{5}\.\d{6}\/\d{4}-\d{2}\b/gu, 'process_format'],
  ['PROCESS', /\b(?:processo|proc\.?|SEI)\s*(?:n[.º°o]*\s*)?\d[\d./-]{2,39}/giu, 'process_label'],
  ['CNPJ', /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)|(?<!\d)\d{14}(?!\d)/gu, 'cnpj_domain_not_check_digit_validation'],
  ['CEP', /(?<!\d)\d{5}-\d{3}(?!\d)|\bCEP\s*:?\s*\d{8}(?!\d)/giu, 'cep_domain'],
  ['DATE', /(?<!\d)(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})(?!\d)|\b\d{1,2}\s+de\s+[a-zç]+\s+de\s+\d{4}\b/giu, 'date_domain_not_calendar_validation'],
  ['CNAE', /\bCNAE\s*:?\s*\d[\d./-]{1,15}|(?<!\d)\d{4}-\d\/\d{2}(?!\d)/giu, 'cnae_domain'],
  ['CFOP', /\bCFOP\s*:?\s*\d[\d.]{2,8}/giu, 'cfop_domain'],
  ['CST', /\bCST\s*:?\s*\d{2,4}(?!\d)/giu, 'cst_domain'],
  ['CCLASSTRIB', /\bcClassTrib\s*:?\s*\d{2,8}(?!\d)/giu, 'cclasstrib_domain'],
  ['CEST', /\bCEST\s*:?\s*\d[\d.]{2,12}|(?<!\d)\d{2}\.\d{3}\.\d{2}(?!\d)/giu, 'cest_domain'],
  ['NBM', /\bNBM(?:\/SH)?\s*:?\s*\d[\d.]{1,15}/giu, 'nbm_is_not_ncm'],
  ['SH', /(?<!NCM\/)\bSH\s*:?\s*\d[\d.]{1,15}/giu, 'sh_is_not_ncm'],
  ['TIPI', /\bTIPI\s*:?\s*\d[\d.]{1,15}/giu, 'tipi_is_not_ncm'],
  ['REVENUE_CODE', /\b(?:c[oó]digo\s+(?:de\s+)?receita|receita\s+c[oó]digo|DARF)\s*:?\s*\d[\d.-]{1,15}/giu, 'revenue_domain'],
  ['OTHER', /\b(?:SUS|SIGTAP|CNES)\s*:?\s*\d[\d.-]{1,19}/giu, 'sus_domain_not_ncm'],
];

/** Internal positions of a relation's operator and condition (not v1 contract fields; used for exact mapping). */
type RelationSpans = { operator: Span; condition: Span | null };
type Rules = Pick<CompiledRules, 'ncmMarker' | 'codeList' | 'rangeBridge' | 'exceptionMarker'>;

/** Deterministic occurrence extraction. Recognition/validation never grants legal eligibility. */
export function extractAnatomyEntities(input: AnatomyEntityInput): AnatomyEntity[] {
  const rules = input.rules ?? defaultRules('DOE-SP');
  assertCompiledRules(rules);
  // UNICODE-01a: no codes are extracted from non-NFC text by a direct call, so it cannot return apparently normal
  // codes. Non-NFC documents are only processed by extractRecoveredEntities, through the reader's own context.
  if (isNonNfcText(input.canonicalText)) throw new TypeError('non_nfc_text: entity extraction is suspended for text that is not in Unicode NFC');
  return extractCore(input.canonicalText, input, rules, new WeakMap());
}

/**
 * UNICODE-01b/B2: extraction for a document the reader accepted for NFC recovery. Matching runs on the reader's NFC
 * shadow; every entity, operator and condition must map back EXACTLY, otherwise NfcQuarantineError is thrown and the
 * caller discards the whole extraction. Published spans and literals are the original ones; `operator` is the derived
 * NFC form; `condition` is the original slice; `normalized` keeps digits for NCM domains and the original literal for
 * other domains (identifiers are never normalised), except the exception marker prefix (derived, NFC).
 */
export function extractRecoveredEntities(read: object & { canonicalText: string; parts: readonly AnatomyPart[] },
  input: Omit<AnatomyEntityInput, 'canonicalText' | 'parts'>): AnatomyEntity[] {
  const context = shadowContextOf(read);
  if (!context || context.map.original !== read.canonicalText) throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, 'no reader-built NFC context for this result');
  const rules = input.rules ?? defaultRules('DOE-SP');
  assertCompiledRules(rules);
  const original = read.canonicalText;
  const shadowParts = read.parts.map((part) => ({ ...part, span: exactToShadow(context, part.span, `part ${part.id}`) }));
  const aux = new WeakMap<object, RelationSpans>();
  const found = extractCore(context.map.shadow, { ...input, canonicalText: context.map.shadow, parts: shadowParts }, rules, aux);
  const partsById = new Map(read.parts.map((part) => [part.id, part]));
  // Review B2-R1-02: a recovered span must not traverse a part whose context or type differs from its owner's
  // (e.g. a citation running from an article into a signature). Parts containing the span (ancestors) are fine; any
  // other overlapped part must share the owner's context and be of a permitted type, otherwise the whole document
  // stays in quarantine.
  const crossingForbidden = new Set<AnatomyPart['type']>(['publication_header', 'epigraph', 'summary', 'preamble',
    'consideration', 'signature', 'footer', 'editorial_note', 'unidentified', 'quoted_text']);
  const assertCompatible = (span: Span, owner: AnatomyPart, what: string): void => {
    for (const part of read.parts) {
      if (part.span.end <= span.start || part.span.start >= span.end || part === owner) continue;
      if (part.span.start <= span.start && part.span.end >= span.end) continue;
      if (part.context !== owner.context || (crossingForbidden.has(part.type) && part.type !== owner.type)) {
        throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `${what} [${span.start}, ${span.end}) crosses ${part.type} ${part.id} (${part.context}), incompatible with its owner ${owner.type} ${owner.id} (${owner.context})`);
      }
    }
  };
  const ids = new Map<string, string>();
  const spans = new Map<AnatomyEntity, Span>();
  for (const entity of found) {
    const span = exactToOriginal(context, entity.span, `entity ${entity.id}`);
    const owner = partsById.get(entity.partId)!;
    if (owner.span.start > span.start || owner.span.end < span.end) throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `entity ${entity.id} leaves its owning part after mapping`);
    assertCompatible(span, owner, `entity ${entity.id}`);
    const id = `entity:${entity.domain}:${span.start}:${span.end}`;
    if ([...ids.values()].includes(id)) throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `duplicate entity identity ${id} after mapping`);
    ids.set(entity.id, id); spans.set(entity, span);
  }
  const remap = (id: string) => { const next = ids.get(id); if (!next) throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `dangling reference ${id}`); return next; };
  const ncmFamily = new Set<AnatomyEntity['domain']>(['NCM', 'NCM_RANGE', 'NCM_EXCEPTION']);
  const out = found.map((entity): AnatomyEntity => {
    const span = spans.get(entity)!;
    const literal = original.slice(span.start, span.end);
    let relation = entity.relation;
    if (relation) {
      const internal = aux.get(relation);
      if (!internal) throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `relation of ${entity.id} has no recorded operator span`);
      const owner = partsById.get(entity.partId)!;
      assertCompatible(exactToOriginal(context, internal.operator, `operator of ${entity.id}`), owner, `operator of ${entity.id}`);
      const condition = internal.condition ? exactToOriginal(context, internal.condition, `condition of ${entity.id}`) : null;
      if (condition) assertCompatible(condition, partsById.get(relation.scopePartId) ?? owner, `condition of ${entity.id}`);
      relation = { ...relation, groupId: remap(relation.groupId), targetEntityIds: relation.targetEntityIds.map(remap),
        condition: condition ? original.slice(condition.start, condition.end) : null, expansion: [...relation.expansion] };
    }
    return { ...entity, id: remap(entity.id), span, literal, normalized: ncmFamily.has(entity.domain) ? entity.normalized : literal,
      validation: { ...entity.validation }, relation };
  });
  return out.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.domain.localeCompare(b.domain, 'en'));
}

function extractCore(text: string, input: AnatomyEntityInput, rules: Rules, aux: WeakMap<object, RelationSpans>): AnatomyEntity[] {
  if (text.length > 2 * 1024 * 1024) throw new RangeError('ANAT entity input exceeds 2 Mi UTF-16 units');
  const hierarchy = new Map(input.parts.map(part => [part.id, part]));
  const depth = (part: AnatomyPart): number => {
    let current = part; let count = 0; const seen = new Set<string>();
    while (current.parentId !== null) {
      if (seen.has(current.id)) throw new RangeError('Cyclic anatomy entity ownership');
      seen.add(current.id);
      const parent = hierarchy.get(current.parentId);
      if (!parent) throw new RangeError('Missing parent in anatomy entity ownership');
      current = parent; count++;
    }
    return count;
  };
  const depths = new Map(input.parts.map(part => [part.id, depth(part)]));
  // ANAT-STRUCT-02: a caput is a structural view over its article's opening block; entities keep the article as owner.
  const parts = input.parts.filter((part) => part.type !== 'caput').sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start)
    || (depths.get(b.id)! - depths.get(a.id)!) || a.span.start - b.span.start || a.id.localeCompare(b.id, 'en'));
  const owner = (span: Span): AnatomyPart => {
    const part = parts.find((candidate) => candidate.span.start <= span.start && candidate.span.end >= span.end);
    if (!part) throw new RangeError('Entity span has no owning part');
    return part;
  };
  const byId = new Map(input.parts.map((part) => [part.id, part]));
  const forbidden = new Set<AnatomyPart['type']>(['publication_header', 'epigraph', 'summary', 'preamble',
    'consideration', 'signature', 'footer', 'editorial_note', 'unidentified']);
  const permitsNcm = (part: AnatomyPart): boolean => {
    const visited = new Set<string>();
    let current: AnatomyPart | undefined = part;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (forbidden.has(current.type) || current.context === 'prohibited' || current.context === 'unknown') return false;
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return current === undefined;
  };
  const entities: AnatomyEntity[] = [];
  const protectedSpans: Span[] = [];
  const make = (span: Span, domain: AnatomyEntity['domain'], reason: string): AnatomyEntity => {
    if (entities.length >= 20000) throw new RangeError('ANAT entity occurrence limit exceeded');
    const literal = text.slice(span.start, span.end);
    const entity: AnatomyEntity = { id: `entity:${domain}:${span.start}:${span.end}`, partId: owner(span).id,
      domain, literal, normalized: literal, span, ruleId: `anat.entities.v1.${reason}`, confidence: 1,
      validation: { status: 'unknown', method: 'none', catalogEdition: null, reason }, relation: null };
    entities.push(entity); return entity;
  };
  for (const [domain, regex, reason] of protectedPatterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (protectedSpans.some((prior) => overlap(span, prior))) continue;
      make(span, domain, reason); protectedSpans.push(span);
    }
  }
  const contexts: Span[] = [];
  for (const partId of input.ncmPartIds ?? []) {
    const part = input.parts.find((candidate) => candidate.id === partId);
    if (!part) throw new RangeError(`Unknown NCM part: ${partId}`);
    contexts.push(part.span);
  }
  // A marker permits only a bounded numeric list, stopping before unrelated prose/new lines.
  for (const marker of text.matchAll(rules.ncmMarker)) {
    const start = marker.index + marker[0].length;
    const tail = text.slice(start, Math.min(text.length, start + 1024)).split(/[\r\n]/, 1)[0]!;
    const list = rules.codeList.exec(tail);
    if (list) {
      // A dot followed by whitespace/end is a sentence boundary, never an internal code separator.
      const sentenceEnd = /\.(?=[ \t]|$)/u.exec(list[0]);
      contexts.push({ start, end: start + (sentenceEnd?.index ?? list[0].length) });
    }
  }
  const catalog = input.catalog ? new Set(input.catalog.codes) : null;
  if (input.catalog && (!input.catalog.edition.trim() || input.catalog.codes.some((code) => !/^\d{4,8}$/.test(code)))) throw new TypeError('Catalog requires an edition and exact 4–8 digit codes');
  const ncms: AnatomyEntity[] = [];
  for (const match of text.matchAll(numeric)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (!contexts.some((context) => context.start <= span.start && context.end >= span.end)
      || protectedSpans.some((protection) => overlap(span, protection)) || !permitsNcm(owner(span))) continue;
    const entity = make(span, 'NCM', 'explicit_ncm_context');
    entity.normalized = match[0].replace(/\./g, '');
    entity.validation = entity.normalized.length === 2
      ? { status: 'informative', method: 'format', catalogEdition: null, reason: 'chapter_informative_only' }
      : catalog ? { status: catalog.has(entity.normalized) ? 'valid' : 'invalid', method: 'catalog',
        catalogEdition: input.catalog!.edition, reason: catalog.has(entity.normalized) ? 'exact_catalog_match' : 'absent_from_controlled_catalog' }
        : { status: 'unknown', method: 'format', catalogEdition: null, reason: 'catalog_not_supplied' };
    ncms.push(entity);
  }
  for (let index = 0; index + 1 < ncms.length; index += 1) {
    const first = ncms[index]!; const last = ncms[index + 1]!;
    const bridge = text.slice(first.span.end, last.span.start);
    if (first.partId !== last.partId || !rules.rangeBridge.test(bridge) || /[\r\n]/u.test(bridge)) continue;
    const members = [first, last];
    while (index + members.length < ncms.length) {
      const next = ncms[index + members.length]!;
      const nextBridge = text.slice(members.at(-1)!.span.end, next.span.start);
      if (next.partId !== first.partId || /[\r\n]/u.test(nextBridge) || !rules.rangeBridge.test(nextBridge)) break;
      members.push(next);
    }
    const span = { start: first.span.start, end: members.at(-1)!.span.end };
    const compound = make(span, 'NCM_RANGE', 'M01_bounded_range_no_expansion');
    const groupId = compound.id;
    const compatible = members.length === 2 && first.normalized.length === last.normalized.length && first.normalized.length >= 4
      && first.normalized <= last.normalized;
    compound.normalized = `${first.normalized}..${last.normalized}`;
    compound.validation = { status: compatible ? 'unknown' : 'invalid', method: 'none', catalogEdition: input.catalog?.edition ?? null,
      reason: compatible ? 'range_membership_not_expanded' : 'incompatible_or_reversed_range' };
    const lead = bridge.length - bridge.trimStart().length;
    const operatorSpan = { start: first.span.end + lead, end: first.span.end + lead + bridge.trim().length };
    compound.relation = { kind: 'range', groupId, targetEntityIds: members.map((entity) => entity.id), operator: bridge.trim(),
      scopePartId: compound.partId, condition: null, expansion: [] };
    aux.set(compound.relation, { operator: operatorSpan, condition: null });
    first.relation = { kind: 'range_start', groupId, targetEntityIds: [last.id], operator: bridge.trim(), scopePartId: compound.partId, condition: null, expansion: [] };
    aux.set(first.relation, { operator: operatorSpan, condition: null });
    for (const member of members.slice(1)) {
      member.relation = { kind: 'range_end', groupId, targetEntityIds: [first.id], operator: bridge.trim(), scopePartId: compound.partId, condition: null, expansion: [] };
      aux.set(member.relation, { operator: operatorSpan, condition: null });
    }
    index += members.length - 1;
  }
  for (const marker of text.matchAll(rules.exceptionMarker)) {
    const markerEnd = marker.index + marker[0].length;
    const operatorSpan = { start: marker.index, end: markerEnd };
    let scope = owner({ start: marker.index, end: markerEnd });
    if (scope.type === 'cell' && scope.parentId !== null && byId.get(scope.parentId)?.type === 'row') scope = byId.get(scope.parentId)!;
    const scopeNcms = ncms.filter((entity) => entity.span.start >= scope.span.start && entity.span.end <= scope.span.end);
    const target = ncms.find((entity) => entity.span.start >= markerEnd
      && entity.span.end <= scope.span.end
      && /^[ \t,:()\-]*(?:NCM[ \t:]*)?$/iu.test(text.slice(markerEnd, entity.span.start)));
    if (!target) {
      // Unknown prose scope is preserved as a conservative mask, never an invented legal exception.
      const affected = scopeNcms;
      if (!affected.length) continue;
      const compound = make({ start: Math.min(marker.index, affected[0]!.span.start), end: scope.span.end }, 'NCM_EXCEPTION', 'M02_unknown_scope_conservative_mask');
      const conditionSpan = { start: marker.index, end: scope.span.end };
      compound.relation = { kind: 'exception', groupId: compound.id, targetEntityIds: affected.map((entity) => entity.id),
        operator: marker[0], scopePartId: scope.id, condition: text.slice(conditionSpan.start, conditionSpan.end), expansion: [] };
      aux.set(compound.relation, { operator: operatorSpan, condition: conditionSpan });
      for (const item of affected) if (!item.relation) {
        item.relation = { kind: 'exception_target', groupId: compound.id,
          targetEntityIds: [compound.id], operator: marker[0], scopePartId: scope.id, condition: compound.relation.condition, expansion: [] };
        aux.set(item.relation, { operator: operatorSpan, condition: conditionSpan });
      }
      continue;
    }
    const targets = [target];
    for (const following of scopeNcms.filter((entity) => entity.span.start >= target.span.end)) {
      const prior = targets.at(-1)!;
      if (!/^[ \t]*(?:,|e|ou|a|at[eé]|[-–—])[ \t]*$/iu.test(text.slice(prior.span.end, following.span.start))) break;
      targets.push(following);
    }
    const span = { start: marker.index, end: targets.at(-1)!.span.end };
    const part = scope;
    const compound = make(span, 'NCM_EXCEPTION', 'M02_scoped_exception');
    compound.normalized = `${marker[0].toLocaleLowerCase('pt-BR')}:${target.normalized}`;
    compound.relation = { kind: 'exception', groupId: compound.id, targetEntityIds: scopeNcms.map((entity) => entity.id), operator: marker[0],
      scopePartId: part.id, condition: text.slice(span.start, span.end), expansion: [] };
    aux.set(compound.relation, { operator: operatorSpan, condition: span });
    // Keep an existing range relation; the overlapping compound still blocks every member.
    for (const item of scopeNcms) if (!item.relation) {
      item.relation = { kind: 'exception_target', groupId: compound.id, targetEntityIds: [compound.id],
        operator: marker[0], scopePartId: part.id, condition: compound.relation.condition, expansion: [] };
      aux.set(item.relation, { operator: operatorSpan, condition: span });
    }
  }
  return entities.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.domain.localeCompare(b.domain, 'en'));
}
