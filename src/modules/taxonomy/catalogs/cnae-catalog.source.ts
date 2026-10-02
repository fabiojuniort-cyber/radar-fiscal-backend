import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  CatalogEntryInput,
  CatalogIdentity,
} from './official-catalog.importer.js';

export const CNAE_SOURCE_URL =
  'https://servicodados.ibge.gov.br/api/v2/cnae/subclasses';

export const CNAE_CATALOG: CatalogIdentity = {
  code: 'CNAE',
  name: 'Classificação Nacional de Atividades Econômicas (CNAE 2.3)',
  maintainer: 'IBGE / CONCLA',
  description:
    'Hierarquia oficial seção > divisão > grupo > classe > subclasse obtida da API de serviços de dados do IBGE.',
};

const sectionSchema = z.object({ id: z.string(), descricao: z.string() }).passthrough();
const divisionSchema = z
  .object({ id: z.string(), descricao: z.string(), secao: sectionSchema })
  .passthrough();
const groupSchema = z
  .object({ id: z.string(), descricao: z.string(), divisao: divisionSchema })
  .passthrough();
const classSchema = z
  .object({ id: z.string(), descricao: z.string(), grupo: groupSchema })
  .passthrough();
const subclassSchema = z
  .object({ id: z.string(), descricao: z.string(), classe: classSchema })
  .passthrough();

export const cnaePayloadSchema = z.array(subclassSchema).min(1);

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function formatGroup(id: string): string {
  return `${id.slice(0, 2)}.${id.slice(2)}`;
}

function formatClass(id: string): string {
  return `${id.slice(0, 2)}.${id.slice(2, 4)}-${id.slice(4)}`;
}

function formatSubclass(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4, 5)}/${id.slice(5)}`;
}

export function parseCnaePayload(payload: unknown): CatalogEntryInput[] {
  const rows = cnaePayloadSchema.parse(payload);
  const entries = new Map<string, CatalogEntryInput>();
  const put = (entry: CatalogEntryInput) => {
    if (!entries.has(entry.officialCode)) entries.set(entry.officialCode, entry);
  };

  for (const row of rows) {
    const cls = row.classe;
    const group = cls.grupo;
    const division = group.divisao;
    const section = division.secao;

    const subclassId = digits(row.id);
    const classId = digits(cls.id);
    const groupId = digits(group.id);
    const divisionId = digits(division.id);
    if (
      subclassId.length !== 7 ||
      classId.length !== 5 ||
      groupId.length !== 3 ||
      divisionId.length !== 2
    ) {
      throw new Error(`CNAE_SOURCE_INVALID_CODE:${row.id}`);
    }

    put({
      officialCode: section.id.trim().toUpperCase(),
      description: section.descricao.trim(),
      parentCode: null,
      metadata: { level: 'SECAO' },
    });
    put({
      officialCode: divisionId,
      description: division.descricao.trim(),
      parentCode: section.id.trim().toUpperCase(),
      metadata: { level: 'DIVISAO', normalizedDigits: divisionId },
    });
    put({
      officialCode: formatGroup(groupId),
      description: group.descricao.trim(),
      parentCode: divisionId,
      metadata: { level: 'GRUPO', normalizedDigits: groupId },
    });
    put({
      officialCode: formatClass(classId),
      description: cls.descricao.trim(),
      parentCode: formatGroup(groupId),
      metadata: { level: 'CLASSE', normalizedDigits: classId },
    });
    put({
      officialCode: formatSubclass(subclassId),
      description: row.descricao.trim(),
      parentCode: formatClass(classId),
      metadata: {
        level: 'SUBCLASSE',
        normalizedDigits: subclassId,
        assignable: true,
      },
    });
  }

  return [...entries.values()];
}

export async function downloadCnaeCatalog(): Promise<{
  sourceSha256: string;
  entries: CatalogEntryInput[];
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(CNAE_SOURCE_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'TriBusca-Radar-Fiscal/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CNAE_SOURCE_HTTP_${response.status}`);
    const raw = await response.text();
    if (raw.length > 16 * 1024 * 1024) throw new Error('CNAE_SOURCE_TOO_LARGE');
    return {
      sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      entries: parseCnaePayload(JSON.parse(raw) as unknown),
    };
  } finally {
    clearTimeout(timeout);
  }
}
