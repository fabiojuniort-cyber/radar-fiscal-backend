import { InlabsClient } from '../modules/collection/inlabs.client.js';
import { douHtmlText, parseDouEntries, readDouZip } from '../modules/collection/dou.parser.js';

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

    const debugMatterId = target.date === '2026-07-06'
      ? '24102897'
      : target.date === '2026-07-09'
        ? '24117523'
        : undefined;

    if (debugMatterId) {
      const continuationTitles = zip.entries
        .filter(entry => entry.name.includes(`_${debugMatterId}`))
        .map(entry => {
          const xml = new TextDecoder('utf-8').decode(entry.bytes);
          const match = /<Identifica>([\s\S]*?)<\/Identifica>/i.exec(xml);
          const raw = match?.[1]
            ?.replace(/^<!\[CDATA\[/, '')
            .replace(/\]\]>$/, '') ?? '';
          return {
            filename: entry.name,
            identifica: douHtmlText(raw),
          };
        });

      console.log(JSON.stringify({
        stage: 'multipart-title-debug',
        date: target.date,
        matterId: debugMatterId,
        parts: continuationTitles,
      }));
    }

    const hits = parsed.publications.filter(publication =>
      target.pattern.test(publication.title) ||
      target.pattern.test(publication.content ?? '')
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
      parseFailureDetails: parsed.partialFailures,
      hits: hits.slice(0, 10).map(publication => {
        const content = publication.content ?? '';
        const headings = [...content.matchAll(
          /(?:CONV[ÊE]NIO ICMS|AJUSTE SINIEF|PROTOCOLO ICMS)\s+N[º°o.]?\s*\d+(?:\/\d{2,4})?(?:\s*,\s*DE\s+[^\n.]+)?/gi,
        )].slice(0, 12).map(match => match[0].replace(/\s+/g, ' ').trim());

        return {
          title: publication.title,
          agency: publication.agency,
          actType: publication.actType,
          actNumber: publication.actNumber ?? null,
          publishedAt: publication.publishedAt?.toISOString().slice(0, 10) ?? null,
          officialUrl: publication.officialUrl,
          externalId: publication.externalId,
          matchedInTitle: target.pattern.test(publication.title),
          embeddedHeadings: headings,
        };
      }),
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
