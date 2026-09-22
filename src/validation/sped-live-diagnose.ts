import { Parser } from 'htmlparser2';

const ORIGIN = 'https://sped.rfb.gov.br';
const roots = [
  ['HOME', '/'],
  ['EFD_ICMS_IPI', '/item/show/274'],
  ['EFD_CONTRIBUICOES', '/item/show/268'],
  ['EFD_REINF', '/item/show/1196'],
  ['DERE_NEWS', '/item/show/7950'],
] as const;

interface LinkInfo {
  href: string;
  text: string;
}

async function fetchHtml(path: string): Promise<{ url: string; html: string; status: number; contentType: string }> {
  const response = await fetch(new URL(path, ORIGIN), {
    redirect: 'follow',
    headers: {
      'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.5',
    },
  });
  const html = await response.text();
  return {
    url: response.url,
    html,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  };
}

function extractLinks(html: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  let current: { href: string; text: string } | undefined;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name.toLowerCase() === 'a' && attrs.href) {
        current = { href: attrs.href, text: '' };
      }
    },
    ontext(text) {
      if (current) current.text += text;
    },
    onclosetag(name) {
      if (name.toLowerCase() === 'a' && current) {
        const text = current.text.replace(/\s+/g, ' ').trim();
        try {
          const url = new URL(current.href, ORIGIN);
          if (url.origin === ORIGIN) links.push({ href: url.pathname + url.search, text });
        } catch {}
        current = undefined;
      }
    },
  }, { decodeEntities: true });
  parser.end(html);
  return links;
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const k = key(value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const keyword = /(guia|manual|nota|orienta|leiaute|layout|xsd|schema|tabela|validador|pva|pge|download|destaque|dere|regimes espec|arquivo)/i;

const output: Record<string, unknown> = {};
for (const [name, path] of roots) {
  try {
    const page = await fetchHtml(path);
    const links = unique(extractLinks(page.html), link => `${link.href}|${link.text}`);
    output[name] = {
      status: page.status,
      finalUrl: page.url,
      bytes: Buffer.byteLength(page.html),
      contentType: page.contentType,
      itemShowLinks: links.filter(link => /\/item\/show\/\d+/.test(link.href) && keyword.test(link.text)).slice(0, 120),
      archiveLinks: links.filter(link => /\/arquivo\/(?:show|download)\/\d+/.test(link.href)).slice(0, 80),
      destaqueLinks: links.filter(link => /\/destaques\/show\/\d+/.test(link.href)).slice(0, 40),
      interestingLinks: links.filter(link => keyword.test(link.text) || keyword.test(link.href)).slice(0, 160),
    };
  } catch (error) {
    output[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}

console.log('SPED_LIVE_DIAG=' + JSON.stringify({ generatedAt: new Date().toISOString(), ...output }));
