import {
  normalizeCollectionFilterType,
  type CollectionFilterMode,
  type CollectionFilterTerm,
} from './collection-filter.engine.js';

const INITIAL_TAX_SOURCES = new Set([
  'confaz',
  'rfb-normas',
  'cgibs',
  'nfe-encat',
  'sped',
]);

const DOU_ALWAYS_KEEP_TYPE_PREFIXES = [
  'SOLUCAO DE CONSULTA',
  'SOLUCAO DE DIVERGENCIA',
  'ATO DECLARATORIO INTERPRETATIVO',
  'CONVENIO ICMS',
  'AJUSTE SINIEF',
  'PROTOCOLO ICMS',
  'ATO COTEPE',
] as const;

export const INITIAL_COLLECTION_FILTER_STRONG_TERMS = [
  'ICMS',
  'ISS',
  'ISSQN',
  'IBS',
  'CBS',
  'PIS',
  'COFINS',
  'IPI',
  'IRPJ',
  'IRPF',
  'IRRF',
  'CSLL',
  'IOF',
  'ITR',
  'SIMPLES NACIONAL',
  'REFORMA TRIBUTARIA',
  'TRIBUTARIO',
  'TRIBUTARIA',
  'TRIBUTARIOS',
  'TRIBUTARIAS',
  'CODIGO TRIBUTARIO',
  'CONTRIBUICAO PREVIDENCIARIA',
  'CONTRIBUICOES PREVIDENCIARIAS',
  'SUBSTITUICAO TRIBUTARIA',
  'CREDITO PRESUMIDO',
  'DIFERIMENTO',
  'ISENCAO',
  'REDUCAO DE BASE',
  'BASE DE CALCULO',
  'ALIQUOTA',
  'FATO GERADOR',
  'OBRIGACAO ACESSORIA',
  'DOCUMENTO FISCAL',
  'ESCRITURACAO FISCAL',
  'BENEFICIO FISCAL',
  'BENEFICIOS FISCAIS',
  'INCENTIVO FISCAL',
  'INCENTIVOS FISCAIS',
  'REIDI',
  'EQBEN',
  'TFAC',
  'CORAT',
  'NF-E',
  'NFS-E',
  'CT-E',
  'MDF-E',
  'EFD',
  'EFD-REINF',
  'DCTFWEB',
  'PER/DCOMP',
  'SPED',
  'NCM',
  'CONVENIO ICMS',
  'AJUSTE SINIEF',
] as const;

export const INITIAL_COLLECTION_FILTER_WEAK_TERMS = [
  'FISCAL',
  'CREDITO',
  'PRODUTOR RURAL',
  'AGRONEGOCIO',
  'FERTILIZANTE',
  'DEFENSIVO',
] as const;

export const INITIAL_COLLECTION_FILTER_NEGATIVE_TERMS = [
  'REGULARIDADE FISCAL',
  'CERTIDAO NEGATIVA',
] as const;

export function initialCollectionFilterMode(
  sourceCode: string,
  canonicalType: string,
): CollectionFilterMode {
  const source = sourceCode.trim().toLowerCase();
  const type = normalizeCollectionFilterType(canonicalType);

  if (INITIAL_TAX_SOURCES.has(source)) return 'KEEP_ALWAYS';
  if (source !== 'dou') return 'KEEP_ALWAYS';

  if (
    DOU_ALWAYS_KEEP_TYPE_PREFIXES.some(
      (prefix) => type === prefix || type.startsWith(`${prefix} `),
    )
  ) {
    return 'KEEP_ALWAYS';
  }

  if (type === 'EXTRATO DE CONTRATO') {
    return 'EXCLUDE_UNLESS_STRONG';
  }

  return 'KEEP_IF_TAX_TERM';
}

export function initialCollectionFilterTerms(): CollectionFilterTerm[] {
  return [
    ...INITIAL_COLLECTION_FILTER_STRONG_TERMS.map((text) => ({
      text,
      strength: 'STRONG' as const,
      locationScope: 'ANY' as const,
    })),
    ...INITIAL_COLLECTION_FILTER_WEAK_TERMS.map((text) => ({
      text,
      strength: 'WEAK' as const,
      locationScope: 'ANY' as const,
    })),
    ...INITIAL_COLLECTION_FILTER_NEGATIVE_TERMS.map((text) => ({
      text,
      strength: 'NEGATIVE' as const,
      locationScope: 'ANY' as const,
    })),
  ];
}
