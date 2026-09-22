const URLS = [
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos',
  'https://www.gov.br/sped/pt-br/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1',
];

function compact(value: unknown, limit = 8000): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function extractHydration(html: string): unknown {
  const marker = 'window.__data=';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('window.__data not found');
  const expressionStart = start + marker.length;
  const scriptEnd = html.indexOf('</script>', expressionStart);
  if (scriptEnd < 0) throw new Error('window.__data script end not found');
  let expression = html.slice(expressionStart, scriptEnd).trim();
  if (expression.endsWith(';')) expression = expression.slice(0, -1);
  return Function('"use strict"; return (' + expression + ')')();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function interestingStrings(root: unknown): string[] {
  const out = new Set<string>();
  const seen = new WeakSet<object>();

  function walk(value: unknown): void {
    if (typeof value === 'string') {
      if (
        /@search|@@display-file|@@download|sped\.rfb\.gov\.br|\/sped\/pt-br\/|listing|querystring|resolveuid/i.test(value)
      ) out.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/href|url|endpoint|query|stringquery|path|uid|id|listing|search/i.test(key)) {
        const printed = compact(child, 1800);
        if (printed && printed !== 'undefined') out.add(key + '=' + printed);
      }
      walk(child);
    }
  }

  walk(root);
  return [...out];
}

function findInterestingObjects(root: unknown): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  const seen = new WeakSet<object>();

  function walk(value: unknown, path: string, depth: number): void {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      const first = value[0];
      if (
        value.length > 0 &&
        record(first) &&
        Object.keys(record(first)!).some((key) => /@id|title|href|url|items|results/i.test(key))
      ) {
        out.push({ path, value: value.slice(0, 5) });
      }
      value.forEach((child, index) => walk(child, path + '[' + index + ']', depth + 1));
      return;
    }

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const type = typeof obj['@type'] === 'string' ? obj['@type'] as string : '';
    const keyText = keys.join(' ');
    const serialized = compact(obj, 4000);

    if (
      /listing|query|search|batch|result/i.test(type + ' ' + keyText) ||
      /@search|querystring|Carregando|@@display-file|@@download|sped\.rfb\.gov\.br/i.test(serialized)
    ) {
      out.push({ path, value: obj });
    }

    for (const [key, child] of Object.entries(obj)) {
      walk(child, path ? path + '.' + key : key, depth + 1);
    }
  }

  walk(root, '$', 0);
  return out;
}

for (const url of URLS) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
      },
    });
    const html = await response.text();
    console.log('GOVBR_PAGE=' + compact({
      url,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type'),
      size: Buffer.byteLength(html),
    }));

    const hydration = extractHydration(html);
    const root = record(hydration) ?? {};
    const content = record(root.content);
    console.log('GOVBR_TOP=' + compact({
      url,
      topKeys: Object.keys(root),
      contentKeys: content ? Object.keys(content) : [],
      contentId: content?.['@id'],
      contentType: content?.['@type'],
      title: content?.title,
      created: content?.created,
      modified: content?.modified,
      effective: content?.effective,
      blocksLayout: content?.blocks_layout,
    }, 12000));

    const blocks = record(content?.blocks);
    if (blocks) {
      for (const [id, value] of Object.entries(blocks)) {
        const block = record(value);
        console.log('GOVBR_BLOCK=' + compact({
          url,
          id,
          type: block?.['@type'],
          keys: block ? Object.keys(block) : [],
          value: block,
        }, 16000));
      }
    }

    const objects = findInterestingObjects(hydration).slice(0, 120);
    for (const item of objects) {
      console.log('GOVBR_OBJECT=' + compact({
        url,
        path: item.path,
        value: item.value,
      }, 10000));
    }

    const strings = interestingStrings(hydration).slice(0, 250);
    for (const value of strings) {
      console.log('GOVBR_STRING=' + compact({ url, value }, 5000));
    }
  } catch (error) {
    console.error('GOVBR_ERROR=' + compact({
      url,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }));
  }
}
