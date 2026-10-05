export type SegmentPackage = {
  format: 'trifaros-segmentos-cnae-v1'
  sourceWorkbook: string
  sourceUrl: string
  segments: Array<{ id: string; name: string; definition: string }>
  subsegments: Array<{ id: string; name: string; segmentId: string }>
  rows: Array<{ cnae: string; description: string; segmentId: string; subsegmentId: string; synonyms: string[] }>
}

const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[‐‑‒–—―]/g, '-').toLowerCase().trim().replace(/\s+/g, ' ')
const fail = (message: string): never => { throw new Error(message) }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('Arquivo de segmentos inválido.')
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail('Texto ausente ou acima do limite na planilha.')
const array = (value: unknown, max: number): unknown[] =>
  Array.isArray(value) && value.length > 0 && value.length <= max ? value : fail('Lista vazia ou acima do limite na planilha.')

/** Validate every relationship and alias before the first curator write. */
export function parseSegmentPackage(raw: string): SegmentPackage {
  const data = record(JSON.parse(raw))
  if (data.format !== 'trifaros-segmentos-cnae-v1') fail('Formato de segmentos não reconhecido.')
  const segments = array(data.segments, 200).map(value => {
    const row = record(value)
    const id = text(row.id, 40)
    if (!/^[A-Z][A-Z0-9_-]*$/.test(id)) fail('Identificador de segmento inválido.')
    return { id, name: text(row.name, 200), definition: text(row.definition, 4000) }
  })
  const bySegment = new Map(segments.map(row => [row.id, row]))
  if (bySegment.size !== segments.length || new Set(segments.map(row => normalize(row.name))).size !== segments.length) fail('Segmento repetido.')
  const subsegments = array(data.subsegments, 1000).map(value => {
    const row = record(value)
    const segmentId = text(row.segmentId, 40)
    if (!bySegment.has(segmentId)) fail('Subsegmento sem segmento válido.')
    return { id: text(row.id, 80), name: text(row.name, 200), segmentId }
  })
  const bySub = new Map(subsegments.map(row => [row.id, row]))
  if (bySub.size !== subsegments.length || new Set(subsegments.map(row => normalize(row.name))).size !== subsegments.length) fail('Subsegmento repetido.')
  const rows = array(data.rows, 5000).map(value => {
    const row = record(value)
    const cnae = text(row.cnae, 7)
    if (!/^\d{7}$/.test(cnae)) fail('CNAE deve ter sete dígitos, inclusive zeros à esquerda.')
    const subsegmentId = text(row.subsegmentId, 80)
    const segmentId = text(row.segmentId, 40)
    if (bySub.get(subsegmentId)?.segmentId !== segmentId) fail(`CNAE ${cnae}: segmento e subsegmento incompatíveis.`)
    const synonyms = array(row.synonyms, 200).map(value => text(value, 300))
    if (new Set(synonyms.map(normalize)).size !== synonyms.length) fail(`CNAE ${cnae}: sinônimo repetido.`)
    return { cnae, description: text(row.description, 300), segmentId, subsegmentId, synonyms }
  })
  if (new Set(rows.map(row => row.cnae)).size !== rows.length) fail('CNAE repetido no arquivo.')
  return { format: 'trifaros-segmentos-cnae-v1', sourceWorkbook: text(data.sourceWorkbook, 200), sourceUrl: text(data.sourceUrl, 500), segments, subsegments, rows }
}
