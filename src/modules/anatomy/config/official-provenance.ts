import { RESERVED_ENTRY_IDS } from '../rules-simulation.js';
import { actKey } from './act-key.js';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from './reserved-act-keys.js';
import type { SampleInput } from './sample-inputs.js';

/**
 * ANAT-OFFICIAL-01: admission gate for OFFICIAL_SAMPLES (fail closed). An official sample is accepted only when it
 * names the exact official page (https, official host of its source), the act it is (readable identity), the date
 * and version consulted, why it was chosen, and the SHA-256 of the verified snapshot it was cut from. R1: the act
 * identity is checked against the corpus inventory keys and portal ids, so a reserved act cannot enter under another
 * name. The byte-level binding to the snapshot is enforced by test/anatomy.official-snapshot-binding.unit.test.ts.
 * This module never fetches anything and never reads corpus inputs, gold files or the reserve.
 */
export const OFFICIAL_HOSTS: Readonly<Record<SampleInput['source'], readonly string[]>> = Object.freeze({
  CONFAZ: ['www.confaz.fazenda.gov.br'],
  DOU: ['www.in.gov.br'],
  'DOE-SP': ['legislacao.fazenda.sp.gov.br', 'www.doe.sp.gov.br'],
  // ANAT-D03: normasinternet2 serves the RFB's official structured JSON of each act (consulta-externa API).
  RFB: ['normas.receita.fazenda.gov.br', 'normasinternet2.receita.fazenda.gov.br'],
});

export interface ProvenanceIssue { id: string; message: string }
export interface ReservedInventory { actKeys: readonly string[]; sourceIds: readonly string[] }
const INVENTORY: ReservedInventory = { actKeys: RESERVED_ACT_KEYS, sourceIds: RESERVED_SOURCE_IDS };

/** Every problem of every official sample, in Portuguese. Synthetic samples are ignored. */
export function validateOfficialSamples(samples: readonly SampleInput[], today = new Date().toISOString().slice(0, 10), inventory = INVENTORY): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const seen = new Set<string>(); const seenActs = new Map<string, string>();
  for (const s of samples) {
    if (s.provenance.kind !== 'official') continue;
    const p = s.provenance; const bad = (message: string) => issues.push({ id: s.id, message });
    if (!/^ofc-[a-z0-9-]{1,60}$/u.test(s.id)) bad('O id de um ato oficial deve começar por "ofc-" e usar só letras minúsculas, números e hífen.');
    if (RESERVED_ENTRY_IDS.includes(s.id) || RESERVED_ENTRY_IDS.includes(s.documentId)) bad('Id reservado do corpus não é aceito.');
    if (seen.has(s.id)) bad('Id repetido.'); seen.add(s.id);
    // R1-1: identity of the act, against the corpus inventory (fail closed when unreadable).
    const key = actKey(p.act ?? '');
    if (!key) bad('Identidade do ato ilegível (espécie, número e ano): a amostra é recusada.');
    else {
      if (inventory.actKeys.includes(key)) bad(`O ato ${key} pertence ao corpus reservado (BLOCK_CORPUS_INPUTS_AND_GOLD).`);
      const titleKey = actKey(s.title); if (titleKey && titleKey !== key) bad(`O título indica outro ato (${titleKey}) que a identidade declarada (${key}).`);
      if (seenActs.has(key) && seenActs.get(key) !== s.documentId) bad(`O ato ${key} aparece com outro documentId.`); seenActs.set(key, s.documentId);
    }
    let url: URL | null = null;
    try { url = new URL(p.url); } catch { bad('URL inválida.'); }
    if (url) {
      if (url.protocol !== 'https:') bad('A URL deve usar https.');
      if (!OFFICIAL_HOSTS[s.source].includes(url.hostname)) bad(`A URL deve estar em fonte oficial de ${s.source}: ${OFFICIAL_HOSTS[s.source].join(', ')}.`);
      if (inventory.sourceIds.some((id) => p.url.includes(id))) bad('A URL aponta para uma publicação do corpus reservado.');
    }
    if (!/^[a-f0-9]{64}$/u.test(p.snapshotSha256 ?? '')) bad('Informe o SHA-256 do snapshot oficial verificado de onde o trecho foi recortado.');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(p.consultedAt) || Number.isNaN(Date.parse(p.consultedAt))) bad('Data de consulta deve estar no formato AAAA-MM-DD.');
    else if (p.consultedAt > today) bad('Data de consulta no futuro.');
    if (!p.version.trim()) bad('Informe a versão consultada (por exemplo, texto compilado ou original e a data da última alteração indicada na página).');
    if (p.reason.trim().length < 10) bad('Explique o motivo da escolha do ato.');
    if (!s.content.trim()) bad('Conteúdo vazio.');
    if (s.covers.length === 0) bad('Informe o que o ato exercita.');
  }
  return issues;
}

/** Fails closed: an official sample with incomplete provenance never reaches the screen. */
export function assertOfficialSamples(samples: readonly SampleInput[]): readonly SampleInput[] {
  const issues = validateOfficialSamples(samples);
  if (issues.length) throw new Error(`ANAT-OFFICIAL-01: procedência incompleta: ${issues.map((i) => `${i.id}: ${i.message}`).join(' | ')}`);
  return samples;
}
