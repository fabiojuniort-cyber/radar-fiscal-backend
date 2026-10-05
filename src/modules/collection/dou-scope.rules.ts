export const DOU_SCOPE_RULE_VERSION = 'dou-scope-v2' as const;

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
  { category: 'REGULATORIO_CONCESSAO', code: 'concession_or_public_service_delegation', pattern: /\b(?:contrato de (?:sub)?concessao|subconcessao|concessao de servicos? publicos?|delegacao de servicos? publicos?)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'regulated_infrastructure_grant', pattern: /\b(?:concessao|permissao|outorga|autorizacao)\b.{0,180}\b(?:rodovias?|ferrovias?|infraestrutura rodoviaria|infraestrutura ferroviaria|servicos? publicos?|instalacao portuaria|terminal de uso privado|geracao de energia|distribuicao de energia|transmissao de energia|lavra mineral)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'regulated_infrastructure_operation', pattern: /\b(?:exploracao|operacao)\b.{0,100}\b(?:rodovias?|ferrovias?|infraestrutura rodoviaria|infraestrutura ferroviaria|terminal de uso privado)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'grant_or_transfer_of_regulatory_authorization', pattern: /\b(?:outorga|transferencia)\s+de\s+(?:concessao|permissao|autorizacao)\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'tariff_revision', pattern: /\b(?:revisao|reajuste)\s+tarifari[oa]\b/ },
  { category: 'REGULATORIO_CONCESSAO', code: 'mineral_rights_transfer', pattern: /\b(?:cessao|transferencia)\s+de\s+direitos?\s+minerari[oa]s?\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_control_change', pattern: /\b(?:alteracao|transferencia|aquisicao|alienacao)\s+(?:de|do)\s+controle\s+(?:societario|acionario)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_reorganization', pattern: /\b(?:fusao|cisao|incorporacao)\s+(?:societaria|empresarial|(?:de|da|do|das|dos) (?:empresas?|sociedades?|companhias?|contratad[ao]s?))\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_succession', pattern: /\bsucessor(?:a|es|as)?\s+(?:em todos os|nos|em seus)\s+direitos e obrigacoes\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'corporate_restructuring_or_intervention', pattern: /\b(?:recuperacao judicial|liquidacao extrajudicial|intervencao societaria)\b/ },
  { category: 'EMPRESARIAL_RELEVANTE', code: 'leniency_agreement', pattern: /\bacordo de leniencia\b/ },
];

// These signals are too broad to prove KEEP, but are incompatible with a
// confident routine-only decision. Unknown material context must fail safe.
const AMBIGUOUS_RELEVANCE_RULES: readonly RoutineObjectRule[] = [
  { code: 'possible_tax_relevance', pattern: /\b(?:tributari[oa]s?|aduaneir[oa]s?|tributos?|impostos?|icms|iss|issqn|ipi|pis|pasep|cofins|irpj|irpf|csll|iof|itr|iptu|itbi|itcmd|ibs|cbs|isencao|isencoes|remissao|anistia|compensacao|fisca(?:l|is))\b/ },
  { code: 'possible_regulatory_relevance', pattern: /\b(?:concessao|concessoes|subconcessao|outorga|outorgas|tarifari[oa]s?|minerari[oa]s?|regulatori[oa]s?)\b/ },
  { code: 'possible_corporate_relevance', pattern: /\b(?:fusao|fusoes|cisao|cisoes|incorporacao|incorporacoes|societari[oa]s?|acionari[oa]s?|sucessao|sucessor(?:a|es|as)?|recuperacao judicial|falencia|liquidacao extrajudicial|leniencia)\b/ },
];

const ROUTINE_OBJECT_RULES: readonly RoutineObjectRule[] = [
  { code: 'routine_object_office_supplies', pattern: /^(?:aquisicao|fornecimento) de (?:papel a4|material de expediente|materiais de expediente|material de escritorio|materiais de escritorio)(?: para uso (?:administrativo|interno))?$/ },
  { code: 'routine_object_cleaning_supplies', pattern: /^(?:aquisicao|fornecimento) de (?:material de limpeza|materiais de limpeza)(?: para uso (?:administrativo|interno))?$/ },
  { code: 'routine_object_building_cleaning', pattern: /^(?:(?:contratacao|prestacao) de )?servicos(?: continuados)? de limpeza(?: e conservacao)? predial(?: com fornecimento de materiais e equipamentos)?$/ },
  { code: 'routine_object_property_security', pattern: /^(?:(?:contratacao|prestacao) de )?servicos(?: continuados)? de vigilancia patrimonial(?: armada| desarmada)?$/ },
  { code: 'routine_object_printer_rental', pattern: /^(?:locacao|aluguel) de impressoras(?: multifuncionais)?$/ },
  { code: 'routine_object_printing', pattern: /^(?:(?:contratacao|prestacao) de )?servicos de impressao(?: e reprografia)?$/ },
];

function normalize(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u00a0/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}
function result(category: DouScopeCategory, decision: DouScopeDecision, reasonCodes: string[]): DouScopeClassification {
  return { ruleVersion: DOU_SCOPE_RULE_VERSION, category, decision, reasonCodes };
}
function review(reasonCode: string): DouScopeClassification { return result('AMBIGUO', 'REVIEW', [reasonCode]); }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function relevanceText(publication: DouScopePublication): string {
  const dou = record(publication.metadata?.dou);
  const continuationTitles = Array.isArray(dou?.continuationTitles)
    ? dou.continuationTitles.filter((value): value is string => typeof value === 'string') : [];
  // The parser deliberately keeps Ementa and continuation headings out of
  // content. They can veto IGNORE, never supply the positive routine evidence.
  return [publication.title, publication.content,
    typeof dou?.abstract === 'string' ? dou.abstract : '', ...continuationTitles]
    .map(normalize).filter(Boolean).join(' ');
}
function withoutNeutralFiscalBoilerplate(text: string): string {
  return text
    .replace(/\bnotas? fisca(?:l|is)\b/g, ' ')
    .replace(/\b(?:fisca(?:l|is)|fiscalizacao) d[oa]s? contratos?\b/g, ' ')
    .replace(/\bregularidade fisca(?:l|is)\b/g, ' ');
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
  const fullText = relevanceText(publication);

  const relevanceMatches = RELEVANCE_RULES.filter((rule) => rule.pattern.test(fullText));
  const first = relevanceMatches[0];
  if (first) return result(first.category, 'KEEP', relevanceMatches.map((rule) => rule.code));

  const ambiguousText = withoutNeutralFiscalBoilerplate(fullText);
  const ambiguousMatches = AMBIGUOUS_RELEVANCE_RULES.filter((rule) => rule.pattern.test(ambiguousText));
  if (ambiguousMatches.length) return result('AMBIGUO', 'REVIEW', ambiguousMatches.map((rule) => rule.code));

  if (!content) return review('missing_content');
  const object = extractSingleObject(content);
  if (!object.ok) return review(object.reasonCode);
  const routine = ROUTINE_OBJECT_RULES.find((rule) => rule.pattern.test(object.text));
  if (!routine) return review('ordinary_procurement_object_not_confirmed');
  if (!hasProcurementStructure(content)) return review('missing_procurement_structure');
  return result('CONTRATACAO_ADMINISTRATIVA_ROTINEIRA', 'IGNORE', ['procurement_structure_confirmed', routine.code]);
}
