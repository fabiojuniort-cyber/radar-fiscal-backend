import { sha256Hex } from '../baseline/baseline.canonical-json.js';
import { ncmMatchesEitherPrefix, normalizeNcmPrefix } from '../ncm/ncm-prefix.js';
import {
  buildClassificationFingerprint,
  type ClassificationFingerprint,
} from './classification.fingerprint.js';

/**
 * TAX-11 curated classifier. Deterministic and explainable: every tag
 * records the term or official code that produced it plus a raw excerpt.
 */
export const CURATED_ENGINE_KEY = 'tribusca.taxonomy.curated';
export const CURATED_ENGINE_VERSION = '2.3.0';

export type CuratedReasonCode =
  | 'CANONICAL_LABEL'
  | 'EXACT_LEXICAL_ALIAS'
  | 'ABBREVIATION_ALIAS'
  | 'OFFICIAL_CODE_NCM'
  | 'OFFICIAL_CODE_CCLASSTRIB';

export interface CuratedConceptInput {
  releaseConceptId: string;
  code: string;
  label: string;
  classifyByLabel: boolean;
  aliases: Array<{ text: string; aliasType: string }>;
  ncmPrefixes: string[];
  cclasstribCodes: string[];
}

export interface CuratedAssertion {
  releaseConceptId: string;
  conceptCode: string;
  confidence: number;
  reasonCode: CuratedReasonCode;
  matchedTerm: string;
  excerpt: string;
}

export interface CuratedClassificationInput {
  publicationVersionId: string;
  taxonomyReleaseId: string;
  title: string;
  contentText?: string | null;
  ncmCodes: readonly string[];
  concepts: readonly CuratedConceptInput[];
  codeGitSha?: string | null;
}

export interface CuratedClassificationPlan {
  publicationVersionId: string;
  taxonomyReleaseId: string;
  methodType: 'RULE';
  engineKey: string;
  engineVersion: string;
  codeGitSha: string | null;
  configSnapshot: Record<string, unknown>;
  inputSha256: string;
  fingerprint: ClassificationFingerprint;
  assertions: CuratedAssertion[];
}

const EXCERPT_RADIUS = 90;

interface NormalizedText {
  text: string;
  /** rawIndex[i] = index in the raw text of normalized char i. */
  rawIndex: number[];
}

/**
 * Same normalization as the v1 lexical engine (NFD, no diacritics,
 * lowercase, non-alphanumerics collapsed to one space) while keeping a map
 * back to raw positions so tags can cite the original excerpt.
 */
export function normalizeWithIndex(raw: string): NormalizedText {
  let text = '';
  const rawIndex: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < raw.length; index += 1) {
    const decomposed = raw[index]!
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLocaleLowerCase('pt-BR');

    for (const char of decomposed) {
      if (/[a-z0-9]/.test(char)) {
        if (pendingSpace && text.length > 0) {
          text += ' ';
          rawIndex.push(index);
        }
        pendingSpace = false;
        text += char;
        rawIndex.push(index);
      } else {
        pendingSpace = true;
      }
    }
  }

  return { text, rawIndex };
}

export function normalizeTerm(term: string): string {
  return normalizeWithIndex(term).text;
}

function excerptAround(raw: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_RADIUS);
  const to = Math.min(raw.length, end + EXCERPT_RADIUS);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < raw.length ? '…' : '';
  return prefix + raw.slice(from, to).replace(/\s+/g, ' ').trim() + suffix;
}

// Matching ignores case and accents. A term that is also a Roman numeral
// ("II" = Imposto de Importação) is how acts number their items ("II - às
// saídas", "incisos I e II", "Anexo II"); those enumerations never count.
const ROMAN = /^[ivxlcdm]+$/;
const ENUMERATION_BEFORE =
  /(?:\b(?:incisos?|al[íi]neas?|itens?|anexos?|cap[íi]tulos?|t[íi]tulos?|se[çc][õo]es|se[çc][ãa]o|partes?|livros?|art(?:igo)?s?\.?|n[ºo°]\.?)|\b[ivxlcdm]+\s*(?:,|e|a|ou|-|–|—))\s*$/i;
const ENUMERATION_AFTER = /^\s*(?:[-–—)]|,\s*[ivxlcdm]+\b|(?:e|a|ou)\s+[ivxlcdm]+\b)/i;

function isEnumeration(raw: string, start: number, end: number): boolean {
  const before = raw.slice(Math.max(0, start - 30), start);
  const after = raw.slice(end, end + 12);
  // "(II)" is the acronym in parentheses, not an item "II)".
  if (/\(\s*$/.test(before)) return false;
  // A numeral opening a line/paragraph is an item marker.
  if (/(?:^|\n)\s*$/.test(before)) return true;
  return ENUMERATION_BEFORE.test(before) || ENUMERATION_AFTER.test(after);
}

function findTerm(
  raw: string,
  normalized: NormalizedText,
  term: string,
): string | null {
  const needle = normalizeTerm(term);
  if (!needle) return null;
  const haystack = ' ' + normalized.text + ' ';
  const roman = ROMAN.test(needle);

  for (
    let position = haystack.indexOf(' ' + needle + ' ');
    position >= 0;
    position = haystack.indexOf(' ' + needle + ' ', position + 1)
  ) {
    const start = normalized.rawIndex[position] ?? 0;
    const lastIndex = position + needle.length - 1;
    const end = (normalized.rawIndex[lastIndex] ?? start) + 1;
    if (roman && isEnumeration(raw, start, end)) continue;
    return excerptAround(raw, start, end);
  }
  return null;
}

const CCLASSTRIB_RE =
  /(?:cclasstrib|c[oó]digo\s+de\s+classifica[cç][aã]o\s+tribut[aá]ria)[^0-9]{0,40}(\d{3}\.?\d{3})/giu;

export function extractCclasstribCodes(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of raw.matchAll(CCLASSTRIB_RE)) {
    const code = match[1]!.replace(/\D/g, '');
    if (code.length !== 6 || found.has(code)) continue;
    const start = match.index ?? 0;
    found.set(code, excerptAround(raw, start, start + match[0].length));
  }
  return found;
}

// Scope: every promotion of the "Automotivo e equipamentos de transporte" segment derived from tagged products
// (any product group linked to it, chapter 87 or not). Product/NCM assertions are never affected.
// Limit: the evidence is read only in the title and the first non-blank line of the text; a later mention may be
// incidental or part of a historical redaction. The evidence must be AFFIRMATIVE: a clause of that opening that names
// the automotive application, is not an exclusion ("não se aplica a caminhões", "exceto ônibus") and is not an
// incidental reference to another act or wording ("de que trata", "nos termos do Convênio ICMS 133/02 …").
const AUTOMOTIVE_APPLICATION = /\b(?:setor automotivo|industria automobilistica|autopecas|automoveis de passageiros|veiculos automotores|veiculos rodoviarios|transporte rodoviario|caminhoes|onibus)\b/;
const AUTOMOTIVE_EXCLUSION = /\b(?:nao (?:se aplic\w*|alcanca\w*|abrang\w*|compreend\w*|inclu\w*|se estend\w*|benefici\w*)|exceto|excetuad[oa]s?|salvo|ressalvad[oa]s?|exclui\w*|com excecao|a excecao|inaplicavel|inaplicaveis)\b/;
const COORDINATED_EXCLUSION = /\be nao (?:a|ao|as|aos|para)\b/;
const AUTOMOTIVE_INCIDENTAL = /\b(?:de que trata|a que se refere|nos termos|na forma|conforme|previst[oa]s?|referid[oa]s?|mencionad[oa]s?|citad[oa]s?|redacao anterior|revogad[oa]s?)\b|\b(?:lei|decreto|convenio|protocolo|ajuste|portaria|instrucao normativa|resolucao)\b(?: [a-z]+){0,3} (?:n )?\d/;
const CLAUSE_SEPARATOR = /[.;:()\[\],]|\s[–—-]\s/u;
const AUTOMOTIVE_SEGMENT_LABEL = 'Automotivo e equipamentos de transporte';

/** True only when the title or the first non-blank line affirmatively applies the act to automotive/transport goods. */
export function hasAutomotiveApplication(title: string, contentText: string | null | undefined): boolean {
  const opening = [title, contentText?.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? ''];
  return opening.some((text) => text.split(CLAUSE_SEPARATOR).some((clause) => {
    // In "a caminhões e não a reboques", only the first list applies.
    // A trailing reference introduced by "conforme" does not cancel an application already stated.
    const affirmative = normalizeWithIndex(clause).text.split(COORDINATED_EXCLUSION, 1)[0]!
      .split(/\bconforme\b/, 1)[0]!;
    return AUTOMOTIVE_APPLICATION.test(affirmative)
      && !AUTOMOTIVE_EXCLUSION.test(affirmative) && !AUTOMOTIVE_INCIDENTAL.test(affirmative);
  }));
}

export function allowsDerivedSegment(label: string, automotiveApplication: boolean | null | undefined): boolean {
  // Null identifies a classification written before this policy was recorded.
  return label !== AUTOMOTIVE_SEGMENT_LABEL || automotiveApplication !== false;
}

export function planCuratedClassification(
  input: CuratedClassificationInput,
): CuratedClassificationPlan {
  const raw = [input.title.trim(), input.contentText?.trim() ?? '']
    .filter(Boolean)
    .join('\n');
  const normalized = normalizeWithIndex(raw);
  const ncmCodes = [...new Set(input.ncmCodes.map((code) => normalizeNcmPrefix(code)).filter((code): code is string => code !== null))].sort();
  const cclasstrib = extractCclasstribCodes(raw);

  const found = new Map<string, CuratedAssertion>();
  const keep = (assertion: CuratedAssertion) => {
    const current = found.get(assertion.releaseConceptId);
    if (!current || current.confidence < assertion.confidence) {
      found.set(assertion.releaseConceptId, assertion);
    }
  };

  for (const concept of input.concepts) {
    if (concept.classifyByLabel) {
      const excerpt = findTerm(raw, normalized, concept.label);
      if (excerpt) {
        keep({
          releaseConceptId: concept.releaseConceptId,
          conceptCode: concept.code,
          confidence: 0.95,
          reasonCode: 'CANONICAL_LABEL',
          matchedTerm: concept.label,
          excerpt,
        });
      }
    }

    // One kind of synonym for the curator (PO decision): every synonym
    // marks the legislação where it appears, whatever its stored type.
    for (const alias of concept.aliases) {
      const excerpt = findTerm(raw, normalized, alias.text);
      if (!excerpt) continue;
      keep({
        releaseConceptId: concept.releaseConceptId,
        conceptCode: concept.code,
        confidence: alias.aliasType === 'ABBREVIATION' ? 0.99 : 0.97,
        reasonCode:
          alias.aliasType === 'ABBREVIATION'
            ? 'ABBREVIATION_ALIAS'
            : 'EXACT_LEXICAL_ALIAS',
        matchedTerm: alias.text,
        excerpt,
      });
    }

    for (const prefix of concept.ncmPrefixes) {
      const hit = ncmCodes.find((code) => ncmMatchesEitherPrefix(code, prefix));
      if (!hit) continue;
      keep({
        releaseConceptId: concept.releaseConceptId,
        conceptCode: concept.code,
        confidence: 1,
        reasonCode: 'OFFICIAL_CODE_NCM',
        matchedTerm: hit,
        excerpt: `NCM ${hit} citado na legislação`,
      });
      break;
    }

    for (const code of concept.cclasstribCodes) {
      const hit = [...cclasstrib.keys()].find((found) => found.startsWith(code));
      if (!hit) continue;
      keep({
        releaseConceptId: concept.releaseConceptId,
        conceptCode: concept.code,
        confidence: 1,
        reasonCode: 'OFFICIAL_CODE_CCLASSTRIB',
        matchedTerm: hit,
        excerpt: cclasstrib.get(hit) ?? `cClassTrib ${hit}`,
      });
      break;
    }
  }

  const configSnapshot = {
    policyVersion: 4,
    automotiveApplication: hasAutomotiveApplication(input.title, input.contentText),
    engine: CURATED_ENGINE_KEY,
    canonicalLabel: 'WHEN_CLASSIFY_BY_LABEL',
    autoAliasTypes: 'ALL',
    officialCodes: ['NCM_BIDIRECTIONAL_PREFIX_2_4_6_8_ON_DETECTED_MENTIONS', 'CCLASSTRIB_CITED'],
    normalization: 'NFD_LOWER_ALNUM_TOKENS',
    conceptConfigSha256: sha256Hex(
      JSON.stringify(
        input.concepts.map((concept) => [
          concept.code,
          concept.label,
          concept.classifyByLabel,
          concept.aliases,
          concept.ncmPrefixes,
          concept.cclasstribCodes,
        ]),
      ),
    ),
  };

  const inputSha256 = sha256Hex(JSON.stringify({ raw, ncmCodes }));
  const fingerprint = buildClassificationFingerprint({
    publicationVersionId: input.publicationVersionId,
    taxonomyReleaseId: input.taxonomyReleaseId,
    methodType: 'RULE',
    engineKey: CURATED_ENGINE_KEY,
    engineVersion: CURATED_ENGINE_VERSION,
    codeGitSha: input.codeGitSha ?? null,
    configSnapshot,
    inputSha256,
  });

  return {
    publicationVersionId: input.publicationVersionId,
    taxonomyReleaseId: input.taxonomyReleaseId,
    methodType: 'RULE',
    engineKey: CURATED_ENGINE_KEY,
    engineVersion: CURATED_ENGINE_VERSION,
    codeGitSha: input.codeGitSha ?? null,
    configSnapshot,
    inputSha256,
    fingerprint,
    assertions: [...found.values()].sort((left, right) =>
      left.conceptCode.localeCompare(right.conceptCode),
    ),
  };
}
