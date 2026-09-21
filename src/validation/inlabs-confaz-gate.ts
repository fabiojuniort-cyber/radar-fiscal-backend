import { InlabsClient } from '../modules/collection/inlabs.client.js';
import { parseDouEntries, readDouZip } from '../modules/collection/dou.parser.js';

const targets = [
  { date: '2026-07-06', family: 'PROTOCOLO ICMS', pattern: /PROTOCOLO ICMS/i },
  { date: '2026-07-08', family: 'CONVÊNIO ICMS', pattern: /CONVÊNIO ICMS/i },
  { date: '2026-07-09', family: 'AJUSTE SINIEF', pattern: /AJUSTE SINIEF/i },
] as const;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180_000);

const client = new InlabsClient({
  credentials: () => ({
    email: process.env.INLABS_EMAIL ?? '',
    password: process.env.INLABS_PASSWORD ?? '',
  }),
});

try {
  await client.login(controller.signal);

  const summary: Record<string, number> = {};

  for (const target of targets) {
    const download = await client.downloadXml(target.date, 'DO1', controller.signal);

    if (download.status !== 'AVAILABLE') {
      console.log(JSON.stringify({
        stage: 'target',
        date: target.date,
        family: target.family,
        status: download.status,
      }));
      summary[target.family] = 0;
      continue;
    }

    const zip = await readDouZip(download.bytes, controller.signal);
    const parsed = parseDouEntries(zip.entries, {
      filename: download.filename,
      date: target.date,
      section: 'DO1',
      officialUrl: download.officialUrl,
      rawSha256: download.rawSha256,
    });

    const hits = parsed.publications.filter(publication =>
      target.pattern.test(publication.title)
    );

    summary[target.family] = hits.length;

    console.log(JSON.stringify({
      stage: 'target',
      date: target.date,
      family: target.family,
      status: 'AVAILABLE',
      zipBytes: download.bytes.byteLength,
      xmlCount: zip.entries.length,
      matterCount: parsed.publications.length,
      parseFailures: parsed.partialFailures.length,
      hits: hits.map(publication => ({
        title: publication.title,
        agency: publication.agency,
        actType: publication.actType,
        actNumber: publication.actNumber ?? null,
        publishedAt: publication.publishedAt?.toISOString().slice(0, 10) ?? null,
        officialUrl: publication.officialUrl,
        externalId: publication.externalId,
      })),
    }));
  }

  const gatePassed = targets.every(target => (summary[target.family] ?? 0) > 0);

  console.log(JSON.stringify({
    stage: 'summary',
    families: summary,
    gatePassed,
  }));

  if (!gatePassed) process.exitCode = 2;
} catch (error) {
  const value = error as {
    name?: unknown;
    code?: unknown;
    kind?: unknown;
    httpStatus?: unknown;
    retryable?: unknown;
    message?: unknown;
  };

  console.error(JSON.stringify({
    stage: 'error',
    ok: false,
    name: value?.name,
    code: value?.code,
    kind: value?.kind,
    httpStatus: value?.httpStatus,
    retryable: value?.retryable,
    message: value?.message,
  }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  client.close();
}
