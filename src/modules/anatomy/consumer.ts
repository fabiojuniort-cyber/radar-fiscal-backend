import { validateAnatomyResult } from './contract.js';

/** Contract-only consumer. It never calls the production classification or NCM detector. */
export function simulateTaxonomyConsumer(input: unknown) {
  const result = validateAnatomyResult(input);
  const entities = new Map(result.entities.map(entity => [entity.id, entity]));
  return {
    contractVersion: result.contractVersion,
    analysisId: result.analysisId,
    outputHash: result.outputHash,
    status: result.status,
    // Keep separate blocks: concatenating them could invent lexical adjacency.
    thematicBlocks: result.eligibility.filter(selection => selection.eligible && selection.purpose === 'thematic_text')
      .map(selection => ({ selectionId: selection.id, partId: selection.partId, span: selection.span,
        text: result.canonicalText.slice(selection.span.start, selection.span.end),
        evidenceIds: [...selection.evidenceIds] })),
    // Codes come only from explicitly approved occurrence selections, never from thematic text.
    ncmOccurrences: result.eligibility.filter(selection => selection.eligible && selection.purpose === 'ncm')
      .map(selection => {
        const entity = entities.get(selection.entityId!)!; // Full contract validation established the reference.
        return { selectionId: selection.id, entityId: entity.id, partId: selection.partId,
          span: entity.span, literal: entity.literal, code: entity.normalized,
          catalogEdition: entity.validation.catalogEdition, evidenceIds: [...selection.evidenceIds] };
      }),
    excluded: result.eligibility.filter(selection => !selection.eligible)
      .map(selection => ({ selectionId: selection.id, partId: selection.partId, entityId: selection.entityId,
        purpose: selection.purpose, reasons: [...selection.exclusionReasons] })),
    limitations: result.limitations.map(limitation => ({ ...limitation })),
    missingResources: [...result.coverage.missingResources],
  };
}
