import { createHash } from 'node:crypto';
import {
  descriptorFromPage,
  parseSpedPage,
  type SpedModule,
} from '../modules/collection/sped.parser.js';

const OFFICIAL = 'https://sped.rfb.gov.br';
const TRANSPORT = 'http://sped.rfb.gov.br';

const targets: Array<{
  gate: string;
  module: SpedModule;
  path: string;
}> = [
  { gate: 'GUIDE_3_2_1', module: 'EFD_ICMS_IPI', path: '/item/show/7900' },
  { gate: 'GUIDE_3_2_2', module: 'EFD_ICMS_IPI', path: '/item/show/8112' },
  { gate: 'REINF_NT_01_2026', module: 'EFD_REINF', path: '/item/show/8116' },
  { gate: 'REINF_NT_01_2026_REPUBLICADA', module: 'EFD_REINF', path: '/item/show/8129' },
  { gate: 'CONTRIB_NT_11_2026', module: 'EFD_CONTRIBUICOES', path: '/arquivo/show/8016' },
  { gate: 'CONTRIB_NT_12_2026', module: 'EFD_CONTRIBUICOES', path: '/item/show/8126' },
  { gate: 'REINF_XSD', module: 'EFD_REINF', path: '/item/show/2270' },
  { gate: 'DERE', module: 'DERE', path: '/item/show/7950' },
  { gate: 'REINF_REPUBLICADA_FILE_PAGE', module: 'EFD_REINF', path: '/arquivo/show/8070' },
  { gate: 'REINF_XSD_CURRENT_FILE', module: 'EFD_REINF', path: '/item/show/8193' },
  { gate: 'DERE_PROJECT', module: 'DERE', path: '/projeto/show/2918' },
];

async function request(pathOrUrl: string, timeoutMs = 30_000): Promise<{
  response: Response;
  officialUrl: string;
  transportUrl: string;
  redirects: Array<{ from: string; status: number; location: string }>;
}> {
  let current = pathOrUrl.startsWith('http')
    ? TRANSPORT + new URL(pathOrUrl).pathname + new URL(pathOrUrl).search
    : TRANSPORT + pathOrUrl;
  const redirects: Array<{ from: string; status: number; location: string }> = [];
  const seen = new Set<string>();

  for (let count = 0; count <= 8; count += 1) {
    if (seen.has(current)) throw new Error('REDIRECT_LOOP');
    seen.add(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'RadarFiscal-SPED-Targeted-Validation/1.0',
        accept: '*/*',
      },
    });

    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      const parsed = new URL(current);
      return {
        response,
        officialUrl: OFFICIAL + parsed.pathname + parsed.search,
        transportUrl: current,
        redirects,
      };
    }

    redirects.push({ from: current, status: response.status, location });
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.hostname.toLowerCase() !== 'sped.rfb.gov.br') {
      throw new Error('CROSS_ORIGIN_REDIRECT:' + next.toString());
    }
    next.protocol = 'http:';
    current = next.toString();
  }

  throw new Error('TOO_MANY_REDIRECTS');
}

function htmlFileLinks(html: string): string[] {
  return [...html.matchAll(/href=["']([^"']*(?:\/arquivo\/download\/\d+|\/estatico\/[^"']+))["']/gi)]
    .map((match) => new URL(match[1]!, OFFICIAL).toString())
    .filter((value, index, values) => values.indexOf(value) === index);
}

for (const target of targets) {
  try {
    const pageResult = await request(target.path);
    const html = await pageResult.response.text();
    const page = parseSpedPage(html, pageResult.officialUrl);
    const descriptor = descriptorFromPage(target.module, page);
    const fallbackFiles = htmlFileLinks(html);
    const files = descriptor?.files.map((file) => file.url) ?? fallbackFiles;
    let sample: unknown = null;

    if (files[0]) {
      try {
        const fileResult = await request(files[0], 60_000);
        const bytes = new Uint8Array(await fileResult.response.arrayBuffer());
        sample = {
          status: fileResult.response.status,
          officialUrl: fileResult.officialUrl,
          transportUrl: fileResult.transportUrl,
          redirects: fileResult.redirects,
          sizeBytes: bytes.byteLength,
          rawSha256: createHash('sha256').update(bytes).digest('hex'),
          contentType: fileResult.response.headers.get('content-type'),
          disposition: fileResult.response.headers.get('content-disposition'),
          headHex: Buffer.from(bytes.subarray(0, 8)).toString('hex'),
        };
      } catch (error) {
        sample = { error: error instanceof Error ? error.message : String(error) };
      }
    }

    console.log('SPED_GATE=' + JSON.stringify({
      gate: target.gate,
      pageStatus: pageResult.response.status,
      officialUrl: pageResult.officialUrl,
      transportUrl: pageResult.transportUrl,
      redirects: pageResult.redirects,
      bytes: Buffer.byteLength(html),
      pageDebug: descriptor ? null : {
        title: page.title,
        headings: page.headings,
        textHead: page.text.slice(0, 1200),
        links: page.links.filter((link) =>
          /download|dere|manual|leiaute|layout|xsd|schema|arquivo|pasta|nota|orienta/i.test(link.text + ' ' + link.path)
        ).slice(0, 120),
        fileLinks: page.fileLinks,
      },
      descriptor: descriptor ? {
        title: descriptor.title,
        externalId: descriptor.externalId,
        module: descriptor.module,
        kind: descriptor.kind,
        officialVersion: descriptor.officialVersion ?? null,
        documentNumber: descriptor.documentNumber ?? null,
        documentFamily: descriptor.documentFamily,
        revisionKind: descriptor.revisionKind,
        republication: descriptor.republication,
        publishedAt: descriptor.publishedAt?.toISOString() ?? null,
        fileCount: descriptor.files.length,
        files: descriptor.files,
      } : null,
      fallbackFiles,
      sample,
    }));
  } catch (error) {
    console.log('SPED_GATE=' + JSON.stringify({
      gate: target.gate,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
