export const DOU_SCOPE_RULE_VERSION = 'dou-scope-v4' as const;

export type DouScopeCategory =
  | 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA'
  | 'TRIBUTARIO_FISCAL'
  | 'REGULATORIO_CONCESSAO'
  | 'EMPRESARIAL_RELEVANTE'
  | 'AMBIGUO';
export type DouScopeDecision = 'IGNORE' | 'KEEP' | 'REVIEW';

export interface DouScopePublication {
  title: string;
  actType?: string | null;
  agency?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}
export interface DouScopeClassification {
  ruleVersion: typeof DOU_SCOPE_RULE_VERSION;
  category: DouScopeCategory;
  decision: DouScopeDecision;
  reasonCodes: string[];
}
type RelevantCategory = Exclude<DouScopeCategory, 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA' | 'AMBIGUO'>;
interface RelevanceRule { category: RelevantCategory; code: string; pattern: RegExp }
interface RoutineObjectRule { code: string; pattern: RegExp }
type ObjectExtraction = { ok: true; text: string } | { ok: false; reasonCode: string };

const RELEVANCE_RULES: readonly RelevanceRule[] = [
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_transaction_or_installment', pattern: /\b(?:transacao|parcelamento|remissao|anistia|compensacao)\s+(?:de (?:debitos?|creditos?) )?tributari[oa]s?\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_credit_or_debt', pattern: /\b(?:creditos?|debitos?)\s+tributari[oa]s?\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_benefit_or_special_regime', pattern: /\b(?:beneficio|incentivo|regime especial)\s+(?:fiscal|tributario|aduaneiro)\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_or_customs_enforcement', pattern: /\b(?:fiscalizacao|arrecadacao|cobranca)\s+(?:tributaria|aduaneira)\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_exemption_reduction_or_suspension', pattern: /\b(?:isencao|reducao|suspensao)\s+(?:de|do|da|dos|das)\s+(?:(?:pagamento|aliquota|base de calculo)\s+(?:de|do|da)\s+)?(?:tributos?|impostos?|contribuicoes tributarias|icms|iss(?:qn)?|ipi|pis(?:\/pasep)?|cofins|irpj|irpf|csll|iof|itr|iptu|itbi|itcmd|ibs|cbs)\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'tax_refund', pattern: /\b(?:restituicao|ressarcimento)\s+de\s+(?:tributos?|impostos?|creditos? tributarios?)\b/ },
  { category: 'TRIBUTARIO_FISCAL', code: 'electronic_invoice_obligation', pattern: /\b(?:obrigatoriedade|obrigacao|regime|institui[a-z]*|estabelec[a-z]*|regulament[a-z]*)\b[^.;!?\n]{0,180}\b(?:emissao|emitir|emiti[a-z]*)\b[^.;!?\n]{0,100}\b(?:notas? fisca(?:l|is) eletronicas?|nf-?e|nfc-?e|nfs-?e)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'concession_or_public_service_delegation', pattern: /\b(?:contrato de (?:sub)?concessao|subconcessao|concessao de servicos? publicos?|delegacao de servicos? publicos?)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'regulated_infrastructure_grant', pattern: /\b(?:concessao|permissao|outorga|autorizacao)\b.{0,180}\b(?:rodovias?|ferrovias?|infraestrutura rodoviaria|infraestrutura ferroviaria|servicos? publicos?|instalacao portuaria|terminal de uso privado|geracao de energia|distribuicao de energia|transmissao de energia|lavra mineral)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'regulated_infrastructure_operation', pattern: /\b(?:exploracao|operacao)\b.{0,100}\b(?:rodovias?|ferrovias?|infraestrutura rodoviaria|infraestrutura ferroviaria|terminal de uso privado)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'grant_or_transfer_of_regulatory_authorization', pattern: /\b(?:outorga|transferencia)\s+de\s+(?:concessao|permissao|autorizacao)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'tariff_revision', pattern: /\b(?:revisao|reajuste)\s+tarifari[oa]\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'mineral_rights_transfer', pattern: /\b(?:cessao|transferencia)\s+de\s+direitos?\s+minerari[oa]s?\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_control_change', pattern: /\b(?:alteracao|transferencia|aquisicao|alienacao)\s+(?:de|do)\s+controle\s+(?:societario|acionario)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_reorganization', pattern: /\b(?:fusao|cisao|incorporacao)\s+(?:societaria|empresarial|(?:de|da|do|das|dos) (?:empresas?|sociedades?|companhias?|contratad[ao]s?))\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_incorporation_passive', pattern: /\b(?:contratad[ao]s?|empresas?|sociedades?|companhias?)\b[^.;!?\n]{0,100}\bincorporad[oa]s?\s+pel[ao]s?\s+(?:empresas?|sociedades?|companhias?|contratad[ao]s?)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_incorporation_active', pattern: /\b(?:empresas?|sociedades?|companhias?)\b[^.;!?\n]{0,100}\bincorpor(?:a|am|ou|aram|ara|arao|ar|ando)\s+(?:a|as|o|os)\s+(?:contratad[ao]s?|empresas?|sociedades?|companhias?)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_succession', pattern: /\bsucessor(?:a|es|as)?\s+(?:em todos os|nos|em seus)\s+direitos e obrigacoes\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_restructuring_or_intervention', pattern: /\b(?:recuperacao judicial|liquidacao extrajudicial|intervencao societaria)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'leniency_agreement', pattern: /\bacordo de leniencia\b/ },
];

// These signals are too broad to prove KEEP, but are incompatible with a
// confident routine-only decision. Unknown material context must fail safe.
const AMBIGUOUS_RELEVANCE_RULES: readonly RoutineObjectRule[] = [
  { code: 'possible_tax_relevance', pattern: /\b(?:tributari[oa]s?|aduaneir[oa]s?|tributos?|impostos?|icms|iss|issqn|ipi|pis|pasep|cofins|irpj|irpf|csll|iof|itr|iptu|itbi|itcmd|ibs|cbs|isencao|isencoes|remissao|anistia|compensacao|fisca(?:l|is))\b/ },
  { code: 'possible_regulatory_relevance', pattern: /\b(?:concessao|concessoes|subconcessao|outorga|outorgas|tarifari[oa]s?|minerari[oa]s?|regulatori[oa]s?)\b/ },
  { code: 'possible_corporate_relevance', pattern: /\b(?:fusao|fusoes|cisao|cisoes|cind[a-z]*|fundid[oa]s?|fundi(?:r[a-z]*|ndo|u|ram)|incorpor[a-z]*|societari[oa]s?|acionari[oa]s?|sucessao|sucessor(?:a|es|as)?|sucedid[oa]s?|recuperacao judicial|falencia|liquidacao extrajudicial|leniencia)\b/ },
];

const ROUTINE_OBJECT_RULES: readonly RoutineObjectRule[] = [
  { code: 'routine_object_office_supplies', pattern: /^(?:aquisicao|fornecimento) de (?:papel a4|material de expediente|materiais de expediente|material de escritorio|materiais de escritorio)(?: para uso (?:administrativo|interno))?$/ },
  { code: 'routine_object_cleaning_supplies', pattern: /^(?:aquisicao|fornecimento) de (?:material de limpeza|materiais de limpeza)(?: para uso (?:administrativo|interno))?$/ },
  { code: 'routine_object_building_cleaning', pattern: /^(?:(?:contratacao|prestacao) de )?servicos(?: continuados)? de limpeza(?: e conservacao)? predial(?: com fornecimento de materiais e equipamentos)?$/ },
  { code: 'routine_object_property_security', pattern: /^(?:(?:contratacao|prestacao) de )?servicos(?: continuados)? de vigilancia patrimonial(?: armada| desarmada)?$/ },
  { code: 'routine_object_printer_rental', pattern: /^(?:locacao|aluguel) de impressoras(?: multifuncionais)?$/ },
  { code: 'routine_object_printing', pattern: /^(?:(?:contratacao|prestacao) de )?servicos de impressao(?: e reprografia)?$/ },
];

// Positive proof for EVERY clause, not a blacklist of every possible material
// subject. Unknown clauses (including in metadata) stay REVIEW. In particular,
// free text following an accepted object or field must not inherit its status.
const ROUTINE_ADMINISTRATIVE_CLAUSES: readonly RegExp[] = [
  /^contratante\s*:\s*uniao(?: federal)?$/,
  // Deliberately high precision: one name token plus a legal suffix. More
  // complex legal names remain REVIEW; an open name regex can swallow prose.
  /^contratad[ao]\s*:\s*[a-z][a-z0-9]{1,39}\s+(?:ltda|s\.?\s*a|eireli)$/,
  /^cnpj\s*:\s*\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/,
  /^(?:pregao(?: eletronico| presencial)?|dispensa de licitacao|inexigibilidade de licitacao|concorrencia(?: eletronica)?)\s+(?:n[º°o.]?\s*)?\d+(?:\/\d{4})?$/,
  /^valor(?: global| total)?\s*:\s*(?:r\$\s*)?\d[\d.,]*$/,
  /^vigencia\s*:\s*(?:\d{2}\/\d{2}\/\d{4}\s+a\s+\d{2}\/\d{2}\/\d{4}|\d+\s+(?:dias|meses|anos))$/,
  /^(?:fundamento legal|fundamentacao legal|amparo legal|base legal)\s*:\s*lei\s+(?:n[º°o.]?\s*)?14\.?133(?:\/2021)?$/,
  /^processo(?: administrativo)?\s*:\s*\d[\d./-]*$/,
  /^uasg\s*:\s*\d+$/,
  /^(?:data (?:de|da) assinatura|assinatura)\s*:\s*\d{2}\/\d{2}\/\d{4}$/,
];
const ROUTINE_BOILERPLATE_CLAUSES: readonly RegExp[] = [
  /^(?:o )?pagamento(?: sera (?:efetuado|realizado))? (?:mediante|apos) (?:(?:a )?(?:apresentacao|conferencia|atesto) (?:de|da|das) )?notas? fisca(?:l|is)(?: eletronicas?)?(?: e (?:comprovacao de )?regularidade fiscal)?$/,
  /^(?:conferencia|atesto) (?:de|da|das) notas? fisca(?:l|is)(?: eletronicas?)?$/,
  /^(?:comprovacao (?:de|da) |manutencao da )?regularidade fiscal$/,
  /^(?:o )?fiscal do contrato (?:sera|foi|e) designado$/,
  /^(?:designacao|indicacao|substituicao) do fiscal do contrato$/,
  /^(?:continuacao|informacoes complementares)$/,
];

function clauses(text: string): string[] {
  // Do not split decimal values, CNPJ or S.A.; delimit only sentence endings
  // followed by whitespace and preserve boundaries between parser fields.
  return text.split(/(?<=[.;!?])\s+|\n+/)
    .map(value => value.trim().replace(/[.;!?]+$/g, '').trim()).filter(Boolean);
}
function isRoutineBoilerplate(clause: string): boolean {
  return ROUTINE_BOILERPLATE_CLAUSES.some(pattern => pattern.test(clause));
}
function isRoutineAdministrativeText(text: string): boolean {
  return clauses(text).every(clause => {
    const object = /^objeto(?: do contrato)?\s*:\s*(.+)$/.exec(clause)?.[1];
    return (object !== undefined && ROUTINE_OBJECT_RULES.some(rule => rule.pattern.test(object))) ||
      ROUTINE_ADMINISTRATIVE_CLAUSES.some(pattern => pattern.test(clause)) || isRoutineBoilerplate(clause);
  });
}

function normalizeClauses(value: string | null | undefined): string {
  // A line break is an evidence boundary even when the source omits a period.
  // Collapsing it would let a free-text party field swallow the next clause.
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n').toLowerCase().replace(/[^\S\n]+/g, ' ').trim();
}
function normalize(value: string | null | undefined): string {
  // Matching/extraction retains its whitespace-insensitive representation;
  // positive clause proof must always use normalizeClauses instead.
  return normalizeClauses(value).replace(/\s+/g, ' ').trim();
}
function result(category: DouScopeCategory, decision: DouScopeDecision, reasonCodes: string[]): DouScopeClassification {
  return { ruleVersion: DOU_SCOPE_RULE_VERSION, category, decision, reasonCodes };
}
function review(reasonCode: string): DouScopeClassification { return result('AMBIGUO', 'REVIEW', [reasonCode]); }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function supplementaryTexts(publication: DouScopePublication): string[] {
  const dou = record(publication.metadata?.dou);
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
  // The parser deliberately keeps Ementa and continuation headings out of
  // content. They can veto IGNORE, never supply the positive routine evidence.
  return [typeof dou?.abstract === 'string' ? dou.abstract : '',
    ...strings(dou?.continuationTitles), ...strings(dou?.continuationAbstracts)]
    .map(normalizeClauses).filter(Boolean);
}
function withoutNeutralFiscalBoilerplate(text: string): string {
  // Never erase a keyword within a longer clause. A normative qualifier after
  // "nota fiscal" / "regularidade fiscal" makes the whole clause non-neutral.
  return clauses(text).filter(clause => !isRoutineBoilerplate(clause)).join('\n');
}

function extractSingleObject(content: string): ObjectExtraction {
  const objectLabel = /\bobjeto(?: do contrato)?\s*:/g;
  const labels: RegExpExecArray[] = [];
  let label: RegExpExecArray | null;
  while ((label = objectLabel.exec(content)) !== null) labels.push(label);
  if (labels.length === 0) return { ok: false, reasonCode: 'missing_object_field' };
  if (labels.length > 1) return { ok: false, reasonCode: 'multiple_object_fields' };
  const firstLabel = labels[0]!;
  const tail = content.slice(firstLabel.index + firstLabel[0].length);
  const nextField = /\b(?:contratante|contratad[ao]|fundamento legal|fundamentacao legal|amparo legal|base legal|vigencia|valor(?: global| total)?|data (?:de|da) assinatura|assinatura|dotacao orcamentaria|programa de trabalho|processo(?: administrativo)?|uasg|cnpj|modalidade(?: de licitacao)?|licitacao|pregao(?: eletronico| presencial)?|dispensa(?: de licitacao)?|inexigibilidade(?: de licitacao)?)\s*:/;
  const boundary = nextField.exec(tail);
  if (boundary === null) return { ok: false, reasonCode: 'object_not_bounded' };
  const text = tail.slice(0, boundary.index).replace(/[\s.;:,]+$/g, '').trim();
  if (!text) return { ok: false, reasonCode: 'empty_object_field' };
  return { ok: true, text };
}
function hasProcurementStructure(content: string): boolean {
  return /\bcontratante\s*:/.test(content) &&
    /\bcontratad[ao]\s*:/.test(content) &&
    /\b(?:pregao(?: eletronico| presencial)?|dispensa de licitacao|inexigibilidade de licitacao|concorrencia(?: eletronica)?)\b/.test(content) &&
    /\b(?:valor(?: global| total)?|vigencia)\s*:/.test(content);
}

export function classifyDouContractExcerpt(publication: DouScopePublication): DouScopeClassification | null {
  const title = normalize(publication.title);
  if (!/^extrato de contrato\b/.test(title)) return null;
  const content = normalize(publication.content);
  const clauseContent = normalizeClauses(publication.content);
  const supplementary = supplementaryTexts(publication);
  const fullText = [title, content, ...supplementary.map(normalize)].join('\n');

  const relevanceMatches = RELEVANCE_RULES.filter((rule) => rule.pattern.test(fullText));
  const first = relevanceMatches[0];
  if (first) return result(first.category, 'KEEP', relevanceMatches.map((rule) => rule.code));

  const ambiguousText = withoutNeutralFiscalBoilerplate([title, clauseContent, ...supplementary].join('\n'));
  const ambiguousMatches = AMBIGUOUS_RELEVANCE_RULES.filter((rule) => rule.pattern.test(ambiguousText));
  if (ambiguousMatches.length) return result('AMBIGUO', 'REVIEW', ambiguousMatches.map((rule) => rule.code));
  if (record(publication.metadata?.dou)?.scopeStructureIncomplete === true) return review('incomplete_text_structure');

  if (!content) return review('missing_content');
  const object = extractSingleObject(content);
  if (!object.ok) return review(object.reasonCode);
  const routine = ROUTINE_OBJECT_RULES.find((rule) => rule.pattern.test(object.text));
  if (!routine) return review('ordinary_procurement_object_not_confirmed');
  if (!hasProcurementStructure(content)) return review('missing_procurement_structure');
  // A structured CNPJ only strengthens the proof; it never authorizes IGNORE
  // alone. Duplicate party fields anywhere, including supplements, are unsafe.
  if (['contratante', 'contratad[ao]', 'cnpj'].some(field =>
    [...fullText.matchAll(new RegExp(`\\b${field}\\s*:`, 'g'))].length !== 1)) return review('missing_or_duplicate_party_field');
  if (!/^extrato de contrato(?:\s+n[º°o.]?\s*\d+(?:\/\d{4})?)?$/.test(title)) return review('unrecognized_contract_title');
  if (!isRoutineAdministrativeText(clauseContent)) return review('unrecognized_administrative_content');
  if (supplementary.some(text => text !== title && !isRoutineAdministrativeText(text) &&
    !ROUTINE_OBJECT_RULES.some(rule => rule.pattern.test(text)))) return review('unrecognized_supplementary_text');
  return result('CONTRATACAO_ADMINISTRATIVA_ROTINEIRA', 'IGNORE', ['procurement_structure_confirmed', routine.code]);
}
