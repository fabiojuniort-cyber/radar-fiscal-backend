/**
 * T06 — SEF/MG Cadastro Resumido do ICMS (arquivo semanal).
 *
 * Fonte: https://www.fazenda.mg.gov.br/empresas/sistemas/sintegra/cadastro_simplificado.html
 * Campos: Inscrição Estadual; CNPJ; Nome; Situação (H/N); CNAE
 *
 * Disponibilidade pública NÃO implica licença de redistribuição/uso comercial
 * para SaaS: integração MG fica desligada até aprovação da reutilização.
 * Este módulo só processa arquivo local fornecido por operador autorizado;
 * não captura sites, não contorna CAPTCHA e não afirma situação em tempo real.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const MAX_BYTES = 250 * 1024 * 1024;
const MAX_AGE_DAYS = 10;
const OFFICIAL_URL =
  'https://www.fazenda.mg.gov.br/empresas/sistemas/sintegra/cadastro_simplificado.html';

export type MgWeeklyEntry = Readonly<{
  cnpj: string;
  registration: string;
  legalName: string;
  registrationStatus: 'HABILITADO' | 'NAO_HABILITADO';
  cnae: string;
}>;

export type MgWeeklySnapshot = Readonly<{
  source: typeof OFFICIAL_URL;
  checkedAt: string;
  fileSha256: string;
  entries: ReadonlyMap<string, readonly MgWeeklyEntry[]>;
}>;

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function semicolonCsvRecords(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (!field.trim()) quoted = true;
      else throw new Error('MG_CSV_MALFORMED_QUOTE');
      continue;
    }
    if (!quoted && (c === ';' || c === '\r' || c === '\n')) {
      if (c === ';') { row.push(field.trim()); field = ''; }
      else {
        if (c === '\r' && input[i + 1] === '\n') i++;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; field = '';
      }
    } else { field += c; }
  }
  if (quoted) throw new Error('MG_CSV_UNCLOSED_QUOTE');
  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

/** Strict parser: rejects incomplete files instead of inventing IE. */
export function parseMgWeeklyCadastro(
  text: string,
  checkedAt: string,
): MgWeeklySnapshot {
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('MG_FILE_DATE_INVALID');
  const data = text.replace(/^\uFEFF/, '');
  const rows = semicolonCsvRecords(data);
  const entries = new Map<string, MgWeeklyEntry[]>();
  if (rows.length < 2) throw new Error('MG_FILE_EMPTY_OR_TRUNCATED');
  for (const [index, row] of rows.entries()) {
    if (row.length !== 5) throw new Error('MG_CSV_COLUMN_COUNT_LINE_' + (index + 1));
    const [ie, rawCnpj, name, status, cnae] = row as [string, string, string, string, string];
    if (index === 0 && /^INSCRI[CÇ][AÃ]O ESTADUAL|^IE$/i.test(ie)) continue;
    const cnpj = digits(rawCnpj);
    const registration = digits(ie);
    const flag = status.trim().toUpperCase();
    if (cnpj.length !== 14 || registration.length < 8 || registration.length > 14 ||
        !name || !/^(?:H|N)$/.test(flag)) {
      throw new Error('MG_CSV_VALUE_INVALID_LINE_' + (index + 1));
    }
    const entry: MgWeeklyEntry = {
      cnpj, registration, legalName: name,
      registrationStatus: flag === 'H' ? 'HABILITADO' : 'NAO_HABILITADO',
      cnae: cnae.trim(),
    };
    const list = entries.get(cnpj) ?? [];
    if (!list.some(x => x.registration === registration)) list.push(entry);
    else if (list.some(x => x.registration === registration &&
            x.registrationStatus !== entry.registrationStatus)) {
      throw new Error('MG_FILE_CONFLICTING_REGISTRATION_' + cnpj);
    }
    entries.set(cnpj, list);
  }
  if (entries.size === 0) throw new Error('MG_FILE_NO_CONTRIBUTORS');
  return {
    source: OFFICIAL_URL, checkedAt,
    fileSha256: createHash('sha256').update(data).digest('hex'),
    entries,
  };
}

export function lookupMgWeeklyCadastro(
  snapshot: MgWeeklySnapshot,
  cnpj: string,
  now = new Date(),
): {
  registration: string | null;
  registrationStatus: string | null;
  lookupStatus: 'SUCCESS' | 'NOT_FOUND' | 'UNAVAILABLE';
  source: string;
  checkedAt: string;
} {
  const ageDays = (now.getTime() - Date.parse(snapshot.checkedAt)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_AGE_DAYS) {
    return { registration: null, registrationStatus: null,
      lookupStatus: 'UNAVAILABLE', source: 'SEF_MG_WEEKLY_CADASTRO',
      checkedAt: now.toISOString() };
  }
  const matches = snapshot.entries.get(digits(cnpj)) ?? [];
  if (matches.length !== 1) {
    // Multiple IEs and omitted producers make both absence and ambiguity unsafe
    // to interpret as definitive NOT_FOUND.
    return { registration: null, registrationStatus: null,
      lookupStatus: matches.length ? 'UNAVAILABLE' : 'NOT_FOUND',
      source: 'SEF_MG_WEEKLY_CADASTRO', checkedAt: snapshot.checkedAt };
  }
  return { registration: matches[0]!.registration,
    registrationStatus: matches[0]!.registrationStatus,
    lookupStatus: 'SUCCESS',
    source: 'SEF_MG_WEEKLY_CADASTRO', checkedAt: snapshot.checkedAt };
}

/** Loads operator-supplied local snapshot, never downloads without rights review. */
export async function readAuthorizedMgWeeklyCadastro(
  filePath: string,
  checkedAt: string,
): Promise<MgWeeklySnapshot> {
  if (process.env.T06_MG_WEEKLY_REUSE_APPROVED !== 'true') {
    throw new Error('MG_WEEKLY_REUSE_NOT_APPROVED');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES ||
      stat.size < 50) throw new Error('MG_WEEKLY_FILE_UNSAFE');
  const bytes = await readFile(filePath);
  // SEF/MG weekly TXT can be LATIN-1; callers must supply the intended encoding.
  const text = new TextDecoder('windows-1252', { fatal: true }).decode(bytes);
  return parseMgWeeklyCadastro(text, checkedAt);
}
