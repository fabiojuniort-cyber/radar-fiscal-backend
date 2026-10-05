import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Parser as HtmlParser } from 'htmlparser2';
import sax from 'sax';
import yauzl from 'yauzl';
import type { ConnectorPublication, ConnectorPartialFailure } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { parseCanonicalRfbFormalAct } from './rfb-normas.identity.js';

export interface DouXmlEntry { name: string; bytes: Uint8Array }
export interface DouArchiveContext { date: string; section: string; filename: string; officialUrl: string; rawSha256: string }
interface Part {
  attrs: Record<string, string>;
  fields: Record<string, string>;
  entry: { name: string; rawSha256: string; sizeBytes: number };
  part: number;
  journal: string;
  hasHighlightImage: boolean;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const error = (code: string) => new ConnectorError(code, { code, kind: 'PROCESSING_ERROR', retryable: false });

export function douHtmlText(html: string): string {
  let out = ''; let hidden = 0;
  const blocks = /^(?:p|div|br|tr|td|th|li|h[1-6]|table)$/;
  const parser = new HtmlParser({
    onopentag(name) { if (/^(script|style)$/.test(name)) hidden++; if (!hidden && blocks.test(name)) out += '\n'; },
    ontext(text) { if (!hidden) out += text; },
    onclosetag(name) { if (/^(script|style)$/.test(name)) hidden = Math.max(0, hidden - 1); if (!hidden && blocks.test(name)) out += '\n'; },
  }, { decodeEntities: true });
  parser.end(html);
  return out.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim();
}

function hasUnpreservedScopeBlocks(html: string): boolean {
  // Keep the legacy canonical text/hash policy unchanged. The scope filter
  // instead receives a conservative veto when block boundaries were lost.
  let found = false;
  const parser = new HtmlParser({
    onopentag(name) { if (/^(?:section|article|blockquote|hr|dl|dt|dd)$/.test(name)) found = true; },
  }, { decodeEntities: true });
  parser.end(html);
  return found;
}

function detachXmlStrings(values: Record<string, string>): void {
  // SAX can return slices/ropes backed by the full decoded XML. Copy completed
  // values through independent bytes so small fields cannot pin large images.
  // UTF-16 preserves every code unit, including any lone surrogate SAX accepts.
  for (const key of Object.keys(values)) {
    values[key] = Buffer.from(values[key]!, 'utf16le').toString('utf16le');
  }
}

function parsePart(entry: DouXmlEntry): Part {
  const match = /^(\d+)_(\d{8})_(\d+)(?:-(\d+))?\.xml$/.exec(entry.name);
  if (!match) throw error('DOU_UNRECOGNIZED_XML_FILENAME');
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes); } catch { throw error('DOU_INVALID_ENCODING'); }
  const parser = sax.parser(true, { strictEntities: true, xmlns: false } as sax.SAXOptions & { strictEntities: boolean });
  const stack: string[] = []; const attrs: Record<string, string> = {}; const fields: Record<string, string> = {};
  let count = 0; let bodyCount = 0; let rootCount = 0;
  parser.ondoctype = () => { throw error('DOU_XML_DTD_FORBIDDEN'); };
  parser.onerror = () => { throw error('DOU_INVALID_XML'); };
  parser.onopentag = node => {
    if (!stack.length) { rootCount++; if (node.name !== 'xml') throw error('DOU_INVALID_XML_ROOT'); }
    stack.push(node.name);
    if (stack.length > 16) throw error('DOU_XML_DEPTH_LIMIT');
    if (node.name === 'article') {
      if (stack.join('/') !== 'xml/article' || ++count !== 1) throw error('DOU_INVALID_ARTICLE_COUNT');
      for (const [key, value] of Object.entries(node.attributes)) attrs[key] = String(value);
    }
    if (node.name === 'body') { if (stack.join('/') !== 'xml/article/body' || ++bodyCount !== 1) throw error('DOU_INVALID_BODY'); }
    if (stack.length === 4 && stack[2] === 'body') {
      if (fields[node.name] !== undefined) throw error('DOU_DUPLICATE_XML_FIELD');
      fields[node.name] = '';
    }
  };
  const append = (text: string) => { if (stack.length === 4 && stack[2] === 'body') fields[stack[3]!] += text; };
  parser.ontext = append; parser.oncdata = append; parser.onclosetag = () => { stack.pop(); };
  try { parser.write(xml).close(); } catch (e) { if (e instanceof ConnectorError) throw e; throw error('DOU_INVALID_XML'); }
  if (stack.length) throw error('DOU_INVALID_XML');
  if (count !== 1 || rootCount !== 1 || bodyCount !== 1 || attrs.idMateria !== match[3]) throw error('DOU_INVALID_XML_STRUCTURE');
  const date = brazilDate(attrs.pubDate ?? '');
  if (date.replaceAll('-', '') !== match[2]) throw error('DOU_FILENAME_DATE_MISMATCH');
  if (!/^\d+$/.test(attrs.id ?? '') || !attrs.editionNumber || !attrs.artCategory || !attrs.pubName) throw error('DOU_MISSING_METADATA');
  // Multipart grouping needs parsed fields, not the original XML buffers (or
  // embedded base64 images). Keep only the original byte hash/size for provenance.
  const hasHighlightImage = Boolean(attrs.highlightImage);
  delete attrs.highlightImage;
  // Detach only after all SAX callbacks/concatenation have finished, and never
  // copy highlightImage: it is intentionally absent from retained provenance.
  detachXmlStrings(attrs);
  detachXmlStrings(fields);
  return {
    attrs, fields,
    entry: { name: entry.name, rawSha256: hash(entry.bytes), sizeBytes: entry.bytes.byteLength },
    part: Number(match[4] ?? 1), journal: match[1]!, hasHighlightImage,
  };
}

function brazilDate(input: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (!m) throw error('DOU_INVALID_PUBLICATION_DATE');
  const value = `${m[3]}-${m[2]}-${m[1]}`;
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw error('DOU_INVALID_PUBLICATION_DATE');
  return value;
}

function actDate(title: string): string | undefined {
  const m = /\bDE\s+(\d{1,2})(?:º|°)?\s+DE\s+(JANEIRO|FEVEREIRO|MARÇO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+DE\s+(\d{4})\b/i.exec(title);
  if (!m) return undefined;
  const month = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'].indexOf(m[2]!.toUpperCase()) + 1;
  try { return brazilDate(`${m[1]!.padStart(2, '0')}/${String(month).padStart(2, '0')}/${m[3]}`); } catch { return undefined; }
}

export function classifyDouAct(title: string, category: string, sourceType: string): {
  agency: string; actType: string; actNumber?: string; actDate?: string; family?: string;
} {
  const upper = title.replace(/\s+/g, ' ').trim().toUpperCase();
  const date = actDate(upper);
  // Only an explicit numbered heading can establish normative identity. Body mentions
  // of a law/CONFAZ act must not turn a correction or dispatch into the cited act.
  const numbered = /^(.+?)\s+N[º°o.]?\s*([\d.]+)(?:\/(\d{2,4}))?(?:\s*,|\s+DE\b|$)/i.exec(upper);
  const confaz = /(?:CONFAZ|CONSELHO NACIONAL DE POL[IÍ]TICA FAZEND[AÁ]RIA)/i.test(category);
  const family = /^(CONVÊNIO ICMS|AJUSTE SINIEF|PROTOCOLO ICMS|ATO COTEPE\/ICMS)\b/.exec(upper)?.[1];
  const special = /RETIFICA|REPUBLICA/.test(sourceType.toUpperCase()) || /^(RETIFICA|REPUBLICA)/.test(upper);
  const year = numbered?.[3]?.length === 4 ? numbered[3] : date?.slice(0, 4);
  const type = special ? sourceType.toUpperCase() : numbered?.[1]?.trim() || sourceType.toUpperCase();
  const parsedRfb = !special && !confaz
    ? parseCanonicalRfbFormalAct(
        title,
        category,
        sourceType,
        date ? Number(date.slice(0, 4)) : undefined,
      )
    : undefined;
  // Cross-source canonicalization is deliberately limited to families for
  // which the existing DOU taxonomy is not unit-specific. ADE/Portaria
  // headings such as "ATO DECLARATÓRIO EXECUTIVO COANA" keep their proven
  // legacy taxonomy so this feature cannot rewrite existing production
  // identities merely to satisfy Receita correlation.
  const canonicalRfbTypes = new Set([
    'INSTRUÇÃO NORMATIVA',
    'INSTRUÇÃO NORMATIVA CONJUNTA',
    'ATO DECLARATÓRIO INTERPRETATIVO',
    'ATO DECLARATÓRIO NORMATIVO',
    'PARECER NORMATIVO',
    'SOLUÇÃO DE CONSULTA',
    'SOLUÇÃO DE DIVERGÊNCIA',
    'NOTA TÉCNICA',
    'NOTA TÉCNICA CONJUNTA',
    'ATO TÉCNICO CONJUNTO',
    'NORMA DE EXECUÇÃO',
    'NORMA DE EXECUÇÃO CONJUNTA',
  ]);
  const rfb = parsedRfb && canonicalRfbTypes.has(parsedRfb.actType)
    ? parsedRfb
    : undefined;
  return {
    agency: confaz ? 'CONFAZ' : rfb?.agency ?? category,
    actType: confaz && family && !special ? family : rfb?.actType ?? type,
    ...(rfb?.actNumber
      ? { actNumber: rfb.actNumber }
      : numbered && year && !special
        ? { actNumber: `${Number(numbered[2]!.replaceAll('.', ''))}/${year}` }
        : {}),
    ...(date ? { actDate: date } : {}),
    ...(confaz && family && !special ? { family } : {}),
  };
}


const EMBEDDED_CONFAZ_HEADING =
  /^(CONVÊNIO ICMS|AJUSTE SINIEF|PROTOCOLO ICMS|ATO COTEPE(?:\/ICMS| ICMS))\s+N[º°O.]?\s*(\d+)(?:\/(\d{2,4}))?\s*,?\s*DE\s+(\d{1,2})(?:º|°)?\s+DE\s+(JANEIRO|FEVEREIRO|MARÇO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+DE\s+(\d{4})$/;

function embeddedConfazHeading(line: string): {
  title: string;
  family: string;
  actNumber: string;
  actDate: string;
} | undefined {
  const title = line.replace(/\s+/g, ' ').trim();
  const match = EMBEDDED_CONFAZ_HEADING.exec(title);
  if (!match?.[1] || !match[2] || !match[6]) return undefined;

  const parsedDate = actDate(title);
  if (!parsedDate) return undefined;

  const dateYear = Number(parsedDate.slice(0, 4));
  const rawYear = match[3] ? Number(match[3]) : dateYear;
  const explicitYear = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (explicitYear !== dateYear) return undefined;

  const family = match[1] === 'ATO COTEPE ICMS'
    ? 'ATO COTEPE/ICMS'
    : match[1];

  return {
    title,
    family,
    actNumber: `${Number(match[2])}/${dateYear}`,
    actDate: parsedDate,
  };
}

function metadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * CONFAZ uses a DOU "DESPACHO" as an official publishing envelope for batches
 * of Convênios ICMS, Ajustes SINIEF and Protocolos ICMS. These headings are
 * source-level acts, not incidental body citations. Preserve the dispatch and
 * additionally emit one child publication per explicit all-caps dated heading.
 */
export function extractEmbeddedConfazPublications(
  parent: ConnectorPublication,
): ConnectorPublication[] {
  if (
    parent.agency !== 'CONFAZ' ||
    parent.actType?.toUpperCase() !== 'DESPACHO' ||
    !parent.content ||
    !parent.publishedAt ||
    !parent.externalId
  ) {
    return [];
  }

  const lines = parent.content
    .split('\n')
    .map(line => line.trim());

  const headings = lines
    .map((line, index) => ({
      index,
      parsed: embeddedConfazHeading(line),
    }))
    .filter(
      (item): item is {
        index: number;
        parsed: NonNullable<ReturnType<typeof embeddedConfazHeading>>;
      } => item.parsed !== undefined,
    );

  const seen = new Set<string>();
  const children: ConnectorPublication[] = [];
  const parentDou = metadataRecord(parent.metadata?.dou);

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const key = `${current.parsed.family}:${current.parsed.actNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const next = headings[i + 1]?.index ?? lines.length;
    const content = lines
      .slice(current.index, next)
      .join('\n')
      .trim();

    if (!content) continue;

    children.push({
      title: current.parsed.title,
      agency: 'CONFAZ',
      sphere: 'FEDERAL',
      actType: current.parsed.family,
      actNumber: current.parsed.actNumber,
      publishedAt: new Date(parent.publishedAt),
      content,
      officialUrl: parent.officialUrl,
      externalId:
        `${parent.externalId}:embedded:${current.parsed.family}:${current.parsed.actNumber}`,
      metadata: {
        sourceRole: 'PRIMARY',
        ingestionChannel: 'INLABS',
        officialUrlGranularity: 'PAGE',
        dou: {
          publicationDate:
            parentDou?.publicationDate ??
            parent.publishedAt.toISOString().slice(0, 10),
          section: parentDou?.section ?? null,
          edition: parentDou?.edition ?? null,
          officialMatterId:
            parentDou?.officialMatterId ?? null,
          agencyPath: parentDou?.agencyPath ?? null,
          unit: parentDou?.unit ?? null,
          sourceActType: current.parsed.family,
          actDate: current.parsed.actDate,
          actYear: current.parsed.actDate.slice(0, 4),
          structuralFamily: current.parsed.family,
          certifiedPageUrls:
            parentDou?.certifiedPageUrls ??
            [parent.officialUrl],
          officialHtmlUrl: null,
          archive: parentDou?.archive ?? null,
          embeddedAct: true,
          embeddedHeading: current.parsed.title,
          embeddedIndex: i + 1,
          parentMatterExternalId: parent.externalId,
          parentDispatchTitle: parent.title,
          parentDispatchActNumber:
            parent.actNumber ?? null,
        },
      },
    });
  }

  return children;
}

function publication(parts: Part[], context: DouArchiveContext): ConnectorPublication {
  parts.sort((a, b) => a.part - b.part);
  const first = parts[0]!; const a = first.attrs;
  if (parts.some((p, i) => p.part !== i + 1)) throw error('DOU_MISSING_OR_DUPLICATE_PART');
  const officialTitle = douHtmlText(first.fields.Identifica ?? '');
  // Some official matters carry an empty <Identifica>. The matter is still an
  // official publication: it gets a descriptive title from its own official
  // attributes (type and publishing unit), flagged in metadata. The fallback
  // never feeds act classification, so no act number or normative identity
  // is inferred from it; identity stays scoped to the official matter id.
  const titleFallback = officialTitle
    ? undefined
    : [a.artType?.trim() || 'Matéria', a.artCategory?.split('/').at(-1)?.trim()]
        .filter((value): value is string => Boolean(value))
        .join(' - ');
  const title = officialTitle || titleFallback!;
  const date = brazilDate(a.pubDate!);
  if (date !== context.date || a.pubName !== context.section) throw error('DOU_ARCHIVE_CONTEXT_MISMATCH');
  const pages: string[] = [];
  const continuationTitles = new Set<string>();
  const continuationAbstracts = new Set<string>();
  for (const p of parts) {
    for (const key of ['idMateria', 'pubDate', 'pubName', 'editionNumber', 'artCategory', 'artType']) {
      if (p.attrs[key] !== a[key]) throw error('DOU_INCONSISTENT_PARTS');
    }
    if (p.part > 1) {
      const continuationTitle = douHtmlText(p.fields.Identifica ?? '');
      if (continuationTitle && continuationTitle !== officialTitle) {
        continuationTitles.add(continuationTitle);
      }
      const continuationAbstract = douHtmlText(p.fields.Ementa ?? '');
      if (continuationAbstract) continuationAbstracts.add(continuationAbstract);
    }
    let url: URL;
    try { url = new URL(p.attrs.pdfPage!); } catch { throw error('DOU_MISSING_CERTIFIED_REFERENCE'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'pesquisa.in.gov.br' || url.username || url.password || url.port ||
        url.pathname !== '/imprensa/jsp/visualiza/index.jsp' || url.searchParams.get('data') !== a.pubDate ||
        url.searchParams.get('jornal') !== p.journal || url.searchParams.get('pagina') !== p.attrs.numberPage) throw error('DOU_INVALID_CERTIFIED_REFERENCE');
    pages.push(p.attrs.pdfPage!);
  }
  const structural = classifyDouAct(officialTitle, a.artCategory!, a.artType ?? '');
  const scopeStructureIncomplete = parts.some(p =>
    ['Identifica', 'Ementa', 'Texto'].some(field => hasUnpreservedScopeBlocks(p.fields[field] ?? '')));
  const text = parts.map(p => douHtmlText(p.fields.Texto ?? '')).join('\n');
  const presentationHtml = parts
    .map(p => p.fields.Texto ?? '')
    .filter(Boolean)
    .map(fragment => `<section>${fragment}</section>`)
    .join('<hr>');
  if (parts.some(p => !douHtmlText(p.fields.Texto ?? ''))) throw error('DOU_MISSING_CONTENT');
  return {
    title, sphere: 'FEDERAL', agency: structural.agency, actType: structural.actType,
    ...(structural.actNumber ? { actNumber: structural.actNumber } : {}),
    publishedAt: new Date(`${date}T00:00:00Z`), content: text,
    ...(presentationHtml ? { presentationHtml } : {}),
    officialUrl: pages[0]!,
    // A composite of observed official fields distinguishes later editorial occurrences
    // of the same idMateria. The unmodified official ID is also retained below.
    externalId: `${date}:${a.pubName}:${a.editionNumber}:${a.idMateria}`,
    metadata: {
      sourceRole: 'PRIMARY', ingestionChannel: 'INLABS', officialUrlGranularity: 'PAGE',
      dou: { publicationDate: date, section: a.pubName, edition: a.editionNumber,
        officialMatterId: a.idMateria, agencyPath: a.artCategory,
        unit: a.artCategory!.split('/').at(-1), sourceActType: a.artType,
        actDate: structural.actDate ?? null, actYear: structural.actDate?.slice(0, 4) ?? null,
        structuralFamily: structural.family ?? null, abstract: douHtmlText(first.fields.Ementa ?? ''),
        continuationTitles: [...continuationTitles],
        continuationAbstracts: [...continuationAbstracts],
        ...(scopeStructureIncomplete ? { scopeStructureIncomplete: true } : {}),
        ...(titleFallback ? { titleFallback: 'ART_TYPE_AND_UNIT' } : {}),
        certifiedPageUrls: [...new Set(pages)], officialHtmlUrl: null,
        archive: context,
        parts: parts.map(p => ({ filename: p.entry.name, rawSha256: p.entry.rawSha256, sizeBytes: p.entry.sizeBytes,
          // The dictionary permits base64 images here; do not persist image bytes in PostgreSQL.
          attributes: Object.fromEntries(Object.entries(p.attrs).filter(([key]) => key !== 'highlightImage')),
          hasHighlightImage: p.hasHighlightImage,
        })),
      },
    },
  };
}

interface DouGroups {
  groups: Map<string, Part[]>;
  invalid: Set<string>;
  partialFailures: ConnectorPartialFailure[];
}

function addDouEntry({ groups, invalid, partialFailures }: DouGroups, entry: DouXmlEntry): void {
  // Infer a group only from the validated filename pattern so a broken continuation
  // prevents a truncated publication from being persisted as a new complete version.
  const filenameGroup = /^(\d+)_\d{8}_(\d+)(?:-\d+)?\.xml$/.exec(entry.name);
  const key = filenameGroup ? `${filenameGroup[1]}:${filenameGroup[2]}` : entry.name;
  try {
    const p = parsePart(entry);
    if (invalid.has(key)) return;
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  } catch (e) {
    invalid.add(key);
    groups.delete(key);
    partialFailures.push({ code: e instanceof ConnectorError ? e.code : 'DOU_INVALID_XML', message: 'XML could not be processed', itemReference: entry.name });
  }
}

function* assembledPublications({ groups, partialFailures }: DouGroups, context: DouArchiveContext): Generator<ConnectorPublication> {
  for (const [key, parts] of groups) {
    groups.delete(key);
    let publications: ConnectorPublication[];
    try {
      const parent = publication(parts, context);
      publications = [parent, ...extractEmbeddedConfazPublications(parent)];
    } catch (e) {
      partialFailures.push({ code: e instanceof ConnectorError ? e.code : 'DOU_INVALID_MATTER', message: 'Matter could not be assembled', itemReference: parts[0]!.entry.name });
      continue;
    } finally {
      // Do not retain parsed HTML/attributes while the consumer persists this group.
      parts.length = 0;
    }
    yield* publications;
  }
}

export function parseDouEntries(entries: DouXmlEntry[], context: DouArchiveContext): {
  publications: ConnectorPublication[]; partialFailures: ConnectorPartialFailure[];
} {
  const state: DouGroups = { groups: new Map(), invalid: new Set(), partialFailures: [] };
  for (const entry of entries) addDouEntry(state, entry);
  return { publications: [...assembledPublications(state, context)], partialFailures: state.partialFailures };
}

/** Read one XML entry at a time without copying the compressed archive. */
async function visitDouZip(
  bytes: Uint8Array,
  signal: AbortSignal,
  onEntry: (entry: DouXmlEntry) => void,
): Promise<{ xmlCount: number; mediaCount: number }> {
  if (bytes.byteLength > 64 * 1024 * 1024) throw error('DOU_ARCHIVE_TOO_LARGE');
  signal.throwIfAborted();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer,
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, file) => err ? reject(error('DOU_INVALID_ZIP')) : resolve(file)));
  return new Promise((resolve, reject) => {
    const names = new Set<string>(); let total = 0; let xmlCount = 0; let mediaCount = 0; let done = false;
    let stream: NodeJS.ReadableStream & { destroy(): void } | undefined;
    let entryBytes: Buffer | undefined;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      stream?.destroy();
      stream = undefined;
      entryBytes = undefined;
      names.clear();
      zip.close();
    };
    const fail = (e: unknown) => { if (done) return; done = true; cleanup(); reject(e); };
    const abort = () => fail(signal.reason ?? error('DOU_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    zip.on('error', () => fail(error('DOU_INVALID_ZIP')));
    zip.on('end', () => { if (done) return; done = true; cleanup(); resolve({ xmlCount, mediaCount }); });
    zip.on('entry', (entry: yauzl.Entry) => {
      if (done) return;
      if (signal.aborted) { abort(); return; }
      total += entry.uncompressedSize;
      if (names.has(entry.fileName) || names.size >= 5000 || entry.uncompressedSize > 8 * 1024 * 1024 || total > 128 * 1024 * 1024 || entry.isEncrypted()) {
        fail(error('DOU_UNSAFE_ZIP')); return;
      }
      names.add(entry.fileName);
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      // Flat names are the format observed in both real archives.
      if (entry.fileName.includes('/') || entry.fileName.includes('\\')) { fail(error('DOU_UNSAFE_ZIP_PATH')); return; }
      if (!entry.fileName.endsWith('.xml')) { mediaCount++; zip.readEntry(); return; }
      zip.openReadStream(entry, (err, input) => {
        if (err || !input) { fail(error('DOU_INVALID_ZIP_ENTRY')); return; }
        if (done) { input.destroy(); return; }
        // The advertised size is bounded above before allocation. An exact-sized
        // entry buffer avoids retaining all inflate chunks plus a concatenated copy.
        stream = input; entryBytes = Buffer.allocUnsafe(entry.uncompressedSize); let size = 0;
        input.on('data', (chunk: Buffer) => {
          if (done) return;
          if (size + chunk.length > entry.uncompressedSize || size + chunk.length > 8 * 1024 * 1024) { fail(error('DOU_ZIP_SIZE_MISMATCH')); return; }
          chunk.copy(entryBytes!, size);
          size += chunk.length;
        });
        input.on('error', () => fail(error('DOU_INVALID_ZIP_ENTRY')));
        input.on('end', () => {
          if (done) return;
          if (size !== entry.uncompressedSize || crc32(entryBytes!) !== entry.crc32) { fail(error('DOU_ZIP_CRC_MISMATCH')); return; }
          try {
            onEntry({ name: entry.fileName, bytes: entryBytes! });
            xmlCount++;
          } catch (e) { fail(e); return; }
          entryBytes = undefined;
          stream = undefined;
          if (signal.aborted) abort(); else zip.readEntry();
        });
      });
    });
    if (signal.aborted) abort(); else zip.readEntry();
  });
}

/** Compatibility API for callers that explicitly need the original XML entries. */
export async function readDouZip(bytes: Uint8Array, signal: AbortSignal): Promise<{ entries: DouXmlEntry[]; mediaCount: number }> {
  const entries: DouXmlEntry[] = [];
  const { mediaCount } = await visitDouZip(bytes, signal, entry => { entries.push(entry); });
  return { entries, mediaCount };
}

/**
 * Parse one archive with bounded XML-buffer residency, then await the consumer for
 * each complete publication. Unordered/malformed continuations require retaining
 * parsed groups until the entire ZIP is verified; no publication batch or raw XML
 * entry array is retained. Groups are released as the consumer progresses.
 */
export async function parseDouZip(
  bytes: Uint8Array,
  context: DouArchiveContext,
  signal: AbortSignal,
  onPublication: (publication: ConnectorPublication) => void | Promise<void>,
): Promise<{ partialFailures: ConnectorPartialFailure[]; xmlCount: number; mediaCount: number }> {
  const state: DouGroups = { groups: new Map(), invalid: new Set(), partialFailures: [] };
  try {
    const counts = await visitDouZip(bytes, signal, entry => addDouEntry(state, entry));
    for (const publication of assembledPublications(state, context)) {
      signal.throwIfAborted();
      await onPublication(publication);
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    return { partialFailures: state.partialFailures, ...counts };
  } finally {
    state.groups.clear();
    state.invalid.clear();
  }
}
