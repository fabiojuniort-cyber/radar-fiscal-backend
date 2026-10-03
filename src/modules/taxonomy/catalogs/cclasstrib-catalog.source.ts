import { createHash } from 'node:crypto';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import type {
  CatalogEntryInput,
  CatalogIdentity,
} from './official-catalog.importer.js';

/**
 * cClassTrib (IBS/CBS) catalog from the official table published by the
 * Portal Nacional da NF-e (Informe Técnico 2025.002). The machine API
 * (Conformidade Fácil / SVRS) requires an ICP-Brasil client certificate,
 * so the curator uploads the official table exported as CSV.
 */
export const CCLASSTRIB_CATALOG: CatalogIdentity = {
  code: 'CCLASSTRIB',
  name: 'Classificação Tributária do IBS e da CBS (CST / cClassTrib)',
  maintainer: 'Portal Nacional da NF-e / RFB / Comitê Gestor do IBS',
  description:
    'Tabela oficial de CST e cClassTrib do IBS/CBS (Informe Técnico 2025.002), carregada pela curadoria a partir do arquivo oficial.',
};

function splitCsvLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Splits CSV text into records, honoring quoted line breaks. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = clean.split('\n', 1)[0] ?? '';
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';

  const records: string[] = [];
  let buffer = '';
  let quotes = 0;
  for (const line of clean.split('\n')) {
    buffer = buffer ? `${buffer}\n${line}` : line;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      if (buffer.trim()) records.push(buffer);
      buffer = '';
      quotes = 0;
    }
  }
  if (buffer.trim()) records.push(buffer);
  return records.map((record) => splitCsvLine(record, separator));
}

function headerIndex(headers: string[], ...candidates: string[]): number {
  const normalized = headers.map((header) => normalizeAliasText(header));
  for (const candidate of candidates) {
    const index = normalized.findIndex(
      (header) => header === candidate || header.includes(candidate),
    );
    if (index >= 0) return index;
  }
  return -1;
}

export interface ParsedCclasstribCatalog {
  sourceSha256: string;
  entries: CatalogEntryInput[];
  cstCount: number;
  classificationCount: number;
}

export function parseCclasstribCsv(text: string): ParsedCclasstribCatalog {
  const rows = parseCsv(text);
  const headerRow = rows.findIndex(
    (row) =>
      headerIndex(row, 'cclasstrib', 'codigo da classificacao tributaria') >= 0,
  );
  if (headerRow < 0) throw new Error('CCLASSTRIB_HEADER_NOT_FOUND');
  const headers = rows[headerRow]!;

  const classIdx = headerIndex(headers, 'cclasstrib', 'codigo da classificacao tributaria');
  const cstIdx = headerIndex(headers, 'cst ibs cbs', 'cst');
  const cstNameIdx = headerIndex(headers, 'descricao cst', 'nome cst', 'descricao do cst');
  const nameIdx = headerIndex(
    headers,
    'nome cclasstrib',
    'descricao cclasstrib',
    'nome',
    'descricao',
  );
  if (cstIdx < 0) throw new Error('CCLASSTRIB_CST_COLUMN_NOT_FOUND');

  const csts = new Map<string, CatalogEntryInput>();
  const classifications = new Map<string, CatalogEntryInput>();

  for (const row of rows.slice(headerRow + 1)) {
    const classCode = (row[classIdx] ?? '').replace(/\D/g, '');
    const cstCode = (row[cstIdx] ?? '').replace(/\D/g, '').padStart(3, '0');
    if (!/^\d{6}$/.test(classCode) || !/^\d{3}$/.test(cstCode)) continue;

    const metadata: Record<string, unknown> = { level: 'CCLASSTRIB' };
    headers.forEach((header, index) => {
      if (header && row[index] !== undefined && row[index] !== '') {
        metadata[header] = row[index];
      }
    });

    if (!csts.has(cstCode)) {
      csts.set(cstCode, {
        officialCode: cstCode,
        description:
          (cstNameIdx >= 0 ? row[cstNameIdx] : '')?.trim() || `CST ${cstCode}`,
        parentCode: null,
        metadata: { level: 'CST' },
      });
    }

    const description =
      (nameIdx >= 0 && nameIdx !== cstNameIdx ? row[nameIdx] : '')?.trim() ||
      `cClassTrib ${classCode}`;
    if (!classifications.has(classCode)) {
      classifications.set(classCode, {
        officialCode: classCode,
        description,
        parentCode: cstCode,
        metadata,
      });
    }
  }

  if (classifications.size === 0) throw new Error('CCLASSTRIB_NO_ROWS');

  return {
    sourceSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    entries: [...csts.values(), ...classifications.values()],
    cstCount: csts.size,
    classificationCount: classifications.size,
  };
}
