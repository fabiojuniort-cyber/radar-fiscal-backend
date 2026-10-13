/**
 * F2-T01/T02/T03: read-only reference importer / dry-run.
 * The two signed-off XLSX workbooks are immutable inputs. This module makes
 * a deterministic import *plan*; it deliberately has no database adapter.
 * WARNING: never treat XLSX suggestions as legal tax determinations.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yauzl from 'yauzl';

export const F2_SOURCE = Object.freeze({
  segmento: Object.freeze({
    sha256: '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67',
    rows: 1332,
    sheet: 'Segmento',
    columns: ['Segmento', 'Sub Segmento', 'Atuação', 'CNAE', 'Descrição do CNAE', 'Sinônimos', 'Produtos (sugeridos)', 'NCMs (sugeridos)', 'No perfil', 'Classificar pelo nome', 'Ordem', 'Código TriFaros'],
  }),
  produto: Object.freeze({
    sha256: '261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a',
    rows: 4225,
    sheet: 'Produto',
    columns: ['Segmento', 'Grupo', 'Item', 'NCM', 'Sinônimos', 'No perfil', 'Classificar pelo nome', 'Ordem', 'Código TriFaros', 'Definição'],
  }),
});

const MAX_XLSX_BYTES = 8 * 1024 * 1024;
const MAX_UNZIPPED_ENTRY = 16 * 1024 * 1024;
// Approved F2-T02 catalogue. Counts are report-only, not a gate.
// The v5.1 source now uses the 12 approved categories; no automatic remapping.
export const APPROVED_ACTUATIONS = new Set([
  'Serviço', 'Indústria', 'Comércio atacadista', 'Comércio varejista',
  'Transportador', 'Extração mineral', 'Produtor rural',
  'Locação e licenciamento', 'Institucional', 'Representação comercial',
  'Energia e utilidades', 'Armazém',
]);

function fail(message) {
  throw new Error('F2_REJECTED: ' + message);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function segmentSubsegmentLabel(segmento, subsegmento) {
  const parent = String(segmento ?? '').trim();
  const child = String(subsegmento ?? '').trim();
  if (!parent || !child) fail('Segmento e Subsegmento são obrigatórios');
  // UI contract only; never store this concatenated label as an identity.
  return parent + ' – ' + child;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, number) => {
      const code = number[0]?.toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : parseInt(number, 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        fail('Entidade XML numérica inválida');
      }
      return String.fromCodePoint(code);
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function richText(xml) {
  let out = '';
  const regex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  for (const match of xml.matchAll(regex)) out += decodeXml(match[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  xml = xml.replace(/<(\/?)x:(?=[A-Za-z])/g, '<$1');
  if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) fail('DOCTYPE/ENTITY não permitido');
  const result = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    result.push(richText(match[1]));
  }
  return result;
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(reference)?.[0];
  if (!letters) fail('Referência XLSX inválida: ' + reference);
  let index = 0;
  for (const ch of letters) index = index * 26 + ch.charCodeAt(0) - 64;
  return index - 1;
}

export function parseWorksheet(xml, shared) {
  xml = xml.replace(/<(\/?)x:(?=[A-Za-z])/g, '<$1');
  if (!/<worksheet\b/.test(xml) || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) fail('Planilha XML inválida');
  if (/<f(?:\s|>)/.test(xml)) fail('Fórmulas não são permitidas nas fontes congeladas');
  const rows = [];
  const rowRegex = /<row\b[^>]*\br="([0-9]+)"[^>]*>([\s\S]*?)<\/row>/g;
  for (const match of xml.matchAll(rowRegex)) {
    const index = Number(match[1]);
    if (index !== rows.length + 1) fail('Linhas XLSX fora de ordem ou ausentes');
    const values = [];
    for (const cell of match[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([^"]+)"/.exec(cell[1])?.[1] ?? '';
      const col = columnIndex(ref);
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? '';
      if (col > 100) fail('Número de colunas excedido');
      if (type === 's') {
        const raw = /<v>([0-9]+)<\/v>/.exec(cell[2] ?? '')?.[1];
        const text = raw === undefined ? undefined : shared[Number(raw)];
        if (text === undefined) fail('Índice sharedStrings inválido');
        values[col] = text;
      } else if (type === 'inlineStr') {
        values[col] = richText(cell[2] ?? '');
      } else {
        values[col] = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(cell[2] ?? '')?.[1] ?? '');
      }
    }
    rows.push(values);
  }
  return rows;
}

/** Read exact ZIP paths; no filesystem extraction or network access. */
function unzipEntry(bytes, target, optional = false) {
  return new Promise((resolveEntry, reject) => {
    let found = false;
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('ZIP inválido'));
      zip.on('error', reject);
      zip.on('end', () => { if (!found) { if (optional) resolveEntry(''); else reject(new Error('XLSX sem entrada ' + target)); } });
      zip.on('entry', (entry) => {
        if (entry.fileName !== target) return zip.readEntry();
        if (found) return reject(new Error('Entrada ZIP duplicada: ' + target));
        found = true;
        if (entry.uncompressedSize > MAX_UNZIPPED_ENTRY) return reject(new Error('Entrada ZIP grande demais'));
        zip.openReadStream(entry, (openError, stream) => {
          if (openError || !stream) return reject(openError ?? new Error('Falha ao ler ZIP'));
          const chunks = [];
          let total = 0;
          stream.on('error', reject);
          stream.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_UNZIPPED_ENTRY) {
              stream.destroy(new Error('Entrada ZIP excede limite'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => resolveEntry(Buffer.concat(chunks).toString('utf8')));
        });
      });
      zip.readEntry();
    });
  });
}

export async function parseApprovedWorkbook(path, kind) {
  const spec = F2_SOURCE[kind];
  if (!spec) fail('Tipo de planilha desconhecido');
  const bytes = await readFile(path);
  if (bytes.length > MAX_XLSX_BYTES) fail('Arquivo XLSX excede limite');
  const hash = sha256(bytes);
  if (hash !== spec.sha256) fail(kind + ': hash divergente: ' + hash);
  const xml = await unzipEntry(bytes, 'xl/worksheets/sheet1.xml');
  const shared = parseSharedStrings(await unzipEntry(bytes, 'xl/sharedStrings.xml', true));
  const rows = parseWorksheet(xml, shared);
  if (rows.length !== spec.rows + 1) fail(kind + ': número de linhas divergente: ' + (rows.length - 1));
  if (JSON.stringify(rows[0]) !== JSON.stringify(spec.columns)) {
    fail(kind + ': cabeçalhos divergentes');
  }
  return { kind, hash, rows: rows.slice(1) };
}

/**
 * CI-only ZIP/XML parser using the same hardened reader, but with synthetic
 * workbook hashes. The production CLI still uses parseApprovedWorkbook with
 * its pinned SHA256. Never enable this helper outside isolated PG18.
 */
export async function parseF2TestFixtureWorkbook(path, kind) {
  if (process.env.NODE_ENV !== 'test' ||
      process.env.F2_IMPORT_SCOPE !== 'ISOLATED_POSTGRES18_ONLY') {
    fail('Fixture parsing unavailable outside isolated test');
  }
  const spec = F2_SOURCE[kind];
  if (!spec) fail('Fixture kind inválido');
  const bytes = await readFile(path);
  if (bytes.length > MAX_XLSX_BYTES) fail('Fixture XLSX excede limite');
  const xml = await unzipEntry(bytes, 'xl/worksheets/sheet1.xml');
  const shared = parseSharedStrings(await unzipEntry(bytes, 'xl/sharedStrings.xml', true));
  const rows = parseWorksheet(xml, shared);
  if (rows.length !== spec.rows + 1 ||
      JSON.stringify(rows[0]) !== JSON.stringify(spec.columns))
    fail('Fixture headers/rows divergem do contrato F2');
  return {kind, hash: sha256(bytes), rows: rows.slice(1)};
}

function splitMulti(text) {
  return String(text ?? '').split(';').map(x => x.trim()).filter(Boolean);
}
function digits(text) {
  return String(text ?? '').replace(/\D/g, '');
}

/**
 * T03: source NCM prefixes may contain 2 through 8 digits, with or without dots.
 * Accept ONLY digits and dots in one semicolon-delimited NCM cell token.
 * Never silently discard an invalid character from Produto.NCM.
 * Segmento.NCMs (sugeridos) is advisory text, not imported official codes.
 */
export function normalizeProductNcm(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^[0-9.]+$/.test(raw)) return null;
  const normalized = raw.replace(/\./g, '');
  return /^\d{2,8}$/.test(normalized) ? normalized : null;
}

/** Potential relevance only, not legal incidence or product/NCM assignment. */
export function ncmMatchesEitherPrefix(left, right) {
  const a = normalizeProductNcm(left);
  const b = normalizeProductNcm(right);
  return a !== null && b !== null && (a.startsWith(b) || b.startsWith(a));
}

export function planImport(segmentRows, productRows) {
  const errors = [];
  const warnings = [];
  const seenCnae = new Set();
  const seenProductCode = new Set();
  const activities = new Map();
  const segments = new Map();
  const products = [];
  const originRows = [];

  for (let i = 0; i < segmentRows.length; i++) {
    const row = segmentRows[i];
    const [segment, subsegment, activity, sourceCnae, description, synonyms, suggestedProducts, suggestedNcms, inProfile, classifyByName, order, code] = row;
    const line = i + 2;
    const cnae = digits(sourceCnae);
    const s = String(segment ?? '').trim();
    const sub = String(subsegment ?? '').trim();
    const act = String(activity ?? '').trim();
    if (!s || !sub || !act || !cnae || cnae.length !== 7) errors.push('Segmento linha ' + line + ': segmento/subsegmento/atuação/CNAE inválido');
    if (seenCnae.has(cnae)) errors.push('CNAE com mais de uma Atuação: ' + cnae + ' (linha ' + line + ')');
    seenCnae.add(cnae);
    const key = s + '\u0000' + sub;
    if (!segments.has(key)) segments.set(key, { segmento: s, subsegmento: sub, display: segmentSubsegmentLabel(s, sub) });
    if (!activities.has(act)) activities.set(act, { label: act, code: null, synonyms: [], cnaes: [] });
    activities.get(act).cnaes.push(cnae);
    originRows.push({ sourceLine: line, cnaeCode: cnae, atuacaoLabel: act });
    if (!sourceCnae || !code) warnings.push('Segmento linha ' + line + ': origem sem código TriFaros');
    if (splitMulti(suggestedProducts).length !== splitMulti(suggestedNcms).length && suggestedProducts && suggestedNcms) {
      // Not necessarily 1:1; preserve two independent suggestion sets.
      warnings.push('Segmento linha ' + line + ': cardinalidade produto/NCM não 1:1; sem associação automática');
    }
  }

  for (let i = 0; i < productRows.length; i++) {
    const [segment, group, item, ncm, aliases, inProfile, classifyByName, order, code, definition] = productRows[i];
    const line = i + 2;
    const name = String(item ?? '').trim();
    const id = String(code ?? '').trim();
    if (!segment || !group || !name || !id) errors.push('Produto linha ' + line + ': segmento/grupo/item/código obrigatório');
    if (id && seenProductCode.has(id)) warnings.push('Código produto repetido: ' + id + ' (linha ' + line + ')');
    seenProductCode.add(id);
    const ncms = splitMulti(ncm).map(raw => ({
      raw,
      digits: normalizeProductNcm(raw),
    }));
    if (ncms.some(value => value.digits === null)) {
      errors.push('Produto linha ' + line + ': NCM inválido (somente dígitos e pontos; 2 a 8 dígitos)');
    }
    products.push({
      segment: String(segment ?? '').trim(),
      group: String(group ?? '').trim(),
      item: name,
      ncms,
      synonyms: splitMulti(aliases),
      profileVisible: String(inProfile ?? '').trim().toLowerCase() === 'x',
      classifyByName: String(classifyByName ?? '').trim().toLowerCase() === 'x',
      order: String(order ?? ''),
      code: id,
      definition: String(definition ?? ''),
      sourceLine: line,
    });
  }

  // Exactly one registered Atuação per CNAE; no automatic category mapping.
  // The approved catalogue is the T02 seed; the CLI itself has no DB access.
  if (segmentRows.length !== F2_SOURCE.segmento.rows || seenCnae.size !== F2_SOURCE.segmento.rows) {
    errors.push('Segmento: exigidos 1.332 CNAEs únicos com exatamente uma Atuação cada');
  }
  for (const name of activities.keys()) {
    if (!APPROVED_ACTUATIONS.has(name)) errors.push('Atuação não cadastrada na T02: ' + name);
  }

  return {
    mode: 'DRY_RUN_ONLY',
    noDatabaseWrites: true,
    noTaxonomicPublication: true,
    summary: {
      segmentRows: segmentRows.length,
      productRows: productRows.length,
      cnaeDistinct: seenCnae.size,
      segmentSubsegmentPairs: segments.size,
      actuationCategories: activities.size,
      actuationCounts: Object.fromEntries([...activities].map(([label, item]) => [label, item.cnaes.length])),
      productCodesDistinct: seenProductCode.size,
      errors: errors.length,
      warnings: warnings.length,
    },
    actuationSeed: [...activities.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    actuationOrigins: originRows,
    segmentSubsegments: [...segments.values()],
    products,
    issues: { errors, warnings },
    provenance: {
      segmentoSha256: F2_SOURCE.segmento.sha256,
      produtoSha256: F2_SOURCE.produto.sha256,
      legacyCsv: 'ops/taxonomy/loads/classificacao-produtos-agro.csv — SUPERSEDED, preserve for history',
    },
  };
}

export async function buildDryRun(segmentPath, productPath) {
  const [seg, prod] = await Promise.all([
    parseApprovedWorkbook(segmentPath, 'segmento'),
    parseApprovedWorkbook(productPath, 'produto'),
  ]);
  return planImport(seg.rows, prod.rows);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => ['--confirm', '--apply', '--write', '--deploy'].includes(a))) {
    fail('Carga produtiva proibida nesta ferramenta: exigir dry-run, backup verificado e OK explícito em fluxo separado');
  }
  const value = flag => args.find(a => a.startsWith('--' + flag + '='))?.slice(flag.length + 3);
  const segmento = value('segmento');
  const produto = value('produto');
  const output = value('out');
  if (!segmento || !produto) fail('Uso: node ops/taxonomy/f2-xlsx-dry-run.mjs --segmento=<xlsx> --produto=<xlsx> [--out=relatorio.json]');
  const result = await buildDryRun(resolve(segmento), resolve(produto));
  const report = JSON.stringify(result, null, 2);
  if (output) await writeFile(resolve(output), report + '\n', { flag: 'wx' });
  console.log(JSON.stringify({
    mode: result.mode, summary: result.summary, issuesPreview: {
      errors: result.issues.errors.slice(0, 10),
      warnings: result.issues.warnings.slice(0, 10),
    }, output: output ?? null,
  }, null, 2));
  if (result.summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1] && new URL(import.meta.url).pathname === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
