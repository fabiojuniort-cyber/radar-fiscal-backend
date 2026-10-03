import type { PoolClient } from 'pg';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import {
  importDimensionRows,
  updateGroup,
  type CuratorActor,
  type ImportReport,
  type ImportRow,
} from './curation.draft.js';
import { findOpenDraft, loadReleaseView, pgRunner } from './curation.read.js';

/**
 * Bulk load of a product classification sheet (Segmento;Grupo;Item) into
 * the open DRAFT's product table, the sheet being the most recent truth:
 *
 * - an item that already exists (same name ignoring case, accents and
 *   singular/plural, or one of its synonyms) is updated: it takes the
 *   sheet's name and group, and its previous name stays as a synonym;
 * - any other item is created in the sheet's group (created if missing);
 * - the sheet's groups are linked to the sheet's segment;
 * - a repeated item inside the sheet: the last line wins.
 */

const DIMENSION = 'product';

export interface ProductSheetRow {
  line: number;
  segment: string;
  group: string;
  item: string;
}

export function parseProductSheet(text: string): ProductSheetRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(';').map((cell) => normalizeAliasText(cell));
  const [segment, group, item] = ['segmento', 'grupo', 'item'].map((name) => header.indexOf(name));
  if (segment === undefined || group === undefined || item === undefined || segment < 0 || group < 0 || item < 0) {
    throw new Error('A planilha precisa das colunas Segmento;Grupo;Item');
  }
  return lines.slice(1).flatMap((raw, index) => {
    const cells = raw.split(';').map((cell) => cell.trim());
    const label = cells[item];
    if (!label) return [];
    return [{ line: index + 2, segment: cells[segment] ?? '', group: cells[group] ?? '', item: label }];
  });
}

/** Comparison key: normalized text with each word in the singular. */
export function productMatchKey(value: string): string {
  return normalizeAliasText(value)
    .split(' ')
    .map((word) => {
      if (word.length <= 3) return word;
      if (word.endsWith('oes') || word.endsWith('aes')) return `${word.slice(0, -3)}ao`;
      if (word.endsWith('ais')) return `${word.slice(0, -3)}al`;
      if (word.endsWith('eis')) return `${word.slice(0, -3)}el`;
      if (/(r|z)es$/.test(word)) return word.slice(0, -2);
      return word.endsWith('s') ? word.slice(0, -1) : word;
    })
    .join(' ');
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export interface ProductLoadSummary {
  draft: string;
  sheetRows: number;
  sheetDuplicates: Array<{ line: number; item: string; replacedByLine: number }>;
  matched: Array<{ line: number; item: string; existing: string; code: string; fromGroup: string | null; toGroup: string }>;
  created: number;
  updated: number;
  groupsCreated: number;
  groupsLinkedToSegment: string[];
  errors: ImportReport['errors'];
  warnings: ImportReport['warnings'];
}

export async function loadProductSheet(
  client: PoolClient,
  actor: CuratorActor,
  sheet: readonly ProductSheetRow[],
): Promise<ProductLoadSummary> {
  const draft = await findOpenDraft(pgRunner(client));
  if (!draft || draft.status !== 'DRAFT') {
    throw new Error('NO_OPEN_DRAFT: crie a próxima versão na Curadoria antes da carga');
  }
  const view = await loadReleaseView(pgRunner(client), draft.id);
  if (!view) throw new Error('DRAFT_NOT_FOUND');

  const products = view.concepts.filter((concept) => concept.dimensionCode === DIMENSION);
  const groupLabel = new Map(view.groups.map((group) => [group.id, group.label]));
  const byKey = new Map<string, (typeof products)[number]>();
  for (const concept of products) byKey.set(productMatchKey(concept.label), concept);
  for (const concept of products) {
    for (const alias of concept.aliases) {
      const key = productMatchKey(alias.text);
      if (!byKey.has(key)) byKey.set(key, concept);
    }
  }

  const lastByKey = new Map<string, ProductSheetRow>();
  const sheetDuplicates: ProductLoadSummary['sheetDuplicates'] = [];
  for (const row of sheet) {
    const key = productMatchKey(row.item);
    const previous = lastByKey.get(key);
    if (previous) sheetDuplicates.push({ line: previous.line, item: previous.item, replacedByLine: row.line });
    lastByKey.set(key, row);
  }
  const rowsToLoad = sheet.filter((row) => lastByKey.get(productMatchKey(row.item)) === row);

  const usedCodes = new Set<string>();
  const matched: ProductLoadSummary['matched'] = [];
  const importRows: ImportRow[] = rowsToLoad.map((row) => {
    const label = capitalize(row.item);
    const base = { line: row.line, group: row.group, item: label, officialCodes: undefined, profileVisible: null, displayOrder: null };
    const existing = byKey.get(productMatchKey(row.item));
    if (!existing || usedCodes.has(existing.code)) {
      return { ...base, synonyms: undefined, code: null };
    }
    usedCodes.add(existing.code);
    matched.push({
      line: row.line,
      item: label,
      existing: existing.label,
      code: existing.code,
      fromGroup: existing.groupId ? (groupLabel.get(existing.groupId) ?? null) : null,
      toGroup: row.group,
    });
    const exact = existing.aliases
      .filter((alias) => alias.aliasType === 'EXACT_LEXICAL')
      .map((alias) => alias.text);
    const oldName = normalizeAliasText(existing.label) !== normalizeAliasText(label) ? [existing.label] : [];
    return { ...base, synonyms: [...exact, ...oldName], code: existing.code };
  });

  const report = await importDimensionRows(client, actor, DIMENSION, importRows);

  // Link the sheet's groups to its segment (sector item found by name).
  const after = await loadReleaseView(pgRunner(client), draft.id);
  const sectors = (after?.concepts ?? []).filter((concept) => concept.dimensionCode === 'sector');
  const sectorFor = (segment: string) => {
    const key = productMatchKey(segment);
    return sectors.find(
      (sector) =>
        productMatchKey(sector.label) === key ||
        sector.aliases.some((alias) => productMatchKey(alias.text) === key),
    );
  };
  const groupsLinkedToSegment: string[] = [];
  for (const [groupName, segment] of new Map(rowsToLoad.map((row) => [row.group, row.segment]))) {
    const group = after?.groups.find(
      (candidate) =>
        candidate.dimensionCode === DIMENSION &&
        normalizeAliasText(candidate.label) === normalizeAliasText(groupName),
    );
    const sector = sectorFor(segment);
    if (!group || !sector) {
      report.warnings.push({
        line: 0,
        message: `Grupo “${groupName}”: segmento “${segment}” não encontrado; vincule na tela de curadoria.`,
      });
      continue;
    }
    if (!group.segmentCodes.includes(sector.code)) {
      await updateGroup(client, actor, group.id, { segmentCodes: [...group.segmentCodes, sector.code] });
      groupsLinkedToSegment.push(`${group.label} → ${sector.label}`);
    }
  }

  return {
    draft: draft.version,
    sheetRows: sheet.length,
    sheetDuplicates,
    matched,
    created: report.created,
    updated: report.updated,
    groupsCreated: report.groupsCreated,
    groupsLinkedToSegment,
    errors: report.errors,
    warnings: report.warnings,
  };
}
