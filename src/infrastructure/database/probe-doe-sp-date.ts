import dns from 'node:dns/promises';

const host = 'do-api-web-search.doe.sp.gov.br';
console.log('DOE_SP_DNS_LOOKUP=' + JSON.stringify(await dns.lookup(host, { all: true })));
try {
  console.log('DOE_SP_DNS_RESOLVE4=' + JSON.stringify(await dns.resolve4(host, { ttl: true })));
} catch (error) {
  console.log('DOE_SP_DNS_RESOLVE4_ERROR=' + JSON.stringify(error instanceof Error ? {name:error.name,message:error.message} : String(error)));
}

async function probe(url: string, label: string) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'tribusca-doe-sp-node-diagnostic' } });
    const body = await response.text();
    console.log('DOE_SP_NODE_PROBE=' + JSON.stringify({
      label, url, status: response.status, ok: response.ok,
      bytes: Buffer.byteLength(body), ms: Date.now() - started,
      contentType: response.headers.get('content-type'),
      bodyStart: body.slice(0, 120),
    }));
  } catch (error) {
    const err = error as Error & { cause?: any };
    console.log('DOE_SP_NODE_PROBE=' + JSON.stringify({
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
  }
}

for (let i = 1; i <= 8; i += 1) {
  await probe('https://do-api-web-search.doe.sp.gov.br/v2/journals', 'journals-' + i);
  await probe('https://do-api-web-search.doe.sp.gov.br/v2/sections?JournalId=ca96256b-6ca1-407f-866e-567ef9430123', 'sections-' + i);
}
