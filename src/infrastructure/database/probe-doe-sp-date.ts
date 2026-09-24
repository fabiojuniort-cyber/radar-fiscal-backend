const dates = ['2026-09-20','2026-09-21'];
const journalId = 'ca96256b-6ca1-407f-866e-567ef9430123';
const sectionId = '257b103f-1eb2-4f24-a170-4e553c7e4aac';

async function probe(url: string) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'tribusca-doe-sp-diagnostic' } });
    const body = await response.text();
    console.log('DOE_SP_PROBE=' + JSON.stringify({
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      bytes: Buffer.byteLength(body),
      ms: Date.now() - started,
      bodyStart: body.slice(0, 500),
    }));
  } catch (error) {
    console.log('DOE_SP_PROBE=' + JSON.stringify({
      url,
      error: error instanceof Error ? { name: error.name, message: error.message, cause: String((error as any).cause ?? '') } : String(error),
      ms: Date.now() - started,
    }));
  }
}

for (const date of dates) {
  const qs = new URLSearchParams({ Date: date, JournalId: journalId, SectionId: sectionId });
  await probe('https://do-api-web-search.doe.sp.gov.br/v2/summary/list?' + qs.toString());
  await probe('https://do-api-web-search.doe.sp.gov.br/v2/summary/structured?' + qs.toString());
  await probe('https://do-api-publication-pdf.doe.sp.gov.br/v1/editions/status/' + date);
}
