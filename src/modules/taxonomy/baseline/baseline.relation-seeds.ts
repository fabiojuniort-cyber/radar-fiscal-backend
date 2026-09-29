import {
  compareCanonicalText,
} from './baseline.canonical-json.js';
import type {
  BaselineRelation,
  RelationTypeSeed,
} from './baseline.types.js';

export const RELATION_TYPE_SEEDS: readonly RelationTypeSeed[] = [
  { code: 'narrower_than', inverseCode: 'broader_than', directed: true, acyclic: true, hierarchical: true, canonicalStorageCode: 'narrower_than' },
  { code: 'broader_than', inverseCode: 'narrower_than', directed: true, acyclic: true, hierarchical: true, canonicalStorageCode: 'narrower_than' },
  { code: 'part_of', inverseCode: null, directed: true, acyclic: true, hierarchical: false, canonicalStorageCode: 'part_of' },
  { code: 'related_to', inverseCode: null, directed: false, acyclic: false, hierarchical: false, canonicalStorageCode: 'related_to' },
  { code: 'replaced_by', inverseCode: 'supersedes', directed: true, acyclic: true, hierarchical: false, canonicalStorageCode: 'replaced_by' },
  { code: 'supersedes', inverseCode: 'replaced_by', directed: true, acyclic: true, hierarchical: false, canonicalStorageCode: 'replaced_by' },
  { code: 'applies_to', inverseCode: null, directed: true, acyclic: false, hierarchical: false, canonicalStorageCode: 'applies_to' },
] as const;

export type RelationDeclarationType =
  | 'narrower_than'
  | 'broader_than'
  | 'part_of'
  | 'related_to'
  | 'replaced_by'
  | 'supersedes'
  | 'applies_to'
  | 'about'
  | 'hosted_by'
  | 'fulfills';

interface RelationDeclaration {
  source: string;
  type: RelationDeclarationType;
  target: string;
  sourceLocator: string;
}

function declaration(
  source: string,
  type: RelationDeclarationType,
  target: string,
  sourceLocator: string,
): RelationDeclaration {
  return { source, type, target, sourceLocator };
}

const DECLARATIONS: readonly RelationDeclaration[] = [
  declaration('theme.fine', 'narrower_than', 'theme.penalty', 'R6 §15'),
  declaration('operation.resale', 'narrower_than', 'operation.sale', 'R6 §15'),
  declaration('subject.tax_substitute', 'narrower_than', 'subject.tax_responsible', 'R6 §15'),
  declaration('product.beef', 'narrower_than', 'product.meat', 'R6 §15'),
  declaration('product.poultry_meat', 'narrower_than', 'product.meat', 'R6 §15'),
  declaration('product.pork', 'narrower_than', 'product.meat', 'R6 §15'),
  declaration('product.diesel', 'narrower_than', 'product.fuels', 'R6 §15'),
  declaration('product.gasoline', 'narrower_than', 'product.fuels', 'R6 §15'),
  declaration('tax.cide_fuels', 'narrower_than', 'tax.cide', 'R6 §15'),
  declaration('event.repeals_partially', 'narrower_than', 'event.revokes', 'R6 §15'),
  declaration('operation.transport_service', 'narrower_than', 'operation.service_provision', 'R6 §15'),
  declaration('tax.payroll_employer_contribution', 'narrower_than', 'tax.social_security_contribution', 'R6 §15'),
  declaration('tax.rat', 'narrower_than', 'tax.social_security_contribution', 'R6 §15'),
  declaration('tax.cprb', 'narrower_than', 'tax.social_security_contribution', 'R6 §15'),
  declaration('tax.rural_commercialization_contribution', 'narrower_than', 'tax.social_security_contribution', 'R6 §15'),
  declaration('tax.cide_royalties', 'narrower_than', 'tax.cide', 'R6 §15'),
  declaration('regime.simei', 'narrower_than', 'regime.simples_nacional', 'R6 §15'),
  declaration('subject.successor', 'narrower_than', 'subject.tax_responsible', 'R6 §15'),
  declaration('product.aviation_gasoline', 'narrower_than', 'product.gasoline', 'R6 §15'),
  declaration('product.lithium_batteries', 'narrower_than', 'product.batteries', 'R6 §15'),

  declaration('sector.meatpacking', 'related_to', 'sector.slaughterhouse', 'R6 §15'),
  declaration('sector.meatpacking', 'related_to', 'sector.meat_products', 'R6 §15'),
  declaration('sector.meatpacking', 'related_to', 'sector.cold_storage', 'R6 §15'),
  declaration('sector.meatpacking', 'related_to', 'sector.meat_distribution', 'R6 §15'),
  declaration('sector.rural_production', 'related_to', 'subject.rural_producer', 'R6 §15'),
  declaration('theme.tax_deferral', 'about', 'treatment.tax_deferral', 'R6 §15'),
  declaration('document.nfe', 'related_to', 'impact_system.nfe_integration', 'R6 §15'),
  declaration('obligation.efd_icms_ipi', 'hosted_by', 'platform.sped', 'R6 §15'),
  declaration('document.dere', 'fulfills', 'obligation.dere', 'R6 §15'),

  declaration('operation.loan_of_fungibles', 'related_to', 'operation.loan_granting', 'R6 §24.8'),
  declaration('operation.customs_transit', 'related_to', 'regime.customs_transit', 'R6 §24.8'),
];

function related(
  declarationValue: RelationDeclaration,
  semanticHint?: string,
): BaselineRelation {
  let source = declarationValue.source;
  let target = declarationValue.target;

  if (compareCanonicalText(source, target) > 0) {
    [source, target] = [target, source];
  }

  return {
    sourceConceptCode: source,
    relationType: 'related_to',
    targetConceptCode: target,
    qualifiers: semanticHint ? { semanticHint } : {},
    status: 'PROPOSED',
    evidenceStatus: 'NOT_ASSESSED',
    sourceLocator: declarationValue.sourceLocator,
  };
}

export function normalizeRelationDeclaration(
  source: string,
  type: RelationDeclarationType,
  target: string,
  sourceLocator = 'test',
): BaselineRelation {
  const item: RelationDeclaration = {
    source,
    type,
    target,
    sourceLocator,
  };

  if (item.type === 'broader_than') {
    return {
      sourceConceptCode: item.target,
      relationType: 'narrower_than',
      targetConceptCode: item.source,
      qualifiers: {},
      status: 'PROPOSED',
      evidenceStatus: 'NOT_ASSESSED',
      sourceLocator: item.sourceLocator,
    };
  }

  if (item.type === 'supersedes') {
    return {
      sourceConceptCode: item.target,
      relationType: 'replaced_by',
      targetConceptCode: item.source,
      qualifiers: {},
      status: 'PROPOSED',
      evidenceStatus: 'NOT_ASSESSED',
      sourceLocator: item.sourceLocator,
    };
  }

  if (
    item.type === 'about' ||
    item.type === 'hosted_by' ||
    item.type === 'fulfills'
  ) {
    return related(item, item.type);
  }

  if (item.type === 'related_to') {
    return related(item);
  }

  return {
    sourceConceptCode: item.source,
    relationType: item.type,
    targetConceptCode: item.target,
    qualifiers: {},
    status: 'PROPOSED',
    evidenceStatus: 'NOT_ASSESSED',
    sourceLocator: item.sourceLocator,
  };
}

export function buildBaselineRelations(): BaselineRelation[] {
  const relations = DECLARATIONS.map((item) =>
    normalizeRelationDeclaration(
      item.source,
      item.type,
      item.target,
      item.sourceLocator,
    ),
  );

  return relations.sort((left, right) =>
    compareCanonicalText(
      [
        left.relationType,
        left.sourceConceptCode,
        left.targetConceptCode,
        JSON.stringify(left.qualifiers),
      ].join('|'),
      [
        right.relationType,
        right.sourceConceptCode,
        right.targetConceptCode,
        JSON.stringify(right.qualifiers),
      ].join('|'),
    ),
  );

}
