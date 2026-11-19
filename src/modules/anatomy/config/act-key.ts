/**
 * ANAT-OFFICIAL-01 R1: identity key of a normative act (species + number + 2-digit year), independent of how the act
 * is named ("Convênio ICMS 52/91", "Conv. ICMS 52/1991", "Convênio ICMS nº 52, de 26 de setembro de 1991").
 * Returns null when the identity cannot be read: callers must treat null as a refusal (fail closed).
 */
export function actKey(raw: string): string | null {
  const s = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ');
  const species = /(ajuste sinief|protocolo icms|protocolo|convenio icms|convenio|conv\.(?: icms)?|instrucao normativa|in(?= )|ato declaratorio executivo|ade|portaria|decreto|resolucao|lei complementar|lei|despacho|solucao de consulta|sc)\b/u.exec(s);
  if (!species) return null;
  if (/\bsem numero\b/u.test(s)) return null; // "sem número de 03/09/2026": the date is not an act number
  const rest = s.slice(species.index + species[0].length);
  if (/^[^0-9]*\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/u.test(rest)) return null; // a dd/mm/yyyy date is not an act number
  const m = /^[^0-9]*?(?:n[ºo°.]*\s*)?([0-9][0-9.]*)\s*(?:\/|-|,\s*de\b[^0-9]*(?:\d{1,2}\s+de\s+[a-z]+\s+de\s+)?)\s*(\d{4}|\d{2})\b/u.exec(rest);
  if (!m) return null;
  const kind = ({ 'convenio icms': 'conv', convenio: 'conv', 'conv.': 'conv', 'conv. icms': 'conv', 'instrucao normativa': 'in', 'ato declaratorio executivo': 'ade',
    'protocolo icms': 'protocolo', 'solucao de consulta': 'sc' } as Record<string, string>)[species[1]!] ?? species[1]!;
  return `${kind} ${m[1]!.replace(/\./gu, '')}/${m[2]!.slice(-2)}`;
}
