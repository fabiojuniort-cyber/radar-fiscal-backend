import type { PoolClient } from 'pg';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import { createConcept, createGroup, saveDimensionRows, updateDimension, updateGroup, type CuratorActor, type GridRowInput } from './curation.draft.js';
import { loadReleaseView, pgRunner, type ConceptView, type ReleaseView } from './curation.read.js';
import type { SegmentPackage } from './curation.segment-package.js';

export const segmentCode = (id: string): string => `sector.trifaros_${id.toLowerCase().replace(/-/g, '_')}`;

export function exactCnaes(view: ReleaseView): Map<string, ConceptView> {
  const result = new Map<string, ConceptView>();
  for (const concept of view.concepts.filter(c => c.dimensionCode === 'sector' && c.membershipStatus === 'INCLUDED')) {
    for (const cnae of concept.officialCodes.filter(code => /^\d{7}$/.test(code))) {
      if (result.has(cnae) || concept.officialCodes.length !== 1) throw new Error(`Ambiguous CNAE: ${cnae}`);
      result.set(cnae, concept);
    }
  }
  return result;
}

export function verifySegmentPackage(view: ReleaseView, data: SegmentPackage): void {
  const final = exactCnaes(view);
  const subs = new Map(data.subsegments.map(sub => [sub.id, sub]));
  for (const row of data.rows) {
    const concept = final.get(row.cnae);
    const group = view.groups.find(g => g.id === concept?.groupId);
    const aliases = new Set(concept?.aliases.map(a => normalizeAliasText(a.text)));
    if (!concept || !group || concept.label !== row.description || concept.officialCodes[0] !== row.cnae ||
      group?.label !== subs.get(row.subsegmentId)?.name || group.segmentCodes.length !== 1 ||
      group.segmentCodes[0] !== segmentCode(row.segmentId) || aliases.size !== row.synonyms.length ||
      row.synonyms.some(term => !aliases.has(normalizeAliasText(term))) ||
      concept.aliases.some(a => a.aliasType !== 'EXACT_LEXICAL') || !concept.classifyByLabel) {
      throw new Error(`Read-back mismatch: CNAE ${row.cnae}`);
    }
  }
  for (const segment of data.segments) {
    const concept = view.concepts.find(c => c.code === segmentCode(segment.id));
    if (!concept || concept.label !== segment.name || concept.membershipStatus !== 'INCLUDED' ||
      concept.officialCodes.length || concept.classifyByLabel) throw new Error(`Read-back mismatch: segment ${segment.id}`);
  }
}

/** Caller owns the single curator transaction; no publication, retirement or settings writes. */
export async function loadSegmentPackage(client: PoolClient, actor: CuratorActor, initial: ReleaseView, data: SegmentPackage) {
  if (initial.release.status !== 'DRAFT') throw new Error('DRAFT required');
  const dimension = initial.dimensions.find(d => d.code === 'sector');
  if (dimension?.officialCodeType !== 'CNAE') throw new Error('CNAE dimension required');
  const byCnae = exactCnaes(initial);
  for (const segment of data.segments) {
    const code = segmentCode(segment.id);
    const existing = initial.concepts.find(c => c.code === code);
    if (existing && (existing.label !== segment.name || existing.membershipStatus !== 'INCLUDED' || existing.classifyByLabel || existing.officialCodes.length)) {
      throw new Error(`Segment conflict: ${segment.id}`);
    }
    if (!existing) await createConcept(client, actor, 'sector', {
      code, label: segment.name, definition: segment.definition, profileVisible: true,
      classifyByLabel: false, officialCodes: [], aliases: [],
      helpText: `Segmento padronizado da planilha ${data.sourceWorkbook}.`,
    });
  }
  if (!dimension.usesGroups) await updateDimension(client, actor, 'sector', { usesGroups: true });
  for (const [index, sub] of data.subsegments.entries()) {
    const existing = initial.groups.find(g => g.dimensionCode === 'sector' && normalizeAliasText(g.label) === normalizeAliasText(sub.name));
    const segmentCodes = [segmentCode(sub.segmentId)];
    if (!existing) await createGroup(client, actor, 'sector', { label: sub.name, segmentCodes, displayOrder: index + 1 });
    else if (JSON.stringify(existing.segmentCodes) !== JSON.stringify(segmentCodes)) {
      if (existing.segmentCodes.length) throw new Error(`Subsegment conflict: ${sub.id}`);
      await updateGroup(client, actor, existing.id, { segmentCodes });
    }
  }
  const subNames = new Map(data.subsegments.map(sub => [sub.id, sub.name]));
  let created = 0, updated = 0;
  for (let start = 0; start < data.rows.length; start += 40) {
    const rows: GridRowInput[] = data.rows.slice(start, start + 40).map((row, index) => ({
      code: byCnae.get(row.cnae)?.code ?? null,
      group: subNames.get(row.subsegmentId)!, label: row.description, officialCodes: [row.cnae],
      aliases: row.synonyms.map(text => ({ text, aliasType: 'EXACT_LEXICAL' })),
      profileVisible: byCnae.get(row.cnae)?.profileVisible ?? true, classifyByLabel: true,
      displayOrder: start + index + 1,
    }));
    const result = await saveDimensionRows(client, actor, 'sector', { rows, retire: [] });
    created += result.created.length;
    updated += result.updated;
    if (start % 200 === 0) console.log(`SEGMENT_LOAD_PROGRESS=${Math.min(start + 40, data.rows.length)}/${data.rows.length}`);
  }
  const final = await loadReleaseView(pgRunner(client), initial.release.id, { includeRetired: true });
  if (!final) throw new Error('DRAFT disappeared');
  verifySegmentPackage(final, data);
  return { created, updated, cnaes: data.rows.length, segments: data.segments.length,
    subsegments: data.subsegments.length, synonyms: data.rows.reduce((sum, row) => sum + row.synonyms.length, 0) };
}
