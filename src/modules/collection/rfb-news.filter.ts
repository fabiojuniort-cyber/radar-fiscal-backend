import type { RfbNewsArticle } from './rfb-news.parser.js';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const STRONG_TERMS = [
  'REFORMA TRIBUTARIA',
  'IBS',
  'CBS',
  'IMPOSTO SELETIVO',
  'ICMS',
  'ISS',
  'ISSQN',
  'PIS',
  'COFINS',
  'IPI',
  'IRPJ',
  'CSLL',
  'IRRF',
  'SIMPLES NACIONAL',
  'LUCRO REAL',
  'LUCRO PRESUMIDO',
  'NOTA FISCAL',
  'DOCUMENTO FISCAL',
  'DOCUMENTOS FISCAIS',
  'NF E',
  'NFS E',
  'CT E',
  'MDF E',
  'SPED',
  'EFD',
  'DCTFWEB',
  'EFD REINF',
  'DERE',
  'PER DCOMP',
  'BENEFICIO FISCAL',
  'BENEFICIOS FISCAIS',
  'CREDITO PRESUMIDO',
  'SUBSTITUICAO TRIBUTARIA',
  'DIFERIMENTO',
  'ISENCAO',
  'BASE DE CALCULO',
  'OBRIGACAO ACESSORIA',
  'OBRIGACOES ACESSORIAS',
  'TRANSACAO TRIBUTARIA',
  'PARCELAMENTO',
  'CNPJ ALFANUMERICO',
  'APURACAO ASSISTIDA',
  'SPLIT PAYMENT',
  'CREDITO TRIBUTARIO',
  'CREDITOS TRIBUTARIOS',
  'REGIME TRIBUTARIO',
  'REGIMES TRIBUTARIOS',
] as const;

const CONTEXT_TERMS = [
  'TRIBUTO',
  'TRIBUTARIO',
  'TRIBUTARIA',
  'IMPOSTO',
  'CONTRIBUICAO',
  'FISCAL',
  'ARRECADACAO',
  'CREDITO',
  'DEBITO',
  'APURACAO',
  'ESCRITURACAO',
  'DECLARACAO',
  'RETENCAO',
  'ALIQUOTA',
  'INCIDENCIA',
  'NAO INCIDENCIA',
  'COMPENSACAO',
  'RESSARCIMENTO',
] as const;

const BUSINESS_TERMS = [
  'EMPRESA',
  'EMPRESAS',
  'CONTRIBUINTE',
  'CONTRIBUINTES',
  'PESSOA JURIDICA',
  'PRODUTOR RURAL',
  'AGRONEGOCIO',
  'IMPORTACAO',
  'EXPORTACAO',
  'OPERACAO',
  'OPERACOES',
] as const;

function containsTerm(text: string, term: string): boolean {
  const padded = ` ${text} `;
  return padded.includes(` ${term} `);
}

export interface RfbNewsRelevance {
  relevant: boolean;
  matchedTerms: string[];
  reason: 'TAX_CATEGORY' | 'STRONG_TERM' | 'TAX_CONTEXT' | 'NO_MATCH';
}

export function classifyRfbNewsRelevance(
  article: RfbNewsArticle,
): RfbNewsRelevance {
  const category = normalize(article.category ?? '');
  const tags = normalize(article.tags.join(' '));
  const titleAndSummary = normalize(
    [article.title, article.summary ?? '', tags].join(' '),
  );
  const full = normalize(
    [
      article.title,
      article.summary ?? '',
      article.content ?? '',
      article.category ?? '',
      article.tags.join(' '),
    ].join(' '),
  );

  if (
    category.includes('TRIBUTAC') ||
    containsTerm(tags, 'RTC')
  ) {
    return {
      relevant: true,
      matchedTerms: category.includes('TRIBUTAC') ? ['TRIBUTACAO'] : ['RTC'],
      reason: 'TAX_CATEGORY',
    };
  }

  const strongMatches = STRONG_TERMS.filter((term) =>
    containsTerm(titleAndSummary, term) || containsTerm(full, term),
  );
  if (strongMatches.length > 0) {
    return {
      relevant: true,
      matchedTerms: [...strongMatches],
      reason: 'STRONG_TERM',
    };
  }

  const contextMatches = CONTEXT_TERMS.filter((term) =>
    containsTerm(full, term),
  );
  const businessMatches = BUSINESS_TERMS.filter((term) =>
    containsTerm(full, term),
  );

  if (contextMatches.length >= 2 && businessMatches.length >= 1) {
    return {
      relevant: true,
      matchedTerms: [...contextMatches, ...businessMatches],
      reason: 'TAX_CONTEXT',
    };
  }

  return {
    relevant: false,
    matchedTerms: [],
    reason: 'NO_MATCH',
  };
}
