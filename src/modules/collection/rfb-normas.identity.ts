function asciiUpper(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

export type CanonicalRfbAgency =
  | 'RFB'
  | 'COSIT'
  | 'COANA'
  | 'COFIS'
  | 'CODAC'
  | 'COCAD'
  | 'CORAT'
  | 'COTEC'
  | 'COSIS'
  | 'SUARA'
  | 'SUFIS'
  | 'SUARI';

export type CanonicalRfbActType =
  | 'INSTRUÇÃO NORMATIVA'
  | 'INSTRUÇÃO NORMATIVA CONJUNTA'
  | 'ATO DECLARATÓRIO INTERPRETATIVO'
  | 'ATO DECLARATÓRIO NORMATIVO'
  | 'ATO DECLARATÓRIO EXECUTIVO'
  | 'ATO DECLARATÓRIO EXECUTIVO CONJUNTO'
  | 'PARECER NORMATIVO'
  | 'SOLUÇÃO DE CONSULTA'
  | 'SOLUÇÃO DE DIVERGÊNCIA'
  | 'NOTA TÉCNICA'
  | 'NOTA TÉCNICA CONJUNTA'
  | 'ATO TÉCNICO CONJUNTO'
  | 'NORMA DE EXECUÇÃO'
  | 'NORMA DE EXECUÇÃO CONJUNTA'
  | 'PORTARIA'
  | 'PORTARIA CONJUNTA'
  | 'PORTARIA NORMATIVA'
  | 'PORTARIA INTERMINISTERIAL'
  | 'ORIENTAÇÃO NORMATIVA'
  | 'ATO CONJUNTO';

const TYPE_PATTERNS: ReadonlyArray<[RegExp, CanonicalRfbActType]> = [
  [/\bINSTRUCAO NORMATIVA CONJUNTA\b/, 'INSTRUÇÃO NORMATIVA CONJUNTA'],
  [/\bINSTRUCAO NORMATIVA\b/, 'INSTRUÇÃO NORMATIVA'],
  [/\bATO DECLARATORIO INTERPRETATIVO\b/, 'ATO DECLARATÓRIO INTERPRETATIVO'],
  [/\bATO DECLARATORIO NORMATIVO\b/, 'ATO DECLARATÓRIO NORMATIVO'],
  [/\bATO DECLARATORIO EXECUTIVO CONJUNTO\b/, 'ATO DECLARATÓRIO EXECUTIVO CONJUNTO'],
  [/\bATO DECLARATORIO EXECUTIVO\b/, 'ATO DECLARATÓRIO EXECUTIVO'],
  [/\bPARECER NORMATIVO\b/, 'PARECER NORMATIVO'],
  [/\bSOLUCAO DE DIVERGENCIA\b/, 'SOLUÇÃO DE DIVERGÊNCIA'],
  [/\bSOLUCAO DE CONSULTA\b/, 'SOLUÇÃO DE CONSULTA'],
  [/\bNOTA TECNICA CONJUNTA\b/, 'NOTA TÉCNICA CONJUNTA'],
  [/\bNOTA TECNICA\b/, 'NOTA TÉCNICA'],
  [/\bATO TECNICO CONJUNTO\b/, 'ATO TÉCNICO CONJUNTO'],
  [/\bNORMA DE EXECUCAO CONJUNTA\b/, 'NORMA DE EXECUÇÃO CONJUNTA'],
  [/\bNORMA DE EXECUCAO\b/, 'NORMA DE EXECUÇÃO'],
  [/\bPORTARIA INTERMINISTERIAL\b/, 'PORTARIA INTERMINISTERIAL'],
  [/\bPORTARIA NORMATIVA\b/, 'PORTARIA NORMATIVA'],
  [/\bPORTARIA CONJUNTA\b/, 'PORTARIA CONJUNTA'],
  [/\bPORTARIA\b/, 'PORTARIA'],
  [/\bORIENTACAO NORMATIVA\b/, 'ORIENTAÇÃO NORMATIVA'],
  [/\bATO CONJUNTO\b/, 'ATO CONJUNTO'],
];

const CENTRAL_AGENCIES = new Set<CanonicalRfbAgency>([
  'RFB', 'COSIT', 'COANA', 'COFIS', 'CODAC', 'COCAD',
  'CORAT', 'COTEC', 'COSIS', 'SUARA', 'SUFIS', 'SUARI',
]);

export function canonicalizeRfbAgency(value: string): CanonicalRfbAgency | undefined {
  const upper = asciiUpper(value).replace(/\s+/g, ' ').trim();
  if (!upper) return undefined;

  if (/\bCOSIT\b|COORDENACAO-GERAL DE TRIBUTACAO/.test(upper)) return 'COSIT';
  if (/\bCOANA\b|COORDENACAO-GERAL DE ADMINISTRACAO ADUANEIRA/.test(upper)) return 'COANA';
  if (/\bCOFIS\b|COORDENACAO-GERAL DE FISCALIZACAO/.test(upper)) return 'COFIS';
  if (/\bCODAC\b|COORDENACAO-GERAL DE ARRECADACAO E COBRANCA/.test(upper)) return 'CODAC';
  if (/\bCOCAD\b|COORDENACAO-GERAL DE GESTAO DE CADASTROS/.test(upper)) return 'COCAD';
  if (/\bCORAT\b|COORDENACAO-GERAL DE ADMINISTRACAO (?:DO CREDITO )?TRIBUTAR/.test(upper)) return 'CORAT';
  if (/\bCOTEC\b|COORDENACAO-GERAL DE TECNOLOGIA/.test(upper)) return 'COTEC';
  if (/\bCOSIS\b|COORDENACAO DE SISTEMAS/.test(upper)) return 'COSIS';
  if (/\bSUARA\b|SUBSECRETARIA DE ARRECADACAO/.test(upper)) return 'SUARA';
  if (/\bSUFIS\b|SUBSECRETARIA DE FISCALIZACAO/.test(upper)) return 'SUFIS';
  if (/\bSUARI\b|SUBSECRETARIA DE ADUANA/.test(upper)) return 'SUARI';
  if (
    /\bRFB\b|\bSRF\b|RECEITA FEDERAL DO BRASIL|SECRETARIA (?:ESPECIAL )?DA RECEITA FEDERAL/.test(upper)
  ) return 'RFB';

  return undefined;
}

export function canonicalizeRfbActType(value: string): CanonicalRfbActType | undefined {
  const upper = asciiUpper(value).replace(/\s+/g, ' ').trim();
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(upper)) return type;
  }
  return undefined;
}

export function normalizeRfbActNumber(
  rawNumber: string,
  year: number | string,
): string | undefined {
  const digits = rawNumber.replace(/\D/g, '');
  const yearDigits = String(year).replace(/\D/g, '');
  if (!digits || !/^\d{4}$/.test(yearDigits)) return undefined;
  const numeric = Number(digits);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return undefined;
  return `${numeric}/${yearDigits}`;
}

export function isCentralRfbAgency(value: string): boolean {
  const agency = canonicalizeRfbAgency(value);
  return agency !== undefined && CENTRAL_AGENCIES.has(agency);
}

const MONTHS: Record<string, number> = {
  JANEIRO: 1,
  FEVEREIRO: 2,
  MARCO: 3,
  ABRIL: 4,
  MAIO: 5,
  JUNHO: 6,
  JULHO: 7,
  AGOSTO: 8,
  SETEMBRO: 9,
  OUTUBRO: 10,
  NOVEMBRO: 11,
  DEZEMBRO: 12,
};

export function parseRfbActDateFromTitle(value: string): Date | undefined {
  const upper = asciiUpper(value);
  const match = /\bDE\s+(\d{1,2})(?:O|º|°)?\s+DE\s+([A-Z]+)\s+DE\s+(\d{4})\b/.exec(upper);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const month = MONTHS[match[2]];
  if (!month) return undefined;
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
    ? parsed
    : undefined;
}

export interface CanonicalRfbFormalAct {
  agency: CanonicalRfbAgency;
  actType: CanonicalRfbActType;
  actNumber: string;
  actDate?: Date;
}

export function parseCanonicalRfbFormalAct(
  title: string,
  agencyHint: string,
  typeHint?: string,
  yearHint?: number,
): CanonicalRfbFormalAct | undefined {
  const type = canonicalizeRfbActType(title) ?? (typeHint ? canonicalizeRfbActType(typeHint) : undefined);
  const agency = canonicalizeRfbAgency(title) ?? canonicalizeRfbAgency(agencyHint);
  if (!type || !agency) return undefined;

  const upper = asciiUpper(title).replace(/\s+/g, ' ').trim();
  const numberMatch = /\bN(?:O|º|°|\.)?\s*([\d.]+)(?:\s*[\/-]\s*(\d{2,4}))?\b/.exec(upper);
  const actDate = parseRfbActDateFromTitle(title);
  let year = numberMatch?.[2] ? Number(numberMatch[2]) : actDate?.getUTCFullYear() ?? yearHint;
  if (year !== undefined && year < 100) year += 2000;
  if (!numberMatch?.[1] || !year) return undefined;
  const actNumber = normalizeRfbActNumber(numberMatch[1], year);
  if (!actNumber) return undefined;

  return {
    agency,
    actType: type,
    actNumber,
    ...(actDate ? { actDate } : {}),
  };
}
