import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfazConnector,
  classifyConfazNetworkFailure,
  extractConfazIndexLinks,
  parseConfazPublicationHtml,
} from '../src/modules/collection/confaz.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';

const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

function page(title: string, body: string): string {
  return `<!doctype html><html><body>
<h1>${title}</h1><div id="content-core">${body}</div>
<footer>Desenvolvido com o CMS Plone</footer></body></html>`;
}

const protocolo88 = page(
  'PROTOCOLO ICMS 88/26',
  `<p>Revoga o Protocolo ICMS nº 100, de 14 de dezembro de 2007, que dispõe sobre a substituição tributária nas operações com rações tipo "pet".</p>
<p>PROTOCOLO ICMS Nº 88, DE 27 DE JULHO DE 2026</p>
<p>Publicado no DOU de 29.07.26 (Edição Extra), pelo <a href="/legislacao/despacho/2026/DP034_26">Despacho 34/26</a>.</p>
<p>Os Estados de Rio Grande do Sul e São Paulo resolvem celebrar o seguinte PROTOCOLO.</p>
<p>Cláusula primeira O Protocolo ICMS nº 100 fica revogado.</p>
<p>Cláusula segunda Este protocolo entra em vigor na data da sua publicação no Diário Oficial da União, produzindo efeitos a partir de 1º de agosto de 2026.</p>`,
);

test('discovers official annual-index links and correction variants', () => {
  const links = extractConfazIndexLinks(
    `<a href="/legislacao/protocolos/2026/pt088_26">PROTOCOLO ICMS 88/26</a>
<a href="/legislacao/protocolos/2026/protocolo-icms-89-26-retificacao">PROTOCOLO ICMS 89/26 - RETIFICAÇÃO</a>
<a href="https://example.test/x">PROTOCOLO ICMS 90/26</a>`,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/2026',
    'protocolos',
    2026,
  );

  assert.equal(links.length, 2);
  assert.equal(links[0]?.actNumber, 89);
  assert.equal(links[0]?.variant, 'RETIFICACAO');
  assert.equal(
    links[1]?.url,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26',
  );
});

test('parses official act identity, dates, text, DOU and explicit UF mentions', () => {
  const publication = parseConfazPublicationHtml(
    protocolo88,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26',
    'protocolos',
  );

  assert.equal(publication.agency, 'CONFAZ');
  assert.equal(publication.sphere, 'FEDERAL');
  assert.equal(publication.actType, 'PROTOCOLO ICMS');
  assert.equal(publication.actNumber, '88/2026');
  assert.equal(publication.publishedAt?.toISOString().slice(0, 10), '2026-07-29');
  assert.equal(publication.effectiveAt?.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(publication.metadata?.actDate, '2026-07-27');
  assert.deepEqual(publication.metadata?.explicitUfMentions, ['RS', 'SP']);
  assert.match(publication.content ?? '', /Cláusula primeira/);
});

test('does not treat CONFAZ signatory states as explicit normative UF mentions', () => {
  const html = page(
    'CONVÊNIO ICMS 108/26',
    `<p>Altera regra nacional sobre combustíveis.</p>
<p>CONVÊNIO ICMS Nº 108, DE 4 DE SETEMBRO DE 2026</p>
<p>Publicado no DOU de 09.09.2026.</p>
<p>Cláusula primeira Fica alterada a regra nacional.</p>
<p>Cláusula segunda Este convênio entra em vigor na data da sua publicação no Diário Oficial da União.</p>
<p>Presidente do CONFAZ – Nome, Acre – Pessoa A, Bahia – Pessoa B, Goiás – Pessoa C, São Paulo – Pessoa D.</p>`,
  );

  const publication = parseConfazPublicationHtml(
    html,
    'https://www.confaz.fazenda.gov.br/legislacao/convenios/2026/convenio-icms-108-26',
    'convenios',
  );

  assert.equal(publication.metadata?.actDate, '2026-09-04');
  assert.equal(publication.metadata?.explicitUfMentions, undefined);
});

test('parses COTEPE wording "Publicação no DOU" with strong act identity fields', () => {
  const html = page(
    'ATO COTEPE/ICMS 86/26',
    `<p>Altera o Ato COTEPE/ICMS nº 44, de 7 de agosto de 2018, que dispõe sobre a Escrituração Fiscal Digital.</p>
<p>ATO COTEPE/ICMS Nº 86, DE 9 DE SETEMBRO DE 2026</p>
<p>Publicação no DOU de 10.09.26.</p>
<p>Art. 1º O Ato COTEPE/ICMS nº 44 passa a vigorar com nova redação.</p>
<p>Art. 2º Este ato entra em vigor na data da sua publicação no Diário Oficial da União.</p>`,
  );

  const publication = parseConfazPublicationHtml(
    html,
    'https://www.confaz.fazenda.gov.br/legislacao/atos/2026/ato-cotepe-icms-86-26',
    'atos',
  );

  assert.equal(publication.actType, 'ATO COTEPE/ICMS');
  assert.equal(publication.actNumber, '86/2026');
  assert.equal(publication.metadata?.actDate, '2026-09-09');
  assert.equal(publication.publishedAt?.toISOString().slice(0, 10), '2026-09-10');
  assert.equal(publication.effectiveAt?.toISOString().slice(0, 10), '2026-09-10');

  const normalized = normalizePublication({ sourceId: SOURCE_ID, publication });
  assert.equal(normalized.identityStrength, 'STRONG');
});

test('parses ratification and uses it for effective date when official text says so', () => {
  const html = page(
    'CONVÊNIO ICMS 153/20',
    `<p>Altera o Convênio ICMS 103/20 e dispõe sobre crédito presumido.</p>
<p>CONVÊNIO ICMS 153/20, DE 09 DE DEZEMBRO DE 2020.</p>
<p>Publicado no DOU de 11.12.20, pelo Despacho 96/20.</p>
<p>Ratificação Nacional no DOU de 29.12.20, pelo Ato Declaratório 24/20.</p>
<p>Cláusula segunda Este convênio entra em vigor na data da publicação no Diário Oficial da União de sua ratificação nacional.</p>`,
  );

  const publication = parseConfazPublicationHtml(
    html,
    'https://www.confaz.fazenda.gov.br/legislacao/convenios/2020/CV153_20',
    'convenios',
  );

  assert.equal(publication.actNumber, '153/2020');
  assert.equal(publication.publishedAt?.toISOString().slice(0, 10), '2020-12-11');
  assert.equal(publication.effectiveAt?.toISOString().slice(0, 10), '2020-12-29');
  assert.deepEqual(publication.metadata?.ratification, {
    publicationDate: '2020-12-29',
    reference: '24/20',
  });
});

test('keeps retification as a distinct source document', () => {
  const html = page(
    'PROTOCOLO ICMS 89/26 - RETIFICAÇÃO',
    `<p>Exclui o Estado de São Paulo do Protocolo ICM nº 16.</p>
<p>RETIFICAÇÃO</p><p>Publicado no DOU de 14.09.2026</p>
<p>No título do Protocolo ICMS nº 89, onde se lê 2025; leia-se 2026.</p>`,
  );

  const publication = parseConfazPublicationHtml(
    html,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/protocolo-icms-89-26-retificacao',
    'protocolos',
    'RETIFICACAO',
  );

  assert.equal(publication.actType, 'RETIFICAÇÃO DE PROTOCOLO ICMS');
  assert.equal(publication.actNumber, '89/2026');
  assert.equal(publication.publishedAt?.toISOString().slice(0, 10), '2026-09-14');
});

test('same official identity deduplicates and changed content creates a new version hash', () => {
  const publication = parseConfazPublicationHtml(
    protocolo88,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26',
    'protocolos',
  );
  const first = normalizePublication({ sourceId: SOURCE_ID, publication });
  const second = normalizePublication({ sourceId: SOURCE_ID, publication });
  const changed = normalizePublication({
    sourceId: SOURCE_ID,
    publication: {
      ...publication,
      content: `${publication.content}\nAlteração oficial posterior.`,
    },
  });

  assert.equal(first.identityHash, second.identityHash);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.identityHash, changed.identityHash);
  assert.notEqual(first.contentHash, changed.contentHash);
});

test('incremental mode fetches only URLs above the configured baseline', async () => {
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    requested.push(url);

    if (url.endsWith('/legislacao/protocolos/2026/2026')) {
      return new Response(
        '<a href="/legislacao/protocolos/2026/pt087_26">PROTOCOLO ICMS 87/26</a>' +
        '<a href="/legislacao/protocolos/2026/pt088_26">PROTOCOLO ICMS 88/26</a>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    if (url.endsWith('/pt088_26')) {
      return new Response(protocolo88, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('<html><body><h1>2026</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  const connector = new ConfazConnector({
    fetchImpl: fakeFetch,
    readSourceState: async () => ({
      connectorConfig: {
        confaz: {
          incrementalBaselines: {
            convenios: { '2026': 999 },
            ajustes: { '2026': 999 },
            atos: { '2026': 999 },
            protocolos: { '2026': 87 },
          },
        },
      },
      knownOrigins: [],
    }),
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  const result = await connector.collect({
    sourceId: SOURCE_ID,
    runId: '44444444-4444-4444-8444-444444444444',
    attemptId: '55555555-5555-4555-8555-555555555555',
    signal: new AbortController().signal,
  });

  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0]?.actNumber, '88/2026');
  assert.equal(requested.some((url) => url.endsWith('/pt087_26')), false);
  assert.equal(result.metadata?.indexesSucceeded, 4);
});

test('incremental mode discovers a new normal act after bootstrap without manual baseline', async () => {
  const requested: string[] = [];
  const knownUrl = 'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26';

  const fakeFetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    requested.push(url);

    if (url.endsWith('/legislacao/protocolos/2026/2026')) {
      return new Response(
        '<a href="/legislacao/protocolos/2026/pt088_26">PROTOCOLO ICMS 88/26</a>' +
        '<a href="/legislacao/protocolos/2026/pt089_26">PROTOCOLO ICMS 89/26</a>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    if (url.endsWith('/pt089_26')) {
      return new Response(
        page(
          'PROTOCOLO ICMS 89/26',
          `<p>Altera norma anterior.</p>
<p>PROTOCOLO ICMS Nº 89, DE 1º DE AGOSTO DE 2026</p>
<p>Publicado no DOU de 03.08.26.</p>
<p>Cláusula primeira Fica alterada a norma.</p>`,
        ),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    return new Response('<html><body><h1>2026</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  const connector = new ConfazConnector({
    fetchImpl: fakeFetch,
    readSourceState: async () => ({
      connectorConfig: {},
      knownOrigins: [{ officialUrl: knownUrl, lastSeenAt: new Date('2026-08-01T00:00:00Z') }],
    }),
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  const result = await connector.collect({
    sourceId: SOURCE_ID,
    runId: '44444444-4444-4444-8444-444444444444',
    attemptId: '55555555-5555-4555-8555-555555555555',
    signal: new AbortController().signal,
  });

  assert.equal(result.publications.some((publication) => publication.actNumber === '89/2026'), true);
  assert.equal(requested.some((url) => url.endsWith('/pt089_26')), true);
});

test('all unavailable indexes produce a retryable source failure', async () => {
  const connector = new ConfazConnector({
    fetchImpl: (async () => new Response('unavailable', {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch,
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  await assert.rejects(
    () => connector.collect({
      sourceId: SOURCE_ID,
      runId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFAZ_ALL_INDEXES_FAILED');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});


test('network failures preserve the underlying fetch cause for production diagnostics', async () => {
  const connector = new ConfazConnector({
    fetchImpl: (async () => {
      const cause = Object.assign(new Error('Connect Timeout Error'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      });
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch,
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  await assert.rejects(
    () => connector.collect({
      sourceId: SOURCE_ID,
      runId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /UND_ERR_CONNECT_TIMEOUT/);
      assert.match(message, /Connect Timeout Error/);
      return true;
    },
  );
});

function connectTimeoutFetch(requested: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    requested.push(input.toString());
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    throw new TypeError('fetch failed', { cause });
  }) as typeof fetch;
}

test('an unreachable host short-circuits the attempt after the first index', async () => {
  const requested: string[] = [];
  const connector = new ConfazConnector({
    fetchImpl: connectTimeoutFetch(requested),
    now: () => new Date('2026-01-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  await assert.rejects(
    () => connector.collect({
      sourceId: SOURCE_ID,
      runId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      const connectorError = error as {
        code?: string;
        kind?: string;
        retryable?: boolean;
        metadata?: Record<string, unknown>;
      };
      assert.equal(connectorError.code, 'CONFAZ_HOST_UNREACHABLE');
      assert.equal(connectorError.kind, 'SOURCE_UNAVAILABLE');
      assert.equal(connectorError.retryable, true);
      assert.equal(connectorError.metadata?.failureClass, 'TCP_CONNECT_TIMEOUT');
      assert.equal(connectorError.metadata?.route, 'DIRECT');
      assert.equal(connectorError.metadata?.sourceConsulted, false);
      // January: current and previous year, four families each.
      assert.equal(connectorError.metadata?.indexesPlanned, 8);
      assert.equal(connectorError.metadata?.indexesAttempted, 1);
      return true;
    },
  );

  assert.equal(requested.length, 1);
});

test('HTTP-level index failures do not short-circuit and keep per-index diagnostics', async () => {
  const requested: string[] = [];
  const connector = new ConfazConnector({
    fetchImpl: (async (input: string | URL | Request) => {
      requested.push(input.toString());
      return new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch,
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  await assert.rejects(
    () => connector.collect({
      sourceId: SOURCE_ID,
      runId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      const connectorError = error as { code?: string; metadata?: Record<string, unknown> };
      assert.equal(connectorError.code, 'CONFAZ_ALL_INDEXES_FAILED');
      assert.equal(connectorError.metadata?.sourceConsulted, false);
      assert.equal(connectorError.metadata?.indexFailureCount, 4);
      return true;
    },
  );

  assert.equal(requested.length, 4);
});

test('an unreachable detail page after a reachable index stays a partial failure', async () => {
  const connector = new ConfazConnector({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('/legislacao/protocolos/2026/2026')) {
        return new Response(
          '<a href="/legislacao/protocolos/2026/pt088_26">PROTOCOLO ICMS 88/26</a>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (url.endsWith('/pt088_26')) {
        const cause = Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        });
        throw new TypeError('fetch failed', { cause });
      }
      return new Response('<html><body><h1>2026</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch,
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  });

  const result = await connector.collect({
    sourceId: SOURCE_ID,
    runId: '44444444-4444-4444-8444-444444444444',
    attemptId: '55555555-5555-4555-8555-555555555555',
    signal: new AbortController().signal,
  });

  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures?.length, 1);
  assert.match(result.partialFailures?.[0]?.message ?? '', /TCP_CONNECT_TIMEOUT/);
  assert.equal(result.metadata?.sourceConsulted, true);
  assert.equal(result.metadata?.route, 'DIRECT');
});

test('classifies transport failures without collapsing them into one bucket', () => {
  const wrap = (code: string) =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

  assert.equal(classifyConfazNetworkFailure(wrap('ENOTFOUND')), 'DNS_FAILURE');
  assert.equal(classifyConfazNetworkFailure(wrap('UND_ERR_CONNECT_TIMEOUT')), 'TCP_CONNECT_TIMEOUT');
  assert.equal(classifyConfazNetworkFailure(wrap('ECONNREFUSED')), 'CONNECTION_REFUSED');
  assert.equal(classifyConfazNetworkFailure(wrap('EHOSTUNREACH')), 'NETWORK_UNREACHABLE');
  assert.equal(classifyConfazNetworkFailure(wrap('CERT_HAS_EXPIRED')), 'TLS_FAILURE');
  assert.equal(classifyConfazNetworkFailure(wrap('ECONNRESET')), 'CONNECTION_RESET');
  assert.equal(classifyConfazNetworkFailure(wrap('UND_ERR_HEADERS_TIMEOUT')), 'RESPONSE_TIMEOUT');
  assert.equal(classifyConfazNetworkFailure(new Error('boom')), 'UNKNOWN_NETWORK_ERROR');
});

test('DOU (PRIMARY) and portal (ENRICHMENT) parses of the same act share one global identity', async () => {
  const { extractEmbeddedConfazPublications } = await import('../src/modules/collection/dou.parser.js');
  const [fromDou] = extractEmbeddedConfazPublications({
    title: 'DESPACHO Nº 34, DE 28 DE JULHO DE 2026',
    agency: 'CONFAZ',
    sphere: 'FEDERAL',
    actType: 'DESPACHO',
    actNumber: '34/2026',
    publishedAt: new Date('2026-07-29T00:00:00Z'),
    content: [
      'O Secretário Executivo do CONFAZ torna público:',
      'PROTOCOLO ICMS Nº 88, DE 27 DE JULHO DE 2026',
      'Cláusula primeira O Protocolo ICMS nº 100 fica revogado.',
    ].join('\n'),
    officialUrl: 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=29/07/2026&jornal=600&pagina=1',
    externalId: '2026-07-29:DO1E:143-A:123456',
    metadata: { dou: { publicationDate: '2026-07-29', section: 'DO1E' } },
  });
  assert.ok(fromDou);

  const fromPortal = parseConfazPublicationHtml(
    protocolo88,
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26',
    'protocolos',
  );

  const dou = normalizePublication({ sourceId: '11111111-1111-4111-8111-111111111111', publication: fromDou });
  const portal = normalizePublication({ sourceId: SOURCE_ID, publication: fromPortal });

  assert.equal(dou.identityStrength, 'STRONG');
  assert.equal(portal.identityStrength, 'STRONG');
  assert.equal(dou.identityHash, portal.identityHash);

  const correction = parseConfazPublicationHtml(
    protocolo88.replace('<h1>PROTOCOLO ICMS 88/26</h1>', '<h1>PROTOCOLO ICMS 88/26 - RETIFICAÇÃO</h1>'),
    'https://www.confaz.fazenda.gov.br/legislacao/protocolos/2026/pt088_26-retificacao',
    'protocolos',
  );
  const normalizedCorrection = normalizePublication({ sourceId: SOURCE_ID, publication: correction });
  assert.notEqual(normalizedCorrection.identityHash, portal.identityHash);
});
