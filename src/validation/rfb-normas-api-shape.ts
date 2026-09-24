const idAto = process.env.RFB_PROBE_ID ?? '153667';
const url = 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/' + encodeURIComponent(idAto) + '/visao/original';
const response = await fetch(url, {
  headers: {
    accept: 'application/json',
    'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
  },
});
const body = await response.json() as Record<string, unknown>;
function summarize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length && value[0] && typeof value[0] === 'object'
        ? Object.keys(value[0] as Record<string, unknown>)
        : value.slice(0, 3),
    };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value as Record<string, unknown>) };
  }
  return { type: typeof value, sample: typeof value === 'string' ? value.slice(0, 300) : value };
}
console.log('RFB_API_SHAPE=' + JSON.stringify({
  status: response.status,
  url,
  keys: Object.keys(body),
  fields: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, summarize(value)])),
}));
console.log('RFB_API_FULL=' + JSON.stringify(body));
