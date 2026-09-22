import { createHash } from 'node:crypto';

import {
  descriptorFromPage,
  parseSpedPage,
} from '../modules/collection/sped.parser.js';
import type { SpedModule } from '../modules/collection/sped.parser.js';

const OFFICIAL = 'https://sped.rfb.gov.br';
const TRANSPORT = 'http://sped.rfb.gov.br';

const targets: Array<{ module: SpedModule; path: string; label: string }> = [
  { module: 'EFD_REINF', path: '/item/show/8116', label: 'REINF_NT_01_2026' },
  { module: 'EFD_REINF', path: '/item/show/8129', label: 'REINF_NT_01_2026_REPUBLICADA' },
  { module: 'EFD_CONTRIBUICOES', path: '/item/show/8126', label: 'CONTRIB_NT_12_2026' },
  { module: 'EFD_CONTRIBUICOES', path: '/arquivo/show/8016', label: 'CONTRIB_NT_11_2026_DOCUMENT' },
  { module: 'EFD_REINF', path: '/item/show/2270', label: 'REINF_XSD_INDEX' },
  { module: 'DERE', path: '/pagina/show/7950', label: 'DERE_OFFICIAL' },
  { module: 'DERE', path: '/pagina/show/8059', label: 'DERE_DRAFT_UPDATE' },
];

async function requestHttp(pathOrOfficialUrl: string, timeoutMs = 20_000): Promise<{
  status: number;
  finalOfficialUrl: string;
  response: Response;
}> {
  const initial = new URL(pathOrOfficialUrl, OFFICIAL);
  let current = TRANSPORT + initial.pathname + initial.search;
  const seen = new Set<string>();

  for (let i = 0; i < 7; i += 1) {
    if (seen.has(current)) throw new Error('REDIRECT_LOOP');
    seen.add(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'RadarFiscal-SPED-Gate-Validation/1.0',
        accept: '*/*',
      },
    });
    if (![301,302,303,307,308].includes(response.status)) {
      const u = new URL(current);
      return {
        status: response.status,
        finalOfficialUrl: OFFICIAL + u.pathname + u.search,
        response,
      };
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('REDIRECT_WITHOUT_LOCATION');
    const next = new URL(location, current);
    if (next.hostname.toLowerCase() !== 'sped.rfb.gov.br') {
      throw new Error('CROSS_ORIGIN:' + next.toString());
    }
    next.protocol = 'http:';
    current = next.toString();
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function inspect(module: SpedModule, path: string, label: string): Promise<void> {
  const result = await requestHttp(path);
  const html = await result.response.text();
  const page = parseSpedPage(html, result.finalOfficialUrl);
  const descriptor = descriptorFromPage(module, page);

  const technicalLinks = page.links
    .filter((link) =>
      /\/arquivo\/(?:show|download)\/\d+/i.test(link.path) ||
      /\/estatico\//i.test(link.path),
    )
    .slice(0, 20);

  console.error('SPED_GATE_PAGE=' + JSON.stringify({
    label,
    requestedPath: path,
    status: result.status,
    finalOfficialUrl: result.finalOfficialUrl,
    title: page.title,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    descriptor: descriptor
      ? {
          externalId: descriptor.externalId,
          kind: descriptor.kind,
          documentNumber: descriptor.documentNumber ?? null,
          officialVersion: descriptor.officialVersion ?? null,
          documentFamily: descriptor.documentFamily,
          revisionKind: descriptor.revisionKind,
          republication: descriptor.republication,
          documentStatus: descriptor.documentStatus,
          files: descriptor.files,
        }
      : null,
    technicalLinks,
  }));

  for (const link of technicalLinks.filter((link) => /\/arquivo\/show\/\d+/i.test(link.path)).slice(0, 4)) {
    try {
      const child = await requestHttp(link.url);
      const childHtml = await child.response.text();
      const childPage = parseSpedPage(childHtml, child.finalOfficialUrl);
      const childDescriptor = descriptorFromPage(module, childPage);
      console.error('SPED_GATE_CHILD=' + JSON.stringify({
        parent: label,
        url: child.finalOfficialUrl,
        title: childPage.title,
        descriptor: childDescriptor
          ? {
              externalId: childDescriptor.externalId,
              kind: childDescriptor.kind,
              documentNumber: childDescriptor.documentNumber ?? null,
              officialVersion: childDescriptor.officialVersion ?? null,
              documentFamily: childDescriptor.documentFamily,
              revisionKind: childDescriptor.revisionKind,
              republication: childDescriptor.republication,
              documentStatus: childDescriptor.documentStatus,
              files: childDescriptor.files,
            }
          : null,
      }));
    } catch (error) {
      console.error('SPED_GATE_CHILD_ERROR=' + JSON.stringify({
        parent: label,
        url: link.url,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  for (const link of technicalLinks.filter((link) =>
    /\/arquivo\/download\/\d+/i.test(link.path) || /\/estatico\//i.test(link.path),
  ).slice(0, 2)) {
    try {
      const file = await requestHttp(link.url, 60_000);
      const bytes = new Uint8Array(await file.response.arrayBuffer());
      console.error('SPED_GATE_FILE=' + JSON.stringify({
        parent: label,
        url: file.finalOfficialUrl,
        status: file.status,
        contentType: file.response.headers.get('content-type'),
        sizeBytes: bytes.byteLength,
        rawSha256: createHash('sha256').update(bytes).digest('hex'),
      }));
    } catch (error) {
      console.error('SPED_GATE_FILE_ERROR=' + JSON.stringify({
        parent: label,
        url: link.url,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

console.error('SPED_GATE_DIAG_START=' + new Date().toISOString());
for (const target of targets) {
  try {
    await inspect(target.module, target.path, target.label);
  } catch (error) {
    console.error('SPED_GATE_PAGE_ERROR=' + JSON.stringify({
      label: target.label,
      path: target.path,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
console.error('SPED_GATE_DIAG_DONE=' + new Date().toISOString());
