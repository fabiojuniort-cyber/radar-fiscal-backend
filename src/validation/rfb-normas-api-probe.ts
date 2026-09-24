const idAto = process.env.RFB_PROBE_ID ?? '153667';
const base = 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/' + encodeURIComponent(idAto) + '/visao/';
for (const kind of ['original', 'vigente', 'multivigente', 'relacional']) {
  const url = base + kind;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
      },
    });
    const text = await response.text();
    console.log('RFB_API_PROBE=' + JSON.stringify({
      kind,
      url,
      status: response.status,
      durationMs: Date.now() - started,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      bodyLength: text.length,
      sample: text.slice(0, 1800),
    }));
  } catch (error) {
    console.error('RFB_API_PROBE_ERROR=' + JSON.stringify({
      kind,
      url,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
