import { z } from 'zod';

export const NCM_SOURCE_URL =
  'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json';

const ncmRowSchema = z.object({
  Codigo: z.string().trim().min(1),
  Descricao: z.string().trim().min(1),
  Data_Inicio: z.string().trim().min(1).optional(),
  Data_Fim: z.string().trim().min(1).optional(),
  Tipo_Ato_Ini: z.string().trim().min(1).optional(),
  Numero_Ato_Ini: z.string().trim().min(1).optional(),
  Ano_Ato_Ini: z.string().trim().min(1).optional(),
}).passthrough();

const ncmPayloadSchema = z.object({
  Data_Ultima_Atualizacao_NCM: z.string().trim().min(1),
  Ato: z.unknown().optional(),
  Nomenclaturas: z.array(ncmRowSchema).min(1),
}).passthrough();

export interface NormalizedNcmCatalogEntry {
  officialCode: string;
  digits: string;
  description: string;
  assignable: boolean;
  validFrom: string | null;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface ParsedNcmCatalog {
  sourceUpdatedOn: string;
  sourceUpdatedOnIso: string;
  act: unknown;
  entries: NormalizedNcmCatalogEntry[];
  assignableCount: number;
}

export function normalizeNcmDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function isAssignableNcmCode(value: string): boolean {
  return normalizeNcmDigits(value).length === 8;
}

function parseBrazilianDate(value: string, label: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) {
    throw new Error(`NCM_SOURCE_INVALID_DATE:${label}:${value}`);
  }

  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`NCM_SOURCE_INVALID_DATE:${label}:${value}`);
  }

  return iso;
}

function optionalDate(value: string | undefined, label: string): string | null {
  return value ? parseBrazilianDate(value, label) : null;
}

export function parseNcmCatalogPayload(input: unknown): ParsedNcmCatalog {
  const payload = ncmPayloadSchema.parse(input);
  const seen = new Set<string>();

  const entries = payload.Nomenclaturas.map((row, index) => {
    const officialCode = row.Codigo.trim();
    if (seen.has(officialCode)) {
      throw new Error(`NCM_SOURCE_DUPLICATE_CODE:${officialCode}`);
    }
    seen.add(officialCode);

    const digits = normalizeNcmDigits(officialCode);
    if (!digits) {
      throw new Error(`NCM_SOURCE_INVALID_CODE:${officialCode}`);
    }

    const metadata: Record<string, unknown> = {
      normalizedDigits: digits,
      assignable: digits.length === 8,
    };

    if (row.Data_Inicio) metadata.sourceValidFrom = row.Data_Inicio;
    if (row.Data_Fim) metadata.sourceValidTo = row.Data_Fim;
    if (row.Tipo_Ato_Ini) metadata.sourceActType = row.Tipo_Ato_Ini;
    if (row.Numero_Ato_Ini) metadata.sourceActNumber = row.Numero_Ato_Ini;
    if (row.Ano_Ato_Ini) metadata.sourceActYear = row.Ano_Ato_Ini;

    const extra = Object.fromEntries(
      Object.entries(row).filter(([key]) => ![
        'Codigo',
        'Descricao',
        'Data_Inicio',
        'Data_Fim',
        'Tipo_Ato_Ini',
        'Numero_Ato_Ini',
        'Ano_Ato_Ini',
      ].includes(key)),
    );
    if (Object.keys(extra).length > 0) metadata.sourceExtra = extra;

    return {
      officialCode,
      digits,
      description: row.Descricao.trim(),
      assignable: digits.length === 8,
      validFrom: optionalDate(row.Data_Inicio, `Nomenclaturas[${index}].Data_Inicio`),
      validTo: optionalDate(row.Data_Fim, `Nomenclaturas[${index}].Data_Fim`),
      metadata,
    } satisfies NormalizedNcmCatalogEntry;
  });

  return {
    sourceUpdatedOn: payload.Data_Ultima_Atualizacao_NCM,
    sourceUpdatedOnIso: parseBrazilianDate(
      payload.Data_Ultima_Atualizacao_NCM,
      'Data_Ultima_Atualizacao_NCM',
    ),
    act: payload.Ato ?? null,
    entries,
    assignableCount: entries.filter((entry) => entry.assignable).length,
  };
}
