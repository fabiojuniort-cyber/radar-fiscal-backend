/**
 * TAX-11 presentation defaults. They describe how releases created before
 * curated settings existed (v1.0.0, v1.1.0) are presented, and seed the
 * first curated DRAFT. Curated releases store explicit values instead.
 */

/**
 * Sources that are never classified, whatever the runtime setting says: the
 * DOE-SP rebuild guard refuses classification history attached to its
 * publications until the DOE-SP front is formally closed.
 */
export const PROTECTED_EXCLUDED_SOURCES = ['doe-sp'] as const;

export const OFFICIAL_CODE_TYPES = [
  'NCM',
  'CNAE',
  'CFOP',
  'NBS',
  'LC116',
  'DOCUMENT_MODEL',
  'CCLASSTRIB',
] as const;

export type OfficialCodeType = (typeof OFFICIAL_CODE_TYPES)[number];

/** Profile dimensions shown before TAX-11, in the curated default order. */
export const LEGACY_PROFILE_DIMENSIONS = [
  'sector',
  'product',
  'tax',
  'regime',
  'operation',
  'operation_purpose',
  'document',
  'obligation',
] as const;

export const DEFAULT_DETAIL_SECTIONS: Record<string, string> = {
  tax: 'Tributos',
  tax_species: 'Tributos',
  treatment: 'Benefícios e tratamentos',
  theme: 'Temas',
  operation: 'Operações',
  operation_purpose: 'Operações',
  product: 'Produtos',
  sector: 'Segmentos',
  document: 'Documentos e obrigações',
  obligation: 'Documentos e obrigações',
  platform: 'Documentos e obrigações',
  regime: 'Regimes',
};

/** Order of the sections at the end of a legislation page. */
export const DEFAULT_SECTION_ORDER = [
  'Tributos',
  'Benefícios e tratamentos',
  'Operações',
  'Produtos',
  'Segmentos',
  'Documentos e obrigações',
  'Regimes',
  'Temas',
] as const;

export const DEFAULT_OFFICIAL_CODE_TYPES: Record<string, OfficialCodeType> = {
  product: 'NCM',
  sector: 'CNAE',
  document: 'DOCUMENT_MODEL',
  treatment: 'CCLASSTRIB',
};

export const DEFAULT_PROFILE_HELP: Record<string, string> = {
  sector: 'Segmentos em que a empresa atua.',
  product: 'Produtos que a empresa compra, vende ou fabrica.',
  tax: 'Tributos que a empresa apura ou recolhe.',
  regime: 'Regimes de apuração e regimes especiais da empresa.',
  operation: 'Operações que a empresa realiza.',
  operation_purpose: 'Finalidades das mercadorias que a empresa movimenta.',
  document: 'Documentos fiscais que a empresa emite ou recebe.',
  obligation: 'Obrigações acessórias que a empresa entrega.',
};

/**
 * Labels too generic to tag a legislation by themselves. The first curated
 * draft turns "classificar pelo nome" off for them; synonyms and official
 * codes keep working. The curator can turn any of them back on.
 */
export const GENERIC_LABEL_CODES = new Set<string>([
  'act_type.law',
  'act_type.decree',
  'act_type.ordinance',
  'act_type.resolution',
  'tax_species.tax',
  'tax_species.fee',
  'sphere.federal',
  'sphere.state',
  'sphere.municipal',
  'sphere.district',
  'theme.additional_rate',
  'theme.assessment',
  'theme.fine',
  'theme.penalty',
  'theme.payment',
  'theme.withholding',
  'theme.tax_suspension',
  'theme.audit',
  'theme.offset',
  'theme.tax_incidence',
  'theme.tax_rate',
  'theme.anticipation',
  'theme.refund',
  'theme.reimbursement',
  'operation.advertising_service',
  'operation.delivery',
  'operation.devolution',
  'operation.donation',
  'operation.shipment',
  'operation.return',
  'operation.transfer',
  'operation.sale',
  'operation.assembly',
  'operation.installation',
  'operation.maintenance',
  'operation.extraction',
  'operation.exchange',
  'operation.distribution',
  'subject.taxpayer',
  'subject.supplier',
  'subject.recipient',
  'subject.sender',
  'subject.service_customer',
  'subject.service_provider',
  'subject.buyer',
  'subject.carrier',
  'subject.intermediary',
  'subject.natural_person',
  'subject.legal_entity',
  'subject.exporter',
  'subject.importer',
  'sector.energy',
  'sector.manufacturing',
  'sector.retail',
  'sector.wholesale',
  'sector.health',
  'sector.education',
  'sector.banking',
  'sector.export_trade',
  'sector.import_trade',
  'product.machines',
  'product.vehicles',
  'product.packaging',
  'product.salt',
  'product.paper',
  'product.glass',
  'product.steel',
  'product.sand',
  'product.timber',
  'product.fruit',
  'product.eggs',
  'product.milk',
  'product.wool',
  'product.gold',
  'product.silver',
  'product.copper',
]);

export function normalizeOfficialCode(raw: string): string {
  return raw.trim().replace(/[\s.\-/]/g, '').toUpperCase();
}

const CODE_SHAPES: Record<OfficialCodeType, RegExp> = {
  NCM: /^\d{2}(\d{2}(\d{2}(\d{2})?)?)?$/,
  CNAE: /^(\d{2,7})$/,
  CFOP: /^\d{4}$/,
  NBS: /^\d{1,9}$/,
  LC116: /^\d{1,4}$/,
  DOCUMENT_MODEL: /^\d{2}$/,
  CCLASSTRIB: /^\d{3}(\d{3})?$/,
};

export function isValidOfficialCode(
  type: OfficialCodeType | null,
  code: string,
): boolean {
  if (!code) return false;
  if (!type) return /^[0-9A-Z]{1,20}$/.test(code);
  return CODE_SHAPES[type].test(code);
}

export function formatOfficialCode(
  type: OfficialCodeType | null,
  code: string,
): string {
  if (type === 'NCM') {
    if (code.length <= 4) return code;
    if (code.length === 6) return `${code.slice(0, 4)}.${code.slice(4)}`;
    return `${code.slice(0, 4)}.${code.slice(4, 6)}.${code.slice(6)}`;
  }
  if (type === 'CNAE') {
    if (code.length <= 2) return code;
    if (code.length === 3) return `${code.slice(0, 2)}.${code.slice(2)}`;
    if (code.length === 4) return `${code.slice(0, 2)}.${code.slice(2)}`;
    if (code.length === 5) return `${code.slice(0, 2)}.${code.slice(2, 4)}-${code.slice(4)}`;
    return `${code.slice(0, 4)}-${code.slice(4, 5)}/${code.slice(5)}`;
  }
  return code;
}
