const base = 'https://do-api-web-search.doe.sp.gov.br/';
const params = new URLSearchParams({
  Date: '2026-09-21',
  JournalId: 'ca96256b-6ca1-407f-866e-567ef9430123',
  SectionId: '257b103f-1eb2-4f24-a170-4e553c7e4aac',
});

async function request(url: string, label: string) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'tribusca-doe-sp-target-diagnostic' } });
    const body = await response.text();
    console.log('DOE_SP_TARGET_PROBE=' + JSON.stringify({
      label, url, status: response.status, ok: response.ok,
      bytes: Buffer.byteLength(body), ms: Date.now() - started,
      contentType: response.headers.get('content-type'),
      bodyStart: body.slice(0, 200),
    }));
    return { response, body };
  } catch (error) {
    const err = error as Error & { cause?: any };
    console.log('DOE_SP_TARGET_PROBE=' + JSON.stringify({
      label, url, ms: Date.now() - started,
      error: {
        name: err?.name ?? typeof error,
        message: err?.message ?? String(error),
        causeName: err?.cause?.name,
        causeCode: err?.cause?.code,
        causeMessage: err?.cause?.message,
        causeAddress: err?.cause?.address,
        causePort: err?.cause?.port,
      },
    }));
    return null;
  }
}

const list = await request(base + 'v2/summary/list?' + params.toString(), 'list-2026-09-21');
if (list?.response.ok) {
  const parsed = JSON.parse(list.body) as { publications?: Array<Record<string, unknown>> };
  const candidates = (parsed.publications ?? []).filter((row) => {
    const title = typeof row.title === 'string' ? row.title : '';
    return /70[.]?(889|890|891)\b/.test(title.replace(/\s/g, ''));
  });
  console.log('DOE_SP_TARGETS=' + JSON.stringify(candidates.map((row) => ({ id: row.id, title: row.title, slug: row.slug }))));
  for (const row of candidates) {
    const id = String(row.id);
    const detail = await request(base + 'v2/publications/' + encodeURIComponent(id), 'detail-' + id);
    if (!detail?.response.ok) continue;
    let authCode: string | undefined;
    try {
      const parsedDetail = JSON.parse(detail.body) as Record<string, unknown>;
      authCode = typeof parsedDetail.authCode === 'string' ? parsedDetail.authCode : undefined;
      console.log('DOE_SP_TARGET_DETAIL=' + JSON.stringify({ id, title: parsedDetail.title, authCode, date: parsedDetail.date }));
    } catch {}
    if (authCode) {
      await request(base + 'v2/authentication/download/' + encodeURIComponent(authCode), 'pdf-' + id);
    }
  }
}
