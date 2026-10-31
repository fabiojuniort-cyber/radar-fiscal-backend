import { RESERVED_ENTRY_IDS } from '../rules-simulation.js';
import type { SampleInput } from './sample-inputs.js';

/**
 * ANAT-OFFICIAL-01: provenance gate for OFFICIAL_SAMPLES. An official sample is accepted only when it names the exact
 * official page it was copied from (https, on an official host), the date it was consulted, the version consulted and
 * why it was chosen. This module never fetches anything and never reads the corpus, gold files or the reserve.
 */
export const OFFICIAL_HOSTS: Readonly<Record<SampleInput['source'], readonly string[]>> = Object.freeze({
  CONFAZ: ['www.confaz.fazenda.gov.br'],
  DOU: ['www.in.gov.br'],
  'DOE-SP': ['legislacao.fazenda.sp.gov.br', 'www.doe.sp.gov.br'],
  RFB: ['normas.receita.fazenda.gov.br'],
});
/** Official acts already used as the base of ANAT-03 (tribusca-control#116); kept out of the configuration samples. */
export const EXCLUDED_ACTS = Object.freeze(['convenio-icms-52-91', 'convenio-icms-100-97']);

export interface ProvenanceIssue { id: string; message: string }

/** Every problem of every official sample, in Portuguese. Synthetic samples are ignored. */
export function validateOfficialSamples(samples: readonly SampleInput[], today = new Date().toISOString().slice(0, 10)): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const seen = new Set<string>();
  for (const s of samples) {
    if (s.provenance.kind !== 'official') continue;
    const p = s.provenance; const bad = (message: string) => issues.push({ id: s.id, message });
    if (!/^ofc-[a-z0-9-]{1,60}$/u.test(s.id)) bad('O id de um ato oficial deve começar por "ofc-" e usar só letras minúsculas, números e hífen.');
    if (RESERVED_ENTRY_IDS.includes(s.id) || RESERVED_ENTRY_IDS.includes(s.documentId)) bad('Id reservado do corpus não é aceito.');
    if (EXCLUDED_ACTS.some((a) => s.documentId.includes(a))) bad('Este ato é base do ANAT-03 e fica fora da amostra de configuração.');
    if (seen.has(s.id)) bad('Id repetido.'); seen.add(s.id);
    let url: URL | null = null;
    try { url = new URL(p.url); } catch { bad('URL inválida.'); }
    if (url) {
      if (url.protocol !== 'https:') bad('A URL deve usar https.');
      if (!OFFICIAL_HOSTS[s.source].includes(url.hostname)) bad(`A URL deve estar em fonte oficial de ${s.source}: ${OFFICIAL_HOSTS[s.source].join(', ')}.`);
    }
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
