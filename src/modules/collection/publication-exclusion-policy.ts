import { classifyDouContractExcerpt } from './dou-scope.rules.js';

/** Matching keys only. Never rewrite official act_type, identity or content. */
export function normalizeLegalBaseType(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export interface ExclusionPolicyPublication {
  title: string;
  actType?: string;
  agency?: string;
  content?: string;
  contentText?: string;
  metadata?: Record<string, unknown>;
  originMetadata?: Record<string, unknown>;
  externalId?: string;
  officialUrl?: string;
  files?: readonly unknown[];
}
export interface PublicationExclusionDecision {
  decision: 'KEEP' | 'REVIEW' | 'EXCLUDE';
  policyKey: string;
  policyVersion: string;
  ruleId?: string;
  category: string;
  reasonCode: string;
  normalizedActType: string;
}

// This is the only editable exception list. Runtime matching is exact after
// the normalization above: no startsWith, substring, wildcard or fuzzy match.
// Source and section are mandatory. These proposed rules have NOT been applied
// to production; activation is the separately reviewed merge/deployment gate.
const NOTICE_TYPES = [
  ['dou-procurement-homologation-adjudication', 'AVISO DE HOMOLOGAÇÃO E ADJUDICAÇÃO'],
  ['dou-procurement-homologation', 'AVISO DE HOMOLOGAÇÃO'],
  ['dou-procurement-accreditation', 'AVISO DE CREDENCIAMENTO'],
  ['dou-procurement-direct-award', 'AVISO DE DISPENSA DE LICITAÇÃO'],
  ['dou-procurement-noncompetitive', 'AVISO DE INEXIGIBILIDADE DE LICITAÇÃO'],
  ['dou-procurement-adjudication', 'AVISO DE ADJUDICAÇÃO'],
  ['dou-procurement-electronic-direct-award', 'AVISO DE DISPENSA DE LICITAÇÃO ELETRÔNICA'],
  ['dou-procurement-electronic-waiver', 'AVISO DE DISPENSA ELETRÔNICA'],
  ['dou-procurement-price-registration', 'AVISO DE REGISTRO DE PREÇOS'],
] as const;

export const PUBLICATION_EXCLUSION_POLICY = Object.freeze({
  key: 'LEGAL_BASE_EXCLUSIONS',
  version: '2026-10-06.v1',
  createdAt: '2026-10-06T00:00:00Z',
  defaultDecision: 'REVIEW',
  rules: Object.freeze(NOTICE_TYPES.map(([id, actType]) => Object.freeze({
    id,
    sources: Object.freeze(['dou']),
    sections: Object.freeze(['DO3', 'DO3E']),
    actTypes: Object.freeze([actType]),
    category: 'ROUTINE_ADMINISTRATIVE_PROCUREMENT',
    reasonCode: 'EXACT_TYPE_AND_ROUTINE_CONTENT_PROVEN',
    evidence: 'COMPLETE_DOU_ROUTINE_NOTICE_V1',
  }))),
});

/** Explicit protected examples, not a denylist complement: unmapped stays REVIEW. */
export const PROTECTED_LEGAL_BASE_TYPES = Object.freeze([
  'LEI', 'LEI COMPLEMENTAR', 'DECRETO', 'DECRETO LEGISLATIVO', 'MEDIDA PROVISÓRIA',
  'INSTRUÇÃO NORMATIVA', 'INSTRUÇÃO NORMATIVA CONJUNTA', 'PORTARIA RFB', 'PORTARIA PGFN',
  'PORTARIA CGIBS', 'PORTARIA CGSN', 'RESOLUÇÃO CGIBS', 'RESOLUÇÃO CGSN', 'RESOLUÇÃO CONFAZ',
  'CONVÊNIO ICMS', 'AJUSTE SINIEF', 'PROTOCOLO ICMS', 'ATO COTEPE/ICMS', 'ATO COTEPE/PMPF',
  'ATO DECLARATÓRIO EXECUTIVO', 'ATO DECLARATÓRIO INTERPRETATIVO', 'ATO DECLARATÓRIO NORMATIVO',
  'SOLUÇÃO DE CONSULTA', 'SOLUÇÃO DE DIVERGÊNCIA', 'PARECER NORMATIVO', 'NOTA TÉCNICA',
  'MANUAL NF-E', 'MANUAL SPED', 'LEIAUTE SPED', 'ESQUEMA XML NF-E', 'EDITAL DE TRANSAÇÃO',
]);
const protectedKeys = new Set(PROTECTED_LEGAL_BASE_TYPES.map(normalizeLegalBaseType));
const sourceTypeKey = (source: string, type: string) => `${source.trim().toLowerCase()}\u0000${normalizeLegalBaseType(type)}`;
const ruleKeys = new Map(PUBLICATION_EXCLUSION_POLICY.rules.flatMap(rule =>
  rule.sources.flatMap(source => rule.actTypes.map(type => [sourceTypeKey(source, type), rule] as const))));
const configuredSources = new Set(PUBLICATION_EXCLUSION_POLICY.rules.flatMap(rule => rule.sources));

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
}
function clauses(value: string): string[] {
  return text(value).split(/(?<=[.;!?])\s+|\n+/)
    .map(item => item.replace(/[.;!?]+$/g, '').trim()).filter(Boolean);
}

// Positive evidence is deliberately narrow. Unknown prose is REVIEW even when
// an exact candidate type matches; a blacklist of tax keywords is insufficient.
const ROUTINE_OBJECTS = new Set([
  'aquisicao de papel a4', 'fornecimento de papel a4',
  'aquisicao de material de expediente', 'fornecimento de material de expediente',
  'aquisicao de materiais de expediente', 'fornecimento de materiais de expediente',
  'aquisicao de material de escritorio', 'fornecimento de material de escritorio',
  'aquisicao de material de limpeza', 'fornecimento de material de limpeza',
  'servicos de limpeza predial', 'servicos de vigilancia patrimonial',
  'locacao de impressoras', 'servicos de impressao e reprografia',
]);
const ROUTINE_FIELDS = [
  /^(?:modalidade:\s*)?(?:pregao(?: eletronico| presencial)?|dispensa de licitacao|dispensa eletronica|inexigibilidade de licitacao|concorrencia(?: eletronica)?)(?:\s+(?:n[º°o.]?\s*)?\d+(?:\/\d{4})?)?$/,
  /^processo(?: administrativo)?\s*:\s*\d[\d./-]*$/,
  /^uasg\s*:\s*\d+$/,
  /^valor(?: global| total| estimado)?\s*:\s*(?:r\$\s*)?\d[\d.,]*$/,
  /^(?:data|abertura|sessao|assinatura)\s*:\s*\d{2}\/\d{2}\/\d{4}(?:\s+(?:as\s+)?\d{2}:\d{2})?$/,
  /^(?:fundamento legal|fundamentacao legal|amparo legal|base legal)\s*:\s*lei\s+(?:n[º°o.]?\s*)?14\.?133(?:\/2021)?$/,
  /^(?:resultado|situacao)\s*:\s*(?:homologado|adjudicado|homologado e adjudicado|deserto|fracassado)$/,
];
const RELEVANCE_VETO = /\b(?:tributari[oa]s?|aduaneir[oa]s?|tributos?|impostos?|fisca(?:l|is)|icms|iss|issqn|ipi|pis|pasep|cofins|irpj|irpf|csll|iof|itr|iptu|itbi|itcmd|ibs|cbs|sped|sinief|confaz|isencao|remissao|anistia|transacao|parcelamento|concessao|outorga|tarifari[oa]s?|minerari[oa]s?|regulatori[oa]s?|fusao|cisao|incorporacao|societari[oa]s?|acionari[oa]s?|sucessao|falencia|leniencia)\b/;
const CNPJ_VETO = /\bcnpj\b|\b\d{14}\b|\b[a-z0-9]{2}\.[a-z0-9]{3}\.[a-z0-9]{3}\/[a-z0-9]{4}-\d{2}\b/;

function evaluateEnvelope(input: {
  sourceCode?: string;
  publication: ExclusionPolicyPublication;
}): PublicationExclusionDecision {
  const publication = input.publication;
  const normalizedActType = normalizeLegalBaseType(publication.actType);
  const base = {
    policyKey: PUBLICATION_EXCLUSION_POLICY.key,
    policyVersion: PUBLICATION_EXCLUSION_POLICY.version,
    normalizedActType,
  };
  const result = (decision: PublicationExclusionDecision['decision'], category: string, reasonCode: string,
    ruleId?: string): PublicationExclusionDecision => ({ ...base, decision, category, reasonCode,
      ...(ruleId ? { ruleId } : {}) });
  if (!input.sourceCode?.trim()) return result('REVIEW', 'UNMAPPED', 'SOURCE_UNKNOWN');
  if (!normalizedActType) return result('REVIEW', 'UNMAPPED', 'ACT_TYPE_UNKNOWN');
  if (protectedKeys.has(normalizedActType)) return result('KEEP', 'PROTECTED_NORMATIVE', 'PROTECTED_EXACT_TYPE');
  const sourceCode = input.sourceCode.trim().toLowerCase();
  const persistedScope = record(publication.metadata?.douScope);
  if (sourceCode === 'dou' && (persistedScope?.decision === 'KEEP' || persistedScope?.decision === 'REVIEW')) {
    return result(persistedScope.decision, 'PRESERVED_DOU_DECISION', 'EXISTING_DOU_KEEP_REVIEW_VETO');
  }
  // Keep D-066 intact. This central policy does not add contract excerpts to
  // its exception list. The existing DOU classifier remains authoritative.
  if (sourceCode === 'dou' && (normalizedActType === 'EXTRATO DE CONTRATO' || normalizedActType === 'EXTRATO DE CONTRATOS')) {
    const classified = classifyDouContractExcerpt({
      title: publication.title,
      actType: publication.actType ?? null,
      agency: publication.agency ?? null,
      content: publication.contentText ?? publication.content ?? null,
      metadata: publication.metadata ?? null,
    });
    return result(classified?.decision === 'KEEP' ? 'KEEP' : 'REVIEW', 'D066_CONTRACT_EXCERPT',
      classified?.decision === 'IGNORE' ? 'EXISTING_CONNECTOR_POLICY_ONLY' : 'D066_VETO_OR_REVIEW');
  }
  if (!configuredSources.has(sourceCode)) return result('KEEP', 'SOURCE_NOT_TARGETED', 'NO_RULE_FOR_SOURCE');
  const rule = ruleKeys.get(sourceTypeKey(sourceCode, normalizedActType));
  if (!rule) return result('REVIEW', 'UNMAPPED', 'NO_EXACT_EXCEPTION');
  const review = (reason: string) => result('REVIEW', rule.category, reason, rule.id);
  // A new source requires its own proven evidence adapter; adding a name to
  // configuration must never reinterpret another source's envelope as DOU.
  if (rule.evidence !== 'COMPLETE_DOU_ROUTINE_NOTICE_V1' || sourceCode !== 'dou') return review('EVIDENCE_ADAPTER_NOT_PROVEN');
  const dou = record(publication.metadata?.dou);
  if (typeof dou?.section !== 'string' || !rule.sections.includes(dou.section)) return review('SECTION_NOT_PROVEN_OR_NOT_TARGETED');
  // Numbered titles can refine the parser's canonical type. They cannot erase
  // a conflicting official article type, including a protected fiscal act.
  if (typeof dou.sourceActType !== 'string' || normalizeLegalBaseType(dou.sourceActType) !== normalizedActType) {
    return review('OFFICIAL_ACT_TYPE_MISSING_OR_CONFLICTING');
  }
  if (!Array.isArray(dou.parts) || dou.parts.length === 0 || dou.parts.some(value => {
    const attributes = record(record(value)?.attributes);
    return typeof attributes?.artType !== 'string' || normalizeLegalBaseType(attributes.artType) !== normalizedActType ||
      attributes.pubName !== dou.section;
  })) return review('OFFICIAL_PART_TYPE_OR_SECTION_NOT_PROVEN');
  if (dou.scopeStructureIncomplete === true || dou.titleFallback !== undefined) return review('INCOMPLETE_DOU_STRUCTURE');
  if (typeof dou.abstract !== 'string' || !Array.isArray(dou.continuationTitles) ||
    !Array.isArray(dou.continuationAbstracts) ||
    [...dou.continuationTitles, ...dou.continuationAbstracts].some(value => typeof value !== 'string')) {
    return review('SUPPLEMENTARY_EVIDENCE_MISSING');
  }
  const content = publication.contentText ?? publication.content;
  if (!content?.trim()) return review('CONTENT_REQUIRED');
  // No listed source can safely exclude these notices before obtaining the
  // body and all supplements. Unknown file content must not be silently lost.
  const inventories = [publication.files, publication.metadata?.files, publication.originMetadata?.files];
  if (inventories.some(files => files !== undefined && (!Array.isArray(files) || files.length !== 0))) {
    return review('ATTACHMENT_CONTENT_NOT_PROVEN');
  }
  if (Array.isArray(dou.parts) && dou.parts.some(value => {
    const part = record(value); const attrs = record(part?.attributes);
    return part?.hasHighlightImage === true || Boolean(attrs?.highlightImage) || Boolean(attrs?.highlightimage);
  })) return review('IMAGE_CONTENT_NOT_PROVEN');
  const supplements = [dou.abstract, ...dou.continuationTitles, ...dou.continuationAbstracts] as string[];
  const evidence = text([publication.title, content, ...supplements, publication.agency ?? ''].join('\n'));
  if (RELEVANCE_VETO.test(evidence)) return review('POSSIBLE_FISCAL_REGULATORY_OR_CORPORATE_RELEVANCE');
  // D-057: registered-CNPJ retention may apply. No tenant registry lookup or
  // public/private content policy is introduced here: any full CNPJ mention
  // conservatively vetoes exclusion outside D-066 (never persist a new category).
  if (CNPJ_VETO.test(evidence)) return review('POSSIBLE_REGISTERED_CNPJ_RELEVANCE');
  // The title may have an official number/date suffix; unknown suffix prose
  // vetoes exclusion. Only the type comparison above selects an exception.
  const title = text(publication.title).replace(/\s+/g, ' ').trim();
  const keyTitle = text(rule.actTypes[0]!).replace(/\s+/g, ' ');
  const canonicalTitle = normalizeLegalBaseType(publication.title);
  const suffix = title.startsWith(keyTitle) ? title.slice(keyTitle.length).trim() : '';
  if (canonicalTitle !== normalizedActType && (!suffix || !/^(?:n[º°o.]?\s*)?\d+(?:\/\d{4})?$/.test(suffix))) {
    return review('TITLE_TYPE_CONTRADICTION_OR_UNKNOWN_SUFFIX');
  }
  const allClauses = clauses(content);
  const objects = allClauses.filter(clause => /^objeto\s*:/.test(clause));
  if (objects.length !== 1 || !ROUTINE_OBJECTS.has(objects[0]!.replace(/^objeto\s*:\s*/, ''))) {
    return review('ROUTINE_OBJECT_NOT_PROVEN');
  }
  const routineClause = (clause: string) => clause === objects[0] || ROUTINE_FIELDS.some(pattern => pattern.test(clause));
  if (!allClauses.every(routineClause) || !allClauses.some(clause => /^processo(?: administrativo)?\s*:/.test(clause))) {
    return review('ROUTINE_CONTENT_NOT_PROVEN');
  }
  if (supplements.some(value => value.trim() && normalizeLegalBaseType(value) !== normalizedActType &&
    !clauses(value).every(routineClause))) return review('SUPPLEMENTARY_CONTENT_NOT_PROVEN');
  return result('EXCLUDE', rule.category, rule.reasonCode, rule.id);
}

/** Every supplied provenance envelope must independently support exclusion. */
export function evaluatePublicationExclusionPolicy(input: {
  sourceCode?: string;
  publication: ExclusionPolicyPublication;
}): PublicationExclusionDecision {
  const canonical = evaluateEnvelope(input);
  const originMetadata = input.publication.originMetadata;
  if (originMetadata === undefined) return canonical;
  if (!record(originMetadata)) {
    return canonical.decision !== 'EXCLUDE' ? canonical : {
      ...canonical, decision: 'REVIEW', reasonCode: 'ORIGIN_EVIDENCE_NOT_PROVEN',
    };
  }
  // Match the normalizer's shallow provenance merge without mutating either
  // input. A partial/conflicting DOU envelope therefore fails open as well.
  const origin = evaluateEnvelope({
    ...input,
    publication: { ...input.publication, metadata: { ...input.publication.metadata, ...originMetadata } },
  });
  if (canonical.decision === 'KEEP') return canonical;
  if (origin.decision === 'KEEP') return origin;
  if (canonical.decision === 'REVIEW') return canonical;
  if (origin.decision === 'REVIEW') return origin;
  return canonical;
}
