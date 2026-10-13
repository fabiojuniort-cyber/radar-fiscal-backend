import {
  PDF,
  SEARCH,
  authPdfEnvelope,
  details,
  editionUrl0904,
  filters,
  journals,
  list0904,
  pdfBytes,
  sections,
  status0904,
  supplementaryUrls,
} from './doe-sp.fixtures.js';

export interface DayFixture {
  structured: unknown;
  list: unknown;
}

export interface PortalOptions {
  days: Record<string, DayFixture>;
  /** Path substrings answered with the given HTTP status. */
  failures?: Array<{ match: string; status: number }>;
  /** Extra/overridden publication details by id. */
  details?: Record<string, Record<string, unknown>>;
}

export interface Portal {
  fetch: typeof fetch;
  requests: string[];
  count(match: string): number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** In-memory DOE-SP API backed by the real fixtures. */
export function portal(options: PortalOptions): Portal {
  const requests: string[] = [];
  // F3 fetches items previously rejected from the listing. These eight detail
  // responses are synthetic test evidence, not captured official full texts.
  // Real captured detail fixtures and explicit overrides retain precedence.
  const syntheticDetails = Object.fromEntries(list0904.publications.map(item => [item.id, {
    id: item.id, title: item.title, slug: item.slug, date: item.date.slice(0, 10),
    journal: 'Executivo', firstLevelSectionName: 'Atos Normativos',
    publicationType: filters.publicationTypes.find(type => type.id === item.publicationTypeId)?.name,
    content: `<p>${item.excerpt}</p>`, attachments: [],
  }]));
  const allDetails = { ...syntheticDetails, ...details, ...(options.details ?? {}) };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const key = url.origin + url.pathname + url.search;
    requests.push(key);
    for (const failure of options.failures ?? []) {
      if (key.includes(failure.match)) return new Response('unavailable', { status: failure.status, headers: { 'content-type': 'text/html' } });
    }
    const date = url.searchParams.get('Date') ?? url.searchParams.get('EditionDate') ?? '';
    if (url.origin + '/' === SEARCH) {
      const path = url.pathname;
      if (path === '/v2/journals') return json(journals);
      if (path === '/v2/sections') return json(sections);
      if (path === '/v2/summary/structured') return json(options.days[date]?.structured ?? { items: [] });
      if (path === '/v2/summary/list') return json(options.days[date]?.list ?? { pages: 0, pageSize: 10, publications: [] });
      if (path === '/v2/summary/filters') return json(filters);
      const detail = /^\/v2\/publications\/([0-9a-f-]{36})$/.exec(path);
      if (detail) {
        const body = allDetails[detail[1]!];
        return body ? json(body) : json({ status: 400, title: 'HTTP 400 Bad Request' }, 400);
      }
      const auth = /^\/v2\/authentication\/download\/(.+)$/.exec(path);
      if (auth) {
        const owner = Object.values(allDetails).find((item) => item.authCode === decodeURIComponent(auth[1]!));
        return owner ? json(authPdfEnvelope(String(owner.id))) : json({ status: 400 }, 400);
      }
      const attachment = /^\/v2\/publications\/attachment\/downloadattachment\/(.+)$/.exec(path);
      if (attachment) {
        return new Response(pdfBytes('attachment ' + attachment[1]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
    }
    if (url.origin + '/' === PDF) {
      if (url.pathname.startsWith('/v1/editions/status/')) {
        return url.pathname.endsWith('2026-09-04') ? json(status0904) : json({ status: 404 }, 404);
      }
      if (url.pathname === '/v1/editions/url') return date === '2026-09-04' ? json(editionUrl0904) : json({ status: 404 }, 404);
      if (url.pathname === '/v1/supplementary-editions/url') return json(date === '2026-09-04' ? supplementaryUrls : { supplementaryEditionsUrls: [] });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    count: (match: string) => requests.filter((request) => request.includes(match)).length,
  };
}
