/**
 * Simulated gov.br/SPED portal for regression tests.
 *
 * Every HTML response carries per-request volatile portal data, as observed
 * in production on 2026-09-22: a random Volto router key, a random Dynatrace
 * rpid attribute and a shuffled redux state serialisation. None of that may
 * reach publication content or identity.
 */

export const GOV = 'https://www.gov.br/sped/pt-br';

export interface FakeDocument {
  path: string;
  title: string;
  type: 'File' | 'Document';
  published?: string;
  created?: string;
  description?: string;
  body?: string;
  /** File label used as bytes seed; files resolve at path + '/@@display-file/file'. */
  file?: string;
  filename?: string;
  /** Extra links (e.g. an announcement linking the document file). */
  links?: Array<{ href: string; text: string }>;
}

export interface FakeListing {
  path: string;
  title: string;
  items: string[];
}

export const SEED_PATHS = [
  '/assuntos/escrituracoes-digitais/efd-icms-ipi',
  '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos',
  '/assuntos/comunicados/efd-icms-ipi',
  '/assuntos/escrituracoes-digitais/efd-contribuicoes',
  '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos',
  '/assuntos/comunicados/efd-contribuicoes',
  '/assuntos/escrituracoes-digitais/efd-reinf',
  '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos',
  '/assuntos/comunicados/efd-reinf',
  '/assuntos/documentos-fiscais/dere',
  '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1',
  '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versoes-anteriores',
  '/assuntos/comunicados/dere',
];

function randomKey(): string {
  return Math.random().toString(36).slice(2, 8);
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function voltoState(content: Record<string, unknown>): string {
  const volatile: Array<[string, unknown]> = [
    ['router', { location: { pathname: content['@id'], key: randomKey(), query: {} }, action: 'POP' }],
    ['navigation', { items: shuffle(['Assuntos', 'Comunicados', 'Downloads', 'Composição']).map((title) => ({ title })) }],
    ['site', { 'plone.robots_txt': shuffle(['User-agent: *', 'Disallow: /search', 'Disallow: /login']).join('\n') }],
    ['breadcrumbs', { items: [{ title: 'Assuntos' }], requestId: randomKey() }],
  ];
  const entries = shuffle([...volatile, ['content', { data: content }]] as Array<[string, unknown]>);
  return JSON.stringify(Object.fromEntries(entries)).replace(/"__undef__"/g, 'undefined');
}

function chrome(inner: string, content: Record<string, unknown>): string {
  return '<!doctype html><html><head>' +
    '<script type="text/javascript" src="/ruxitagentjs_x.js" data-dtconfig="rid=RID_1|rpid=' + randomKey() + '"></script>' +
    '<script>window.env = {"publicURL":"https://www.gov.br/sped","cacheBuster":"' + randomKey() + '"};</script>' +
    '<style>.x{color:red}</style></head><body>' +
    '<nav>Ir para o conteúdo Ir para a navegação Assuntos Comunicados Downloads</nav>' +
    inner +
    '<footer>Todo o conteúdo deste site está publicado sob a licença Creative Commons</footer>' +
    '<script>window.__data=' + voltoState(content) + ';</script>' +
    '</body></html>';
}

export function listingHtml(listing: FakeListing): string {
  const content = {
    '@id': GOV + listing.path,
    '@type': 'Document',
    title: listing.title,
    description: '',
    items: listing.items.map((path) => ({ '@id': GOV + path, title: path.split('/').at(-1) })),
  };
  return chrome(
    '<h1>' + listing.title + '</h1>' +
      listing.items.map((path) => '<a href="' + GOV + path + '">' + (DOC_TITLES.get(path) ?? path) + '</a>').join(' '),
    content,
  );
}

const DOC_TITLES = new Map<string, string>();

export function documentHtml(doc: FakeDocument): string {
  DOC_TITLES.set(doc.path, doc.title);
  const fileUrl = GOV + doc.path + '/@@display-file/file';
  const blocks: Record<string, unknown> = {};
  const layout: string[] = [];
  if (doc.body) {
    blocks['b-title'] = { '@type': 'title' };
    blocks['b-body'] = { '@type': 'slate', plaintext: doc.body, value: [{ type: 'p', children: [{ text: doc.body }] }] };
    blocks['b-share'] = { '@type': 'dateSocialShareBlock' };
    layout.push('b-title', 'b-body', 'b-share');
  }
  const content: Record<string, unknown> = {
    '@id': GOV + doc.path,
    '@type': doc.type,
    title: doc.title,
    description: doc.description ?? '',
    created: '2026-06-02T14:02:50+00:00',
    modified: '2026-06-02T14:02:50+00:00',
    review_state: 'published',
    ...(doc.file ? { file: { 'content-type': 'application/pdf', download: fileUrl, filename: doc.filename ?? doc.title + '.pdf', size: 100 } } : {}),
    ...(layout.length ? { blocks, blocks_layout: { items: layout } } : {}),
  };
  const inner =
    '<h1>' + doc.title + '</h1>' +
    (doc.published ? '<p>Publicado em ' + doc.published + '</p>' : '') +
    (doc.created ? '<p>Criado em ' + doc.created + ' 11:02</p>' : '') +
    (doc.body ? '<p>' + doc.body + '</p>' : '') +
    (doc.file ? '<a href="' + fileUrl + '">' + (doc.filename ?? doc.title) + '</a>' : '') +
    (doc.links ?? []).map((link) => '<a href="' + link.href + '">' + link.text + '</a>').join(' ') +
    '<p>Compartilhe:</p>';
  return chrome(inner, content);
}

export function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function pdf(label: string, etag: string): Response {
  return new Response(new TextEncoder().encode('%PDF-1.7\n' + label), {
    status: 200,
    headers: { 'content-type': 'application/pdf', etag },
  });
}

export interface FakePortalOptions {
  listings: FakeListing[];
  documents: FakeDocument[];
  /** file label -> generation used in bytes; bump to simulate a real byte change. */
  fileGeneration?: Map<string, number>;
  /** file labels that currently fail with HTTP 500. */
  failingFiles?: Set<string>;
}

export interface FakePortalStats {
  documentPageFetches: number;
  listingFetches: number;
  fileDownloads: number;
  notModified: number;
}

export function fakePortal(options: FakePortalOptions): { fetch: typeof fetch; stats: FakePortalStats; reset(): void } {
  const stats: FakePortalStats = { documentPageFetches: 0, listingFetches: 0, fileDownloads: 0, notModified: 0 };
  const docs = new Map(options.documents.map((doc) => [doc.path, doc]));
  for (const doc of options.documents) DOC_TITLES.set(doc.path, doc.title);
  const listings = new Map(options.listings.map((listing) => [listing.path, listing]));

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (!url.pathname.startsWith('/sped/pt-br')) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    const path = url.pathname.slice('/sped/pt-br'.length).replace(/\/$/, '');

    const fileMatch = /^(.*)\/@@(?:display-file|download)\/file$/.exec(path);
    if (fileMatch) {
      const doc = docs.get(fileMatch[1]!);
      if (!doc?.file) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } });
      if (options.failingFiles?.has(doc.file)) {
        return new Response('upstream error', { status: 500, headers: { 'content-type': 'text/html' } });
      }
      const generation = options.fileGeneration?.get(doc.file) ?? 1;
      const etag = '"' + doc.file + '-g' + generation + '"';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === etag) {
        stats.notModified += 1;
        return new Response(null, { status: 304, headers: { etag } });
      }
      stats.fileDownloads += 1;
      return pdf(doc.file + '#' + generation, etag);
    }

    const doc = docs.get(path);
    if (doc) {
      stats.documentPageFetches += 1;
      return html(documentHtml(doc));
    }
    const listing = listings.get(path);
    if (listing) {
      stats.listingFetches += 1;
      return html(listingHtml(listing));
    }
    if (SEED_PATHS.includes(path)) {
      stats.listingFetches += 1;
      return html(listingHtml({ path, title: 'Seção', items: [] }));
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    stats,
    reset() {
      stats.documentPageFetches = 0;
      stats.listingFetches = 0;
      stats.fileDownloads = 0;
      stats.notModified = 0;
    },
  };
}

/** Realistic inventory reproducing the collision classes seen in production. */
export function productionLikeInventory(): { listings: FakeListing[]; documents: FakeDocument[] } {
  const icms = '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos';
  const reinf = '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos';
  const reinfCom = '/assuntos/comunicados/efd-reinf';
  const dere = '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos';
  const documents: FakeDocument[] = [
    { path: icms + '/guia-pratico-efd-versao-3-2-4.pdf', title: 'Guia Prático EFD - Versão 3.2.4.pdf', type: 'File', created: '03/09/2026', file: 'guia-324' },
    { path: icms + '/guia-pratico-efd-versao-3-2-3.pdf', title: 'Guia Prático da EFD ICMS IPI 3.2.3.pdf', type: 'File', created: '01/07/2026', file: 'guia-323' },
    { path: icms + '/guia-pratico-da-efd-icms-ipi-3-2.2', title: 'Guia Prático da EFD ICMS IPI 3.2.2', type: 'File', created: '01/03/2026', file: 'guia-322' },
    { path: icms + '/nt-2026-001-v1-0.pdf', title: 'Nota Técnica 2026.001 v1.0.pdf', type: 'File', created: '10/02/2026', file: 'nt-icms-2026-001' },
    { path: reinf + '/notas-tecnicas/1-2026', title: 'Nota técnica EFD-Reinf 1-2026', type: 'File', created: '02/06/2026', file: 'nt-reinf-01-2026' },
    {
      path: reinfCom + '/nota-tecnica-01-2026-ajustes-nos-leiautes-da-versao-2-1.2',
      title: 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2',
      type: 'Document',
      published: '25/03/2026',
      body: 'Tendo em vista a redução dos benefícios fiscais instituída pela Lei Complementar nº 224/2025.',
      links: [{ href: GOV + reinf + '/notas-tecnicas/1-2026/@@display-file/file', text: 'clique aqui' }],
    },
    { path: reinf + '/versao-atual/esquemas-xsd', title: 'Esquemas XSD', type: 'Document', published: '02/06/2026', body: 'Esquemas XSD da versão atual.' },
    { path: reinf + '/historico/esquemas-xsd', title: 'Esquemas XSD', type: 'Document', published: '02/06/2026', body: 'Histórico de esquemas XSD.' },
    { path: reinf + '/versao-atual/esquemas-xsd/xsd-eventos', title: 'Pacote XSD Eventos EFD Reinf v 2.1.2', type: 'File', created: '02/06/2026', file: 'xsd-reinf-212' },
    { path: reinf + '/versao-atual/esquemas-xsd/xsd-4010', title: 'XSD Evento R-4010', type: 'File', created: '02/06/2026', file: 'xsd-4010' },
    { path: reinf + '/versao-atual/manual-de-orientacao', title: 'Manual de Orientação do Usuário', type: 'File', created: '02/06/2026', file: 'manual-a' },
    { path: reinf + '/historico/manual-de-orientacao', title: 'Manual de Orientação do Usuário', type: 'File', created: '02/06/2025', file: 'manual-b' },
    { path: dere + '/versao-atual-1/02-leiautes-da-dere-eventos-v-1-2-0-2.pdf', title: '02-Leiautes da DeRE - Eventos (v.1.2.0)', type: 'File', created: '05/09/2026', file: 'dere-eventos-120' },
    // Mirror: the very same file published at a second official location.
    { path: dere + '/versoes-anteriores/02-leiautes-da-dere-eventos-v-1-2-0.pdf', title: '02-Leiautes da DeRE - Eventos (v.1.2.0)', type: 'File', created: '05/09/2026', file: 'dere-eventos-120', filename: 'leiautes-dere-eventos-anterior.pdf' },
  ];
  const listings: FakeListing[] = [
    { path: icms, title: 'Manuais e Documentos Técnicos', items: documents.filter((doc) => doc.path.startsWith(icms)).map((doc) => doc.path) },
    { path: reinf, title: 'Manuais e documentos técnicos', items: documents.filter((doc) => doc.path.startsWith(reinf)).map((doc) => doc.path) },
    { path: reinfCom, title: 'Comunicados EFD-Reinf', items: documents.filter((doc) => doc.path.startsWith(reinfCom)).map((doc) => doc.path) },
    {
      path: dere + '/versao-atual-1',
      title: 'Versão atual',
      items: documents.filter((doc) => doc.path.startsWith(dere + '/versao-atual-1/')).map((doc) => doc.path),
    },
    {
      path: dere + '/versoes-anteriores',
      title: 'Versões anteriores',
      items: documents.filter((doc) => doc.path.startsWith(dere + '/versoes-anteriores/')).map((doc) => doc.path),
    },
  ];
  return { listings, documents };
}
