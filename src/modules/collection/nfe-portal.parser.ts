import { Parser } from 'htmlparser2';

export type NfePortalDocumentFamily =
  | 'NOTE_TECHNICAL'
  | 'TECHNICAL_REPORT'
  | 'XML_SCHEMA'
  | 'MANUAL'
  | 'MISC_TECHNICAL';

export type NfePortalDocumentStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'UNKNOWN';

export interface NfePortalListDefinition {
  family: NfePortalDocumentFamily;
  url: string;
  label: string;
}

export interface NfePortalEntry {
  family: NfePortalDocumentFamily;
  status: NfePortalDocumentStatus;
  title: string;
  description?: string;
  publishedAt?: Date;
  documentNumber?: string;
  version?: string;
  familyKey: string;
  officialUrl: string;
  externalId?: string;
  documentScopes: string[];
  relatedDocument?: string;
  sourceListUrl: string;
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'anchor'; text: string; href: string };

const PORTAL_ORIGIN = 'https://www.nfe.fazenda.gov.br';

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    aacute: 'á',
    Aacute: 'Á',
    atilde: 'ã',
    Atilde: 'Ã',
    acirc: 'â',
    Acirc: 'Â',
    ccedil: 'ç',
    Ccedil: 'Ç',
    eacute: 'é',
    Eacute: 'É',
    ecirc: 'ê',
    Ecirc: 'Ê',
    iacute: 'í',
    Iacute: 'Í',
    oacute: 'ó',
    Oacute: 'Ó',
    ocirc: 'ô',
    Ocirc: 'Ô',
    otilde: 'õ',
    Otilde: 'Õ',
    uacute: 'ú',
    Uacute: 'Ú',
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (entity, token: string) => {
      if (/^#x/i.test(token)) {
        const codePoint = Number.parseInt(token.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (token.startsWith('#')) {
        const codePoint = Number.parseInt(token.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return named[token] ?? named[token.toLowerCase()] ?? entity;
    },
  );
}

function normalizeSpaces(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let anchorHref: string | undefined;
  let anchorText = '';

  const pushText = (text: string) => {
    const normalized = normalizeSpaces(text);
    if (!normalized) return;

    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'text') {
      previous.text = normalizeSpaces(`${previous.text} ${normalized}`);
    } else {
      tokens.push({ kind: 'text', text: normalized });
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name.toLowerCase() === 'a' && attributes.href) {
          anchorHref = attributes.href;
          anchorText = '';
        }
      },
      ontext(text) {
        if (anchorHref !== undefined) {
          anchorText += ` ${text}`;
        } else {
          pushText(text);
        }
      },
      onclosetag(name) {
        if (name.toLowerCase() === 'a' && anchorHref !== undefined) {
          const text = normalizeSpaces(anchorText);
          if (text) {
            tokens.push({
              kind: 'anchor',
              text,
              href: anchorHref,
            });
          }
          anchorHref = undefined;
          anchorText = '';
        }
      },
    },
    {
      decodeEntities: false,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
    },
  );

  parser.write(html);
  parser.end();

  return tokens;
}

function portalStatusFromText(
  value: string,
): NfePortalDocumentStatus | undefined {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (
    /DOCUMENTOS?\s+NAO\s+VIGENTES?/.test(normalized) ||
    /VERSOES?\s+ANTERIORES/.test(normalized) ||
    /EM\s+DESUSO/.test(normalized)
  ) {
    return 'INACTIVE';
  }

  if (
    /DOCUMENTOS?\s+VIGENTES?/.test(normalized) ||
    /^VIGENTES?$/.test(normalized) ||
    /VERSOES?\s+OFICIAIS/.test(normalized) ||
    /EM\s+USO/.test(normalized)
  ) {
    return 'ACTIVE';
  }

  return undefined;
}

function parseBrazilianDate(value: string): Date | undefined {
  const match = /(?:Publicad[ao]|Atualizad[ao])\s+em\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i.exec(
    value,
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1;
  const year = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date;
}

function parseNtIdentity(value: string): {
  documentNumber?: string;
  version?: string;
} {
  const number =
    /Nota\s*T[eé]cnica(?:\s+Conjunta)?\s*([12]\d{3}\.\d{3})/i.exec(
      value,
    )?.[1];

  const version =
    /(?:\b[vV](?:ers[aã]o)?\.?\s*)(\d+(?:\.\d+)*(?:[a-z])?)/i.exec(
      value,
    )?.[1];

  return {
    ...(number ? { documentNumber: number } : {}),
    ...(version ? { version } : {}),
  };
}

function parseItIdentity(value: string): {
  documentNumber?: string;
  version?: string;
} {
  const direct =
    /Informe\s*T[eé]cnico\s*([12]\d{3}\.\d{3})(?:\s*[-.]?\s*[vV](?:ers[aã]o)?\.?\s*(\d+(?:\.\d+)*))?/i.exec(
      value,
    );

  if (direct?.[1]) {
    return {
      documentNumber: direct[1],
      ...(direct[2] ? { version: direct[2] } : {}),
    };
  }

  const compact =
    /Informe\s*T[eé]cnico\s*([12]\d{3}\.\d{3})\.(\d+(?:\.\d+)+)/i.exec(
      value,
    );

  return {
    ...(compact?.[1] ? { documentNumber: compact[1] } : {}),
    ...(compact?.[2] ? { version: compact[2] } : {}),
  };
}

function inferVersion(value: string): string | undefined {
  return (
    /\b[vV](?:ers[aã]o)?\.?\s*(\d+(?:[._-]\d+)*(?:[a-z])?)/i.exec(
      value,
    )?.[1]?.replace(/_/g, '.') ??
    /(?:Pacote\s+de\s+Libera[cç][aã]o\s+)([0-9][\w.-]*)/i.exec(
      value,
    )?.[1]
  );
}

function extractExternalId(url: URL): string | undefined {
  const token = url.searchParams.get('conteudo');
  return token ? `conteudo:${token}` : undefined;
}

function inferScopes(value: string): string[] {
  const normalized = value.toUpperCase();
  const scopes = new Set<string>();

  if (/NF-E|\bNFE\b/.test(normalized)) scopes.add('NFE');
  if (/NFC-E|\bNFCE\b/.test(normalized)) scopes.add('NFCE');
  if (
    /REFORMA\s+TRIBUT|\bRTC\b|\bIBS\b|\bCBS\b|CCLASSTRIB|CCREDPRES/.test(
      normalized,
    )
  ) {
    scopes.add('RTC');
  }

  return [...scopes];
}

function miscRelevant(value: string): boolean {
  return /CLASSIFICA[CÇ][AÃ]O\s+TRIBUT|CCLASSTRIB|CR[EÉ]DITO\s+PRESUMIDO|CCREDPRES|AL[IÍ]QUOTAS?\s+(?:DA\s+)?CBS|\bCFOP\b|MEIOS?\s+DE\s+PAGAMENTO|\bNCM\b|\bFCP\b|PRODUTOS?\s+DA\s+ANP|TRIBUTA[CÇ][AÃ]O\s+MONOF[AÁ]SICA|TABELA\s+DE\s+MUNIC[IÍ]PIOS/i.test(
    value,
  );
}

function candidateTitle(
  family: NfePortalDocumentFamily,
  anchorText: string,
  context: string,
): string | undefined {
  const candidates = [anchorText, ...context.split(/(?<=\.)\s+|\s{2,}/)]
    .map(normalizeSpaces)
    .filter(Boolean);

  const matchers: Record<NfePortalDocumentFamily, RegExp> = {
    NOTE_TECHNICAL: /^Nota\s*T[eé]cnica\b/i,
    TECHNICAL_REPORT: /^Informe\s*T[eé]cnico\b/i,
    XML_SCHEMA: /^(?:Esquema|Esquemas|Schema|Schemas)\s+XML\b/i,
    MANUAL: /^(?:Manual\b|Anexo\s+[IVX]+\b|[-–—>]+\s*Anexo\s+[IVX]+)/i,
    MISC_TECHNICAL: /.+/,
  };

  for (const candidate of candidates) {
    if (
      matchers[family].test(candidate) &&
      (family !== 'MISC_TECHNICAL' || miscRelevant(candidate))
    ) {
      return candidate;
    }
  }

  if (
    family === 'MISC_TECHNICAL' &&
    miscRelevant(context)
  ) {
    const line = candidates.find(miscRelevant);
    return line;
  }

  return undefined;
}

function familyKey(
  family: NfePortalDocumentFamily,
  documentNumber: string | undefined,
  title: string,
): string {
  if (documentNumber) {
    return `${family}:${documentNumber}`;
  }

  const normalized = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\bV(?:ERSAO)?\.?\s*\d+(?:[._-]\d+)*(?:[A-Z])?\b/g, '')
    .replace(/\bPUBLICAD[AO]\s+EM\s+\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);

  return `${family}:${normalized}`;
}

function relatedDocument(value: string): string | undefined {
  const match = /(?:Referente\s+ao|NT\s+relacionada:?|Nota\s+T[eé]cnica)\s+(?:NT\s*)?([12]\d{3}\.\d{3}(?:\s*[vV].?\s*[\w.]+)?)/i.exec(
    value,
  );
  return match?.[1] ? normalizeSpaces(match[1]) : undefined;
}

export function parseNfePortalList(
  html: string,
  definition: NfePortalListDefinition,
): NfePortalEntry[] {
  const tokens = tokenize(html);
  const results: NfePortalEntry[] = [];
  let status: NfePortalDocumentStatus = 'UNKNOWN';

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token.kind === 'text') {
      status = portalStatusFromText(token.text) ?? status;
      continue;
    }

    const before = tokens
      .slice(Math.max(0, index - 4), index)
      .map((item) => item.text)
      .join(' ');
    const after = tokens
      .slice(index + 1, index + 7)
      .filter((item) => item.kind === 'text')
      .map((item) => item.text)
      .join(' ');
    const context = normalizeSpaces(
      `${before} ${token.text} ${after}`,
    );

    let url: URL;
    try {
      url = new URL(token.href, definition.url);
    } catch {
      continue;
    }

    if (
      url.hostname.toLowerCase() !== 'www.nfe.fazenda.gov.br' ||
      !/\/portal\/exibirArquivo\.aspx$/i.test(
        url.pathname,
      )
    ) {
      continue;
    }

    const title = candidateTitle(
      definition.family,
      token.text,
      context,
    );
    if (!title) continue;

    if (
      definition.family === 'MANUAL' &&
      !/NF-E|NFC-E|DANFE|QR.?CODE|CONTING[EÊ]NCIA|ORIENTA[CÇ][AÃ]O\s+AO\s+CONTRIBUINTE/i.test(
        context,
      )
    ) {
      continue;
    }

    const publishedAt = parseBrazilianDate(context);
    const identity =
      definition.family === 'NOTE_TECHNICAL'
        ? parseNtIdentity(title)
        : definition.family === 'TECHNICAL_REPORT'
          ? parseItIdentity(title)
          : {};

    const version =
      identity.version ?? inferVersion(title);
    const externalId = extractExternalId(url);

    const cleanUrl = new URL(url.toString());
    cleanUrl.searchParams.delete('AspxAutoDetectCookieSupport');
    cleanUrl.searchParams.delete('AspxAutoDetectCookie');

    const description = after
      ? normalizeSpaces(after)
      : undefined;

    results.push({
      family: definition.family,
      status,
      title,
      ...(description && description !== title
        ? { description }
        : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(identity.documentNumber
        ? { documentNumber: identity.documentNumber }
        : {}),
      ...(version ? { version } : {}),
      familyKey: familyKey(
        definition.family,
        identity.documentNumber,
        title,
      ),
      officialUrl: cleanUrl.toString(),
      ...(externalId ? { externalId } : {}),
      documentScopes: inferScopes(context),
      ...(relatedDocument(context)
        ? { relatedDocument: relatedDocument(context)! }
        : {}),
      sourceListUrl: definition.url,
    });
  }

  const deduped = new Map<string, NfePortalEntry>();
  for (const entry of results) {
    const key =
      entry.externalId ??
      entry.officialUrl;
    const previous = deduped.get(key);
    if (
      !previous ||
      (previous.status === 'UNKNOWN' &&
        entry.status !== 'UNKNOWN')
    ) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()];
}
