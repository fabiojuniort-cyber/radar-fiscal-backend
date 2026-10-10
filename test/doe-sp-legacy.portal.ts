import { deflateSync } from 'node:zlib';

/*
 * Synthetic fixtures for the legacy DOE-SP archive (Imprensa Oficial): page
 * PDFs built in memory and a fake portal that answers GetCadernos, the
 * BuscaDO2001 result screens (browse + keyword search), the negative page and
 * GatewayPDF, with the same URL shapes measured on the source.
 */

const ORIGIN = 'https://www.imprensaoficial.com.br';

function pdfFromObjects(objects: Array<string | Buffer>): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const body = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      typeof object === 'string' ? Buffer.from(object, 'latin1') : object,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(body);
    length += body.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer', `<< /Size ${objects.length + 1} /Root 1 0 R >>`, 'startxref', String(length), '%%EOF', ''].join('\n');
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** One-page, born-digital PDF (Helvetica, WinAnsi) with the given lines. */
export function textPdf(lines: string[]): Uint8Array {
  const content = ['BT', '/F1 10 Tf', '12 TL', '40 800 Td',
    ...lines.map((line) => `(${escapePdf(line)}) Tj T*`), 'ET'].join('\n');
  const stream = Buffer.from(content, 'latin1');
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]),
  ]);
}

/** One-page scan: a full-page 1-bit raster and no text layer. */
export function scanPdf(): Uint8Array {
  const width = 2000;
  const height = 1500;
  const raster = deflateSync(Buffer.alloc((width / 8) * height, 0xff));
  const content = Buffer.from(`q 595 0 0 842 0 0 cm /Im1 Do Q`, 'latin1');
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${raster.length} >>\nstream\n`, 'latin1'),
      raster,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
  ]);
}

/** One-page scan with an OCR text layer (full-page raster + text), like the 1988–2001 archive. */
export function ocrPdf(lines: string[]): Uint8Array {
  const width = 2000;
  const height = 1500;
  const raster = deflateSync(Buffer.alloc((width / 8) * height, 0xff));
  const content = Buffer.from(['q 595 0 0 842 0 0 cm /Im1 Do Q', 'BT', '/F1 10 Tf', '12 TL', '40 800 Td',
    ...lines.map((line) => `(${escapePdf(line)}) Tj T*`), 'ET'].join('\n'), 'latin1');
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${raster.length} >>\nstream\n`, 'latin1'),
      raster,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
}

export interface LegacyPage {
  /** Canonical archive path. */
  link: string;
  pagina: string;
  /** YYYY-MM-DD */
  date: string;
  caderno: string;
  pdf?: Uint8Array;
  /** Serve HTML instead of the PDF (source glitch). */
  htmlInsteadOfPdf?: boolean;
}

export interface LegacyPortalOptions {
  /** Cadernos by DOE date (YYYY-MM-DD). Missing = no edition. */
  cadernos?: Record<string, Array<{ id: string; name: string }>>;
  /** Whole editions (browse): pages by `${date}|${caderno}`. */
  editions?: Record<string, LegacyPage[]>;
  /** Keyword hits: pages by `${keyword}|${caderno}` (any date; filtered by the period). */
  search?: Record<string, LegacyPage[]>;
  /** Paths answering this status (e.g. 503). */
  failStatus?: { match: RegExp; status: number };
  /** Result screen HTML without the "Documentos encontrados" marker. */
  brokenResults?: boolean;
  /**
   * Fault on one result screen (keyword '' = whole-edition browse):
   * MALFORMED_ONE adds an unparseable link, ALL_MALFORMED breaks every link,
   * EMPTY lists no document, NEGATIVE answers "no results".
   */
  screenFault?: (at: { keyword: string; caderno: string; screen: number }) => 'MALFORMED_ONE' | 'ALL_MALFORMED' | 'EMPTY' | 'NEGATIVE' | undefined;
  /** Called on every request (e.g. to advance a fake clock). */
  onRequest?: (url: URL) => void;
}

function br(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function docHref(page: LegacyPage, index: number): string {
  const link = encodeURIComponent(page.link.replace(/ /g, '%20'));
  return `/DO/BuscaDO2001Documento_11_4.aspx?link=${link}&amp;pagina=${page.pagina}&amp;data=${br(page.date)}` +
    `&amp;caderno=${page.caderno}&amp;paginaordenacao=${100000 + index + 1}`;
}

const BAD_HREF = '/DO/BuscaDO2001Documento_11_4.aspx?link=javascript:x&amp;pagina=1&amp;data=99/99/2015&amp;caderno=Executivo I&amp;paginaordenacao=1';

function resultHtml(total: number, pages: LegacyPage[], offset: number, fault?: 'MALFORMED_ONE' | 'ALL_MALFORMED' | 'EMPTY'): string {
  const href = (page: LegacyPage, index: number) => fault === 'ALL_MALFORMED' ? BAD_HREF : docHref(page, index);
  const rows = (fault === 'EMPTY' ? [] : pages).map((page, i) =>
    `<div class="resultado"><a href="${href(page, offset + i)}">${br(page.date)} - ${page.caderno} - Pag. ${page.pagina}</a>` +
    ` <a href="/Certificacao/Certificador.aspx?link=x">Certificar</a>` +
    // Each item is linked twice on the real page (title + thumbnail).
    ` <a href="${href(page, offset + i)}"><img src="thumb.png"></a></div>`).join('\n') +
    (fault === 'MALFORMED_ONE' ? `\n<div class="resultado"><a href="${BAD_HREF}">?</a></div>` : '');
  return `<html><body><div>Resultado de busca por:</div><div>Documentos encontrados: ${total}</div>\n${rows}\n` +
    `<a href="/DO/BuscaDO2001Resultado_11_3.aspx?xhitlist_vpc=2">pr&#243;xima</a></body></html>`;
}

export interface LegacyPortal {
  fetch: typeof fetch;
  requests: string[];
}

export function legacyPortal(options: LegacyPortalOptions): LegacyPortal {
  const requests: string[] = [];
  const pdfs = new Map<string, LegacyPage>();
  for (const list of [...Object.values(options.editions ?? {}), ...Object.values(options.search ?? {})]) {
    for (const page of list) pdfs.set(page.link, page);
  }

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    options.onRequest?.(url);
    if (url.origin !== ORIGIN) throw new Error('unexpected origin ' + url.origin);
    if (options.failStatus?.match.test(url.pathname + url.search)) {
      return new Response('down', { status: options.failStatus.status });
    }

    if (url.pathname.startsWith('/ajax/') && url.searchParams.get('_method') === 'GetCadernos') {
      const body = String(init?.body ?? '');
      const match = /strData=(\d{2})\/(\d{2})\/(\d{4})/.exec(body);
      const date = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
      const list = options.cadernos?.[date] ?? [];
      return new Response('[' + list.map((c) => `{'ID':'${c.id}','texto':'${c.name}'}`).join(',') + '];/*', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/DO/BuscaDO2001Resultado_11_3.aspx') {
      const params = url.searchParams;
      const from = params.get('filtrodatainiciosalvar')!;
      const to = params.get('filtrodatafimsalvar')!;
      const caderno = params.get('filtrocadernos')!;
      const keyword = (params.get('filtropalavraschave') ?? '').trim();
      const iso = (compact: string) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      const inPeriod = (page: LegacyPage) => page.date >= iso(from) && page.date <= iso(to);
      const all = keyword
        ? (options.search?.[`${keyword}|${caderno}`] ?? [])
        : (options.editions?.[`${iso(from)}|${caderno}`] ?? []);
      // The index occasionally returns hits outside the period filter.
      const hits = keyword ? all : all.filter(inPeriod);
      if (!hits.length) {
        return new Response(null, {
          status: 302,
          headers: { location: `/DO/BuscaDO2001ResultadoNegativo_11_3a.aspx?filtropalavraschave=${encodeURIComponent(keyword)}` },
        });
      }
      if (options.brokenResults) return new Response('<html><body>manutenção</body></html>', { status: 200 });
      const vpc = params.get('xhitlist_vpc');
      const screen = vpc === 'first' || vpc === null ? 1 : Number(vpc);
      const offset = (screen - 1) * 15;
      const fault = options.screenFault?.({ keyword, caderno, screen });
      if (fault === 'NEGATIVE') {
        return new Response(null, { status: 302, headers: { location: '/DO/BuscaDO2001ResultadoNegativo_11_3a.aspx?x=1' } });
      }
      return new Response(resultHtml(hits.length, hits.slice(offset, offset + 15), offset, fault), {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'ASP.NET_SessionId=abc; path=/' },
      });
    }

    if (url.pathname === '/DO/BuscaDO2001ResultadoNegativo_11_3a.aspx') {
      return new Response('<html><body>Sua pesquisa não houve resultados</body></html>', { status: 200 });
    }

    if (url.pathname === '/DO/GatewayPDF.aspx') {
      const link = decodeURIComponent(url.searchParams.get('link') ?? '');
      const page = pdfs.get(link);
      if (!page) return new Response('not found', { status: 404 });
      if (page.htmlInsteadOfPdf) return new Response('<html><body>erro</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(page.pdf ?? textPdf(['sem termos']), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }

    return new Response('unexpected ' + url.pathname, { status: 404 });
  };
  return { fetch: impl as typeof fetch, requests };
}
