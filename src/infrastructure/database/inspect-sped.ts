import 'dotenv/config';

const pages = [
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1',
] as const;

function around(text: string, needle: string, radius = 900): string[] {
  const lower = text.toLocaleLowerCase('pt-BR');
  const target = needle.toLocaleLowerCase('pt-BR');
  const out: string[] = [];
  let from = 0;
  while (out.length < 8) {
    const at = lower.indexOf(target, from);
    if (at < 0) break;
    out.push(
      text
        .slice(Math.max(0, at - radius), Math.min(text.length, at + target.length + radius))
        .replace(/\s+/g, ' ')
        .trim(),
    );
    from = at + target.length;
  }
  return out;
}

for (const url of pages) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
      },
    });
    const html = await response.text();
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) =>
      new URL(match[1]!, response.url).toString(),
    );
    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => {
        try {
          return new URL(match[1]!, response.url).toString();
        } catch {
          return undefined;
        }
      })
      .filter((value): value is string => Boolean(value))
      .filter((value) =>
        /display-file|download|document|tecnic|manual|nota|xsd|zip|pdf|search|listing|collection|api|query|batch/i.test(value),
      );

    const probes = [
      'Carregando',
      '@@',
      '@search',
      'search',
      'listing',
      'collection',
      'faceted',
      'ajax',
      'data-',
      'api',
      'Query',
      'b_size',
      'batch',
      'UID',
    ];

    console.log('SPED_GOVBR_PAGE=' + JSON.stringify({
      requestedUrl: url,
      finalUrl: response.url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: html.length,
      scripts,
      interestingHrefs: [...new Set(hrefs)].slice(0, 200),
      snippets: Object.fromEntries(
        probes
          .map((probe) => [probe, around(html, probe)])
          .filter(([, values]) => (values as string[]).length > 0),
      ),
    }));
  } catch (error) {
    console.error('SPED_GOVBR_ERROR=' + JSON.stringify({
      url,
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error && 'cause' in error ? String(error.cause) : undefined,
    }));
  }
}
