import { asciiUpper } from './doe-sp.parser.js';

/*
 * Deterministic capture rules and normative identity for DOE-SP
 * (Executivo > Atos Normativos). No AI, no fuzzy matching: every decision is
 * explained by a category (included) or a reason (excluded).
 */

export interface DoeSpCandidate {
  title: string;
  /** Hierarchy from the source: ['Executivo', 'Atos Normativos', '<Órgão>', ...units]. */
  hierarchy: string[];
  typeName?: string;
  excerpt?: string;
}

export type DoeSpInclusionCategory =
  | 'LEGISLATION'
  | 'NUMBERED_DECREE'
  | 'DECREES_SECTION'
  | 'GOVERNOR_ACT_TAX_TERMS'
  | 'VETO_TAX_TERMS'
  | 'SEFAZ_TAX_ADMINISTRATION'
  | 'SEFAZ_CABINET'
  | 'SEFAZ_OTHER_TAX_TERMS'
  | 'PGE_TAX'
  | 'OTHER_ORGAN_TAX_TERMS';

export type DoeSpExclusionReason =
  | 'OUT_OF_SCOPE_SECTION'
  | 'INDIVIDUAL_TAX_ADMINISTRATIVE_ACT'
  | 'SEFAZ_NON_TAX_UNIT'
  | 'NUMBERED_DECREE_WITHOUT_TAX_TERMS'
  | 'GOVERNOR_ACT_WITHOUT_TAX_TERMS'
  | 'VETO_WITHOUT_TAX_TERMS'
  | 'PGE_WITHOUT_TAX_TERMS'
  | 'SEFAZ_CABINET_NON_TAX_INDEX'
  | 'OTHER_ORGAN_INDIVIDUAL_TAX_INCENTIVE'
  | 'OTHER_ORGAN_PAYMENT_ORDER'
  | 'NON_NORMATIVE_TYPE'
  | 'OTHER_ORGAN_WITHOUT_TAX_TERMS';

export type DoeSpDecision =
  | { included: true; category: DoeSpInclusionCategory }
  | { included: false; reason: DoeSpExclusionReason };

/**
 * Tax vocabulary (ASCII upper). Deliberately excludes ambiguous words such as
 * a bare "FISCAL" ("fiscal do contrato") or "ISENCAO" ("isenção de taxa de
 * inscrição" in public tenders); those contexts are covered by the more
 * specific terms below.
 */
export const DOE_SP_TAX_TERMS = new RegExp(
  '\\b(?:' + [
    'ICMS', 'IPVA', 'ITCMD', 'ITCD', 'IBS', 'CBS', 'IPI', 'RICMS', 'CONFAZ',
    'SIMPLES NACIONAL', 'SUBSTITUICAO TRIBUTARIA', 'DIFAL',
    'TRIBUTAR\\w*', 'TRIBUTO\\w*', 'TRIBUTAC\\w*', 'IMPOSTOS?',
    'NOTAS? FISCA\\w*', 'NF-?E', 'NFC-?E', 'CT-?E', 'MDF-?E', 'EFD', 'SPED',
    'DOCUMENTOS? FISCA\\w*', 'OBRIGAC\\w* ACESSORIA\\w*',
    'BENEFICIOS? FISCA\\w*', 'INCENTIVOS? FISCA\\w*',
    'CREDITOS? (?:PRESUMIDO|OUTORGADO|ACUMULADO)\\w*',
    'DIVIDA ATIVA', 'REFORMA TRIBUTARIA', 'CONTRIBUINTES? DO ICMS',
    'CADASTRO DE CONTRIBUINTES', 'SUBSECRETARIA DA RECEITA ESTADUAL',
  ].join('|') + ')\\b',
);

const NORMATIVE_TYPES = new Set([
  'LEI', 'EMENDA CONSTITUCIONAL ESTADUAL', 'DECRETO NUMERADO', 'DECRETO NAO NUMERADO',
  'RESOLUCAO', 'PORTARIA', 'PORTARIA CONJUNTA', 'PORTARIA NORMATIVA', 'INSTRUCAO NORMATIVA',
  'DELIBERACAO', 'COMUNICADO', 'DECISAO', 'RETIFICACAO', 'ERRATA',
]);

function hasTaxTerms(candidate: DoeSpCandidate): boolean {
  return DOE_SP_TAX_TERMS.test(asciiUpper(candidate.title + ' ' + (candidate.excerpt ?? '')));
}

/** Organ = third hierarchy level ('Executivo' > 'Atos Normativos' > organ). */
export function doeSpOrgan(hierarchy: string[]): string {
  return hierarchy[2] ?? '';
}

export function decideDoeSpCapture(candidate: DoeSpCandidate): DoeSpDecision {
  const [journal, section] = candidate.hierarchy.map(asciiUpper);
  if (journal !== 'EXECUTIVO' || section !== 'ATOS NORMATIVOS') {
    return { included: false, reason: 'OUT_OF_SCOPE_SECTION' };
  }
  const organ = asciiUpper(doeSpOrgan(candidate.hierarchy));
  const units = candidate.hierarchy.slice(3).map(asciiUpper);
  const unitPath = units.join(' > ');
  const type = candidate.typeName ? asciiUpper(candidate.typeName) : undefined;
  const title = asciiUpper(candidate.title);
  const text = asciiUpper(candidate.title + ' ' + (candidate.excerpt ?? ''));

  if (
    organ === 'LEIS' || organ === 'LEIS COMPLEMENTARES' || organ.startsWith('EMENDA') ||
    type === 'LEI' || type === 'EMENDA CONSTITUCIONAL ESTADUAL'
  ) {
    return { included: true, category: 'LEGISLATION' };
  }

  if (organ === 'DECRETOS') {
    if (type === 'DECRETO NUMERADO' || /^DECRETO N/.test(title)) {
      return hasTaxTerms(candidate)
        ? { included: true, category: 'NUMBERED_DECREE' }
        : { included: false, reason: 'NUMBERED_DECREE_WITHOUT_TAX_TERMS' };
    }
    // Retifications/errata in the Decretos section are kept conservatively: their
    // short summary may only reference the corrected decree number, without
    // repeating the tax subject. They remain SOURCE_SCOPED and are rare.
    return { included: true, category: 'DECREES_SECTION' };
  }

  if (organ.startsWith('VETO')) {
    return hasTaxTerms(candidate)
      ? { included: true, category: 'VETO_TAX_TERMS' }
      : { included: false, reason: 'VETO_WITHOUT_TAX_TERMS' };
  }

  if (organ === 'ATOS DO GOVERNADOR') {
    return hasTaxTerms(candidate)
      ? { included: true, category: 'GOVERNOR_ACT_TAX_TERMS' }
      : { included: false, reason: 'GOVERNOR_ACT_WITHOUT_TAX_TERMS' };
  }

  if (organ.includes('FAZENDA')) {
    // Delegacias Tributárias / Postos Fiscais / Núcleos publish individual acts
    // about identified taxpayers (IE cassation, PCN, AIIM, ITCMD notices).
    if (/\b(DELEGACIAS?|POSTOS? FISCA\w*|NUCLEO DE SERVICOS|DRT\b|DRTC\b)/.test(unitPath)) {
      return { included: false, reason: 'INDIVIDUAL_TAX_ADMINISTRATIVE_ACT' };
    }
    if (/RECEITA ESTADUAL|ADMINISTRACAO TRIBUTARIA|TRIBUNAL DE IMPOSTOS E TAXAS/.test(unitPath)) {
      return { included: true, category: 'SEFAZ_TAX_ADMINISTRATION' };
    }
    if (units[0] === 'GABINETE DO SECRETARIO') {
      // SFP/AEFP also publishes administrative price indexes for contracts and
      // public works. They are not tax rules even though they sit in the cabinet.
      if (
        /\bSFP\s*\/\s*AEFP\b/.test(title) &&
        /\b(?:INDICES? DE (?:REAJUSTES?|PRECOS?)|REAJUSTES? DE PRECOS|PRECOS? DE OBRAS PUBLICAS|CONTRATOS? DE SERVICOS)\b/.test(text)
      ) {
        return { included: false, reason: 'SEFAZ_CABINET_NON_TAX_INDEX' };
      }
      return { included: true, category: 'SEFAZ_CABINET' };
    }
    return hasTaxTerms(candidate)
      ? { included: true, category: 'SEFAZ_OTHER_TAX_TERMS' }
      : { included: false, reason: 'SEFAZ_NON_TAX_UNIT' };
  }

  if (organ === 'PROCURADORIA GERAL DO ESTADO') {
    if (/CONTENCIOSO TRIBUTARIO|DIVIDA ATIVA/.test(unitPath) || hasTaxTerms(candidate)) {
      return { included: true, category: 'PGE_TAX' };
    }
    return { included: false, reason: 'PGE_WITHOUT_TAX_TERMS' };
  }

  if (type && !NORMATIVE_TYPES.has(type)) return { included: false, reason: 'NON_NORMATIVE_TYPE' };

  // Operational grants under ProAC can contain the literal "incentivo fiscal -
  // ICMS" but are approvals/transfers for identified projects, not general tax
  // rules. Keep actual tax legislation from other organs eligible.
  if (/\bPROAC\b/.test(text) && /\bINCENTIVO FISCAL\b/.test(text) && /\bICMS\b/.test(text)) {
    return { included: false, reason: 'OTHER_ORGAN_INDIVIDUAL_TAX_INCENTIVE' };
  }

  // "Quebra de ordem cronológica" publications are payment/procurement notices.
  // They may quote invoice/fiscal terminology without creating tax obligations.
  if (/\bQUEBRA DE ORDEM CRONOLOGICA\b/.test(text)) {
    return { included: false, reason: 'OTHER_ORGAN_PAYMENT_ORDER' };
  }

  return hasTaxTerms(candidate)
    ? { included: true, category: 'OTHER_ORGAN_TAX_TERMS' }
    : { included: false, reason: 'OTHER_ORGAN_WITHOUT_TAX_TERMS' };
}

// ---------------------------------------------------------------- identity

const MONTHS = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

function validDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value ? value : undefined;
}

/** Signature date written in the title ("DE 3 DE SETEMBRO DE 2026", "DE 31-08-2026", "DE 01/09/2026"). */
export function doeSpTitleDate(title: string): string | undefined {
  const upper = asciiUpper(title);
  const long = /\bDE (\d{1,2})(?:O|º|°)? DE ([A-Z]+) DE (\d{4})\b/.exec(upper);
  if (long) {
    const month = MONTHS.indexOf(long[2]!) + 1;
    if (month > 0) return validDate(Number(long[3]), month, Number(long[1]));
  }
  const short = /\bDE (\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(upper);
  if (short) return validDate(Number(short[3]), Number(short[2]), Number(short[1]));
  return undefined;
}

export type DoeSpActType =
  | 'LEI COMPLEMENTAR'
  | 'LEI'
  | 'EMENDA CONSTITUCIONAL'
  | 'DECRETO'
  | 'RESOLUÇÃO CONJUNTA'
  | 'RESOLUÇÃO'
  | 'PORTARIA CONJUNTA'
  | 'PORTARIA NORMATIVA'
  | 'PORTARIA'
  | 'INSTRUÇÃO NORMATIVA'
  | 'COMUNICADO'
  | 'DELIBERAÇÃO'
  | 'DECISÃO'
  | 'RETIFICAÇÃO'
  | 'DESPACHO'
  | 'ATO';

const TYPE_PATTERNS: ReadonlyArray<[RegExp, DoeSpActType]> = [
  [/^LEI COMPLEMENTAR\b/, 'LEI COMPLEMENTAR'],
  [/^LEI\b/, 'LEI'],
  [/^EMENDA CONSTITUCIONAL\b/, 'EMENDA CONSTITUCIONAL'],
  [/^DECRETO\b/, 'DECRETO'],
  [/^RESOLUCAO CONJUNTA\b/, 'RESOLUÇÃO CONJUNTA'],
  [/^RESOLUCAO\b/, 'RESOLUÇÃO'],
  [/^PORTARIA CONJUNTA\b/, 'PORTARIA CONJUNTA'],
  [/^PORTARIA NORMATIVA\b/, 'PORTARIA NORMATIVA'],
  [/^PORTARIA\b/, 'PORTARIA'],
  [/^INSTRUCAO NORMATIVA\b/, 'INSTRUÇÃO NORMATIVA'],
  [/^COMUNICADO\b/, 'COMUNICADO'],
  [/^DELIBERACAO\b/, 'DELIBERAÇÃO'],
  [/^DECISAO\b/, 'DECISÃO'],
  [/^(RETIFICACAO|ERRATA|REPUBLICACAO)\b/, 'RETIFICAÇÃO'],
  [/^DESPACHO\b/, 'DESPACHO'],
];

const TYPE_FROM_SOURCE: Record<string, DoeSpActType> = {
  'LEI': 'LEI',
  'EMENDA CONSTITUCIONAL ESTADUAL': 'EMENDA CONSTITUCIONAL',
  'DECRETO NUMERADO': 'DECRETO',
  'DECRETO NAO NUMERADO': 'DECRETO',
  'RESOLUCAO': 'RESOLUÇÃO',
  'PORTARIA': 'PORTARIA',
  'PORTARIA CONJUNTA': 'PORTARIA CONJUNTA',
  'PORTARIA NORMATIVA': 'PORTARIA NORMATIVA',
  'INSTRUCAO NORMATIVA': 'INSTRUÇÃO NORMATIVA',
  'COMUNICADO': 'COMUNICADO',
  'DELIBERACAO': 'DELIBERAÇÃO',
  'DECISAO': 'DECISÃO',
  'RETIFICACAO': 'RETIFICAÇÃO',
  'ERRATA': 'RETIFICAÇÃO',
  'DESPACHO': 'DESPACHO',
};

export function doeSpActType(title: string, typeName?: string): DoeSpActType {
  const upper = asciiUpper(title);
  for (const [pattern, type] of TYPE_PATTERNS) if (pattern.test(upper)) return type;
  const fromSource = typeName ? TYPE_FROM_SOURCE[asciiUpper(typeName)] : undefined;
  return fromSource ?? 'ATO';
}

/** Designation tokens that are grammar, not an issuer acronym. */
const NOT_DESIGNATIONS = new Set(['DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'NO', 'NA', 'N', 'NO.', 'SERIE', 'DO SR', 'DO SECRETARIO']);

export interface DoeSpNormativeIdentity {
  /** Canonical issuer used in the identity (e.g. 'GOVERNO-SP', 'SEFAZ-SP/SRE'). */
  agency: string;
  actType: DoeSpActType;
  /** `<number>/<year>` without thousands separators or leading zeros. */
  actNumber: string;
  /** Designation acronym written in the title (SRE, SFP, DICAR, SRE/STE...). */
  designation?: string;
  signedOn?: string;
}

function number(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return undefined;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

function fullYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (raw.length === 4) return value;
  if (raw.length === 2) return value >= 70 ? 1900 + value : 2000 + value;
  return undefined;
}

/**
 * Strong normative identity, only for issuers whose numbering series is
 * unambiguous within São Paulo:
 * - Leis / Leis Complementares / Emendas / Decretos numerados (Governo do Estado);
 * - designated acts of SEFAZ central units and PGE (e.g. "PORTARIA SRE 43",
 *   "RESOLUÇÃO SFP-25", "COMUNICADO DICAR Nº 59", "PORTARIA CONJUNTA SRE/STE 05").
 * Anything else (unnumbered acts, regional units, retifications) returns
 * undefined and is identified by the DOE publication id (SOURCE_SCOPED).
 */
export function doeSpNormativeIdentity(input: {
  title: string;
  typeName?: string;
  category: DoeSpInclusionCategory;
}): DoeSpNormativeIdentity | undefined {
  const upper = asciiUpper(input.title).replace(/[º°]/g, 'O');
  const actType = doeSpActType(input.title, input.typeName);
  if (actType === 'RETIFICAÇÃO' || actType === 'DESPACHO' || actType === 'ATO') return undefined;
  const signedOn = doeSpTitleDate(input.title);

  if (input.category === 'LEGISLATION' || input.category === 'NUMBERED_DECREE') {
    if (!['LEI', 'LEI COMPLEMENTAR', 'EMENDA CONSTITUCIONAL', 'DECRETO'].includes(actType)) return undefined;
    // Thousands separator as printed, also with a stray space ("LEI Nº 17. 839",
    // DOE-SP-40). A number still followed by any run of spaces/"."/"," and more
    // digits ("17 839", "17..839", "17, 839") is not trusted (no strong identity).
    // The title date is always introduced by "DE" (", DE 1º DE ..."), never by digits.
    const match = /^(?:LEI COMPLEMENTAR|LEI|EMENDA CONSTITUCIONAL|DECRETO)\s+(?:N[O.]?\s*|NUMERO\s+)(\d{1,3}(?:\.\s?\d{3})+|\d+)\b(?![\s.,]*\d)/.exec(upper);
    const value = match ? number(match[1]!) : undefined;
    const year = signedOn ? Number(signedOn.slice(0, 4)) : undefined;
    if (!value || !year) return undefined;
    return { agency: 'GOVERNO-SP', actType, actNumber: `${value}/${year}`, ...(signedOn ? { signedOn } : {}) };
  }

  if (!['SEFAZ_TAX_ADMINISTRATION', 'SEFAZ_CABINET', 'SEFAZ_OTHER_TAX_TERMS', 'PGE_TAX'].includes(input.category)) {
    return undefined;
  }
  const typeWords = /^(RESOLUCAO CONJUNTA|RESOLUCAO|PORTARIA CONJUNTA|PORTARIA NORMATIVA|PORTARIA|INSTRUCAO NORMATIVA|COMUNICADO|DELIBERACAO|DECISAO)\s+/;
  const typeMatch = typeWords.exec(upper);
  if (!typeMatch) return undefined;
  const rest = upper.slice(typeMatch[0].length);
  // "[Nº] <DESIG>[-/ ]<DESIG2>... [Nº] <number>[/<year>]"
  // A number followed by spaces/"."/"," and more digits ("1.234", "59 123") is
  // not trusted (DOE-SP-40).
  const designated = /^(?:NO?\.?\s+)?([A-Z]{2,}(?:\s?[/-]\s?[A-Z]{2,})*)[\s-]*(?:NO?\.?\s*)?(\d{1,6})(?:\s*\/\s*(\d{4}|\d{2}))?\b(?![\s.,]*\d)/.exec(rest);
  if (!designated) return undefined;
  const designation = designated[1]!.replace(/\s+/g, '');
  if (NOT_DESIGNATIONS.has(designation) || designation.split(/[/-]/).some((part) => NOT_DESIGNATIONS.has(part))) return undefined;
  const value = number(designated[2]!);
  const year = fullYear(designated[3]) ?? (signedOn ? Number(signedOn.slice(0, 4)) : undefined);
  if (!value || !year) return undefined;
  const issuer = input.category === 'PGE_TAX' ? 'PGE-SP' : 'SEFAZ-SP';
  return {
    agency: `${issuer}/${designation}`,
    actType,
    actNumber: `${value}/${year}`,
    designation,
    ...(signedOn ? { signedOn } : {}),
  };
}
