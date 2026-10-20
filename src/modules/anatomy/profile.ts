import { z } from 'zod';
import { canonicalJson, sha256 } from './contract.js';

/**
 * ANAT P1.A — declarative rule profiles (`ANAT-PROFILE/1`): schema, limits, inheritance, effective profile and a
 * deterministic hash. PURE and NOT wired into the engine: the reader/extractor still use their own constants, so the
 * contract, `engineHash` and the approved golds are untouched. Integration is P1.B (docs/anatomy/ADMIN-01.md).
 *
 * Profiles hold only lists of literals. No regex, code, SQL or URL is accepted; matching semantics per field are
 * fixed by `PROFILE_FIELD_SEMANTICS` and are not editable.
 */
export const PROFILE_FORMAT_VERSION = 'ANAT-PROFILE/1' as const;
/** COORD decision of 19/10/2026. */
export const PROFILE_LIMITS = Object.freeze({ maxItemsPerField: 64, maxLiteralUtf16: 64, maxProfileBytes: 64 * 1024 });
export const PROFILE_SOURCES = ['CONFAZ', 'DOU', 'DOE-SP', 'RFB'] as const;

// A literal is accepted only in its canonical form, so validation and compilation read it the same way (review of
// PR #249): Unicode NFC, no control characters, no leading/trailing whitespace and, inside, only single U+0020 spaces.
const literal = z.string()
  .refine((s) => s.length >= 1 && s.length <= PROFILE_LIMITS.maxLiteralUtf16, { message: `literal must have 1–${PROFILE_LIMITS.maxLiteralUtf16} UTF-16 units` })
  .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s), { message: 'literal must not contain control characters' })
  .refine((s) => s === s.trim(), { message: 'literal must not start or end with whitespace' })
  .refine((s) => s === s.normalize('NFC'), { message: 'literal must be in Unicode NFC' })
  .refine((s) => !/[^\S ]| {2}/u.test(s), { message: 'words in a literal must be separated by a single space' });
// CSS classes and quote characters are single tokens: whitespace could never match a class token or a quote mark.
const token = literal.refine((s) => !/\s/u.test(s), { message: 'class names and quote marks must not contain whitespace' });
const listOf = (item: typeof literal) => z.array(item).max(PROFILE_LIMITS.maxItemsPerField, { message: `at most ${PROFILE_LIMITS.maxItemsPerField} items per field` })
  .refine((items) => new Set(items).size === items.length, { message: 'duplicate literal in field' });
const list = listOf(literal);
const tokens = listOf(token);

/** Every editable field, grouped. Group objects are strict: unknown keys are rejected. */
const groups = {
  classes: z.strictObject({ historical: tokens, editorialNote: tokens, body: tokens, epigraph: tokens, summary: tokens, signature: tokens }),
  blockStarts: z.strictObject({ preamble: list, rectificationOriginal: list, rectificationCorrected: list }),
  quotes: z.strictObject({ open: tokens, close: tokens, closeSuffix: tokens }),
  labels: z.strictObject({ annex: list, clause: list, article: list, paragraph: list }),
  ncm: z.strictObject({ markers: list, columnHeaders: list, columnBlockers: list }),
  lists: z.strictObject({ tokens: list }),
  ranges: z.strictObject({ operators: list }),
  exceptions: z.strictObject({ markers: list }),
  // The conservative policy for ambiguous tables is mandatory: it is the only accepted value.
  table: z.strictObject({ ambiguousGeometry: z.literal('unknown_partial') }),
};
type Groups = typeof groups;
export type ProfileFields = { [K in keyof Groups]: z.infer<Groups[K]> };

/** Fixed matching semantics for the future integration (P1.B); documented here, never editable by a profile. */
export const PROFILE_FIELD_SEMANTICS = Object.freeze({
  'classes.*': 'exact CSS class token on the block or an ancestor',
  'blockStarts.*': 'case-insensitive prefix at block start; internal whitespace collapsed',
  'quotes.open': 'first non-space character of a block', 'quotes.close': 'last non-space character of a block', 'quotes.closeSuffix': 'optional suffix after the closing quote',
  'labels.*': 'case-insensitive token at block start (inciso/alínea grammar is built in, not a label)',
  'ncm.markers': 'case-insensitive word before a bounded numeric list', 'ncm.columnHeaders': 'exact header cell text, case-insensitive', 'ncm.columnBlockers': 'header cell text (optionally followed by "/…") that closes an NCM column',
  'lists.tokens': 'case-insensitive word allowed inside a code list', 'ranges.operators': 'whole bridge between two codes', 'exceptions.markers': 'case-insensitive word opening an exception',
  'table.ambiguousGeometry': 'mandatory: ambiguous geometry is unknown and the result partial',
} as const);

const fullFields = z.strictObject(groups);
// Overrides: every group optional, every field inside optional; groups stay strict (unknown keys rejected).
const partialFields = z.strictObject({
  classes: groups.classes.partial().optional(), blockStarts: groups.blockStarts.partial().optional(), quotes: groups.quotes.partial().optional(),
  labels: groups.labels.partial().optional(), ncm: groups.ncm.partial().optional(), lists: groups.lists.partial().optional(),
  ranges: groups.ranges.partial().optional(), exceptions: groups.exceptions.partial().optional(), table: groups.table.partial().optional(),
});

const scope = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('default') }),
  z.strictObject({ level: z.literal('source'), source: z.enum(PROFILE_SOURCES) }),
  z.strictObject({ level: z.literal('family'), source: z.enum(PROFILE_SOURCES), family: literal }),
]);
const profileShape = z.strictObject({ profileVersion: z.literal(PROFILE_FORMAT_VERSION), scope, fields: z.unknown() });

export type ProfileScope = z.infer<typeof scope>;
export interface AnatomyProfile { profileVersion: typeof PROFILE_FORMAT_VERSION; scope: ProfileScope; fields: ProfileFields | Partial<{ [K in keyof ProfileFields]: Partial<ProfileFields[K]> }> }

/**
 * Regex fragment of one literal, shared by the compiler (profile-rules.ts) and by validation, so "same literal" and
 * "header blocked" are decided by the very matcher the engine runs (review of PR #249). Only regex syntax characters
 * are escaped (required in `u` mode). Spaces in rectification starts and labels match any run of whitespace (preamble: see preamblePattern); NCM header and
 * blocker literals also tolerate whitespace around "/". Other fields match the literal as written.
 */
export const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/gu, (c) => `\\${c}`);
const wordsPattern = (lit: string) => lit.split(' ').map(escapeLiteral).join('\\s+');
const headerPattern = (lit: string) => lit.split('/').map((side) => wordsPattern(side.trim())).join('\\s*\\/\\s*');
/**
 * Preamble starts keep the pre-profile rule exactly (review of PR #249: the two preamble changes were not approved):
 * only the space after the first word accepts any whitespace run ("O\\s+Conselho", "A\\s+Receita Federal"); later
 * spaces are literal.
 */
const preamblePattern = (lit: string) => { const [first, ...rest] = lit.split(' '); return rest.length ? `${escapeLiteral(first!)}\\s+${escapeLiteral(rest.join(' '))}` : escapeLiteral(first!); };
export function literalPattern(group: string, field: string, lit: string): string {
  if (group === 'ncm' && (field === 'columnHeaders' || field === 'columnBlockers')) return headerPattern(lit);
  if (group === 'blockStarts' && field === 'preamble') return preamblePattern(lit);
  if (group === 'blockStarts' || group === 'labels') return wordsPattern(lit);
  return escapeLiteral(lit);
}
/** Header text matched by any blocker: the blocker literal, optionally followed by "/…" (fixed reader rule). */
export const blockerPattern = (blockers: readonly string[]) => (blockers.length ? `^(?:${blockers.map((b) => literalPattern('ncm', 'columnBlockers', b)).join('|')})(?:\\s*\\/.*)?$` : '(?!)');

/**
 * Two literals of a field are the same when the field's matcher cannot tell them apart. CSS classes and quote
 * characters are exact (literals are already NFC); every other field matches case-insensitively through its compiled
 * fragment. Accent variants (até/ate) stay distinct on purpose: the current rules accept both spellings explicitly.
 */
const EXACT_GROUPS = new Set(['classes', 'quotes']);
export function sameLiteral(group: string, field: string, a: string, b: string): boolean {
  if (EXACT_GROUPS.has(group)) return a === b;
  const full = (x: string) => new RegExp(`^(?:${literalPattern(group, field, x)})$`, 'iu');
  return full(a).test(b) || full(b).test(a);
}

/** Duplicates under the field's own semantics, and headers both allowed and blocked for NCM columns. */
function semanticIssues(fields: Partial<Record<string, Record<string, unknown> | undefined>>): string[] {
  const issues: string[] = [];
  for (const [group, values] of Object.entries(fields)) {
    if (!values) continue;
    for (const [field, value] of Object.entries(values)) {
      if (!Array.isArray(value)) continue;
      const items = value as string[];
      items.forEach((item, i) => {
        const prior = items.slice(0, i).find((p) => sameLiteral(group, field, p, item));
        if (prior !== undefined) issues.push(`${group}.${field}: "${item}" duplicates "${prior}"`);
      });
    }
  }
  const ncm = fields.ncm as { columnHeaders?: string[]; columnBlockers?: string[] } | undefined;
  if (ncm?.columnHeaders && ncm.columnBlockers) issues.push(...headerConflicts(ncm.columnHeaders, ncm.columnBlockers));
  return issues;
}

/**
 * A header is in conflict when the compiled blocker rule matches it. Header text is matched up to case, whitespace
 * and spacing around "/", and the blocker rule is invariant under the same changes, so testing each header literal
 * covers every text the header accepts (e.g. header "NCM/SH" with blocker "NCM / SH" or "ncm").
 */
function headerConflicts(headers: string[], blockers: string[]): string[] {
  const out: string[] = [];
  for (const h of headers) {
    for (const b of blockers) if (new RegExp(blockerPattern([b]), 'iu').test(h)) out.push(`ncm: header "${h}" is also blocked by "${b}"`);
  }
  return out;
}

/**
 * Context protections (review of PR #249). A configuration may ADD to the fields that keep text out of positive
 * selection, never remove a shipped literal from them: removing `RedaoAnt` or `TituloAcordo` would turn historical
 * or prohibited text into `operative_candidate`. Quote-closing fields work the other way (a new closing mark ends a
 * quotation earlier, exposing quoted text), so they may only keep or drop shipped literals. The floor is the shipped
 * `DEFAULT_PROFILES` resolved for the same source; a family cannot go below it either.
 */
export const PROTECTED_FLOOR_FIELDS = Object.freeze(['classes.historical', 'classes.editorialNote', 'classes.epigraph', 'classes.summary', 'classes.signature',
  'blockStarts.preamble', 'blockStarts.rectificationOriginal', 'blockStarts.rectificationCorrected', 'quotes.open', 'ncm.columnBlockers', 'exceptions.markers'] as const);
export const PROTECTED_CEILING_FIELDS = Object.freeze(['quotes.close', 'quotes.closeSuffix'] as const);
const fieldOf = (fields: ProfileFields, path: string): string[] => { const [g, f] = path.split('.') as [string, string]; return (fields as unknown as Record<string, Record<string, string[]>>)[g]![f]!; };
function protectionIssues(fields: ProfileFields, shipped: ProfileFields): string[] {
  const out: string[] = [];
  const has = (path: string, list: string[], lit: string) => { const [g, f] = path.split('.') as [string, string]; return list.some((x) => sameLiteral(g, f, x, lit)); };
  for (const path of PROTECTED_FLOOR_FIELDS) {
    for (const lit of fieldOf(shipped, path)) if (!has(path, fieldOf(fields, path), lit)) out.push(`${path}: shipped protection "${lit}" cannot be removed`);
  }
  for (const path of PROTECTED_CEILING_FIELDS) {
    for (const lit of fieldOf(fields, path)) if (!has(path, fieldOf(shipped, path), lit)) out.push(`${path}: "${lit}" would close quotations the shipped profile keeps open`);
  }
  return out;
}

export class ProfileValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProfileValidationError'; }
}
const fail = (code: string, message: string): never => { throw new ProfileValidationError(code, message); };
const utf8Bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value), 'utf8');

/** Validate one profile (fail closed). The default must define every field; source/family may override any subset. */
export function validateProfile(value: unknown): AnatomyProfile {
  const shape = profileShape.safeParse(value);
  if (!shape.success) fail('invalid_profile', shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { scope: s, fields } = shape.data!;
  const parsed = (s.level === 'default' ? fullFields : partialFields).safeParse(fields);
  if (!parsed.success) fail(s.level === 'default' ? 'incomplete_default' : 'invalid_fields', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const profile = { profileVersion: PROFILE_FORMAT_VERSION, scope: s, fields: parsed.data } as AnatomyProfile;
  if (utf8Bytes(profile) > PROFILE_LIMITS.maxProfileBytes) fail('profile_too_large', `profile exceeds ${PROFILE_LIMITS.maxProfileBytes} bytes`);
  const issues = semanticIssues(profile.fields as Record<string, Record<string, unknown>>);
  if (issues.length) fail('semantic_conflict', issues.join('; '));
  return profile;
}

/** SHA-256 of the canonical JSON of a validated profile (key order and input formatting do not matter). */
export const profileHash = (profile: AnatomyProfile): string => sha256(canonicalJson(validateProfile(profile)));

const scopeKey = (s: ProfileScope) => (s.level === 'default' ? 'default' : s.level === 'source' ? `source:${s.source}` : `family:${s.source}:${s.family}`);

export interface EffectiveProfile {
  profileVersion: typeof PROFILE_FORMAT_VERSION;
  target: { source: (typeof PROFILE_SOURCES)[number]; family: string | null };
  fields: ProfileFields;
  /** Profiles applied, most general first, with their own hashes (provenance for audit). */
  chain: { scope: ProfileScope; profileHash: string }[];
  /** Hash of the BEHAVIOUR: format version + effective fields only. Same effective fields ⇒ same hash, whatever the chain. */
  effectiveHash: string;
}

/**
 * Resolve the effective profile for a target with short inheritance default → source → family. Override is
 * per field: a field present in a more specific profile replaces the inherited list entirely; an omitted field
 * is inherited. Exactly one default; at most one profile per scope.
 */
export function resolveEffectiveProfile(profiles: unknown[], target: { source: string; family?: string | null }): EffectiveProfile {
  const source = z.enum(PROFILE_SOURCES).safeParse(target.source);
  if (!source.success) fail('invalid_target', `unknown source ${String(target.source)}`);
  const family = target.family ?? null;
  if (family !== null && !literal.safeParse(family).success) fail('invalid_target', 'invalid family');
  const resolved = resolveChain(profiles, source.data!, family);
  assertProtectionFloor(resolved.fields, source.data!);
  return resolved;
}

/**
 * The protection floor/ceiling check, also run by the rule compiler, so no caller (analyzeAnatomy, readAnatomyInput
 * with compiled rules, or a direct compileProfileRules call) can obtain matchers below the shipped protections.
 */
export function assertProtectionFloor(fields: ProfileFields, source: (typeof PROFILE_SOURCES)[number]): void {
  const weakened = protectionIssues(fields, shippedFields(source));
  if (weakened.length) fail('protection_weakened', weakened.join('; '));
}

const shipped = new Map<string, ProfileFields>();
/** The shipped DEFAULT_PROFILES resolved for a source: the protection floor/ceiling for any configuration. */
function shippedFields(source: (typeof PROFILE_SOURCES)[number]): ProfileFields {
  let f = shipped.get(source);
  if (!f) { f = resolveChain([...DEFAULT_PROFILES], source, null).fields; shipped.set(source, f); }
  return f;
}

function resolveChain(profiles: unknown[], source: (typeof PROFILE_SOURCES)[number], family: string | null): EffectiveProfile {
  const valid = profiles.map(validateProfile);
  const byScope = new Map<string, AnatomyProfile>();
  for (const p of valid) {
    const k = scopeKey(p.scope);
    if (byScope.has(k)) fail('duplicate_scope', `more than one profile for ${k}`);
    byScope.set(k, p);
  }
  const base = byScope.get('default') ?? fail('missing_default', 'exactly one default profile is required');
  const chain = [base, byScope.get(`source:${source}`), family === null ? undefined : byScope.get(`family:${source}:${family}`)].filter((p): p is AnatomyProfile => !!p);
  const fields = structuredClone(base.fields) as ProfileFields;
  for (const p of chain.slice(1)) {
    for (const [group, values] of Object.entries(p.fields) as [keyof ProfileFields, Record<string, unknown>][]) {
      if (!values) continue;
      for (const [field, value] of Object.entries(values)) (fields[group] as Record<string, unknown>)[field] = structuredClone(value);
    }
  }
  const checked = fullFields.parse(fields) as ProfileFields;
  // Inheritance can combine lists that were each valid alone (e.g. a source header blocked by a default blocker).
  const inherited = semanticIssues(checked as unknown as Record<string, Record<string, unknown>>);
  if (inherited.length) fail('effective_conflict', inherited.join('; '));
  if (utf8Bytes({ profileVersion: PROFILE_FORMAT_VERSION, fields: checked }) > PROFILE_LIMITS.maxProfileBytes) fail('profile_too_large', 'effective profile exceeds the size limit');
  return { profileVersion: PROFILE_FORMAT_VERSION, target: { source: source, family }, fields: checked,
    chain: chain.map((p) => ({ scope: p.scope, profileHash: profileHash(p) })),
    effectiveHash: sha256(canonicalJson({ profileVersion: PROFILE_FORMAT_VERSION, fields: checked })) };
}

/**
 * Default profiles EXTRACTED from the constants currently hard-coded in `readers.ts` and `entities.ts` (SHA d57a7a94).
 * Case/accent variants accepted by the current regexes are listed explicitly as literals.
 */
export const DEFAULT_PROFILES: readonly AnatomyProfile[] = Object.freeze([
  { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'default' }, fields: {
    classes: { historical: [], editorialNote: [], body: [], epigraph: [], summary: [], signature: [] },
    blockStarts: { preamble: ['O Conselho', 'O Ministro', 'O Secretário', 'O Secretario', 'O Governador', 'O Presidente', 'A Secretária', 'A Secretaria', 'A Receita Federal', 'CONSIDERANDO'],
      rectificationOriginal: [], rectificationCorrected: [] },
    quotes: { open: ['"', '“'], close: ['"', '”'], closeSuffix: ['(NR)'] },
    labels: { annex: ['ANEXO'], clause: ['Cláusula', 'Clausula'], article: ['Art.', 'Artigo'], paragraph: ['§', 'Parágrafo único', 'Paragrafo único', 'Parágrafo unico', 'Paragrafo unico'] },
    ncm: { markers: ['NCM', 'NCM/SH'], columnHeaders: ['NCM', 'NCM/SH', 'CÓDIGO NCM', 'CODIGO NCM', 'CÓDIGO NCM/SH', 'CODIGO NCM/SH'], columnBlockers: ['NBM', 'TIPI', 'SH', 'CÓDIGO', 'CODIGO'] },
    lists: { tokens: ['até', 'ate', 'a', 'e', 'ou', 'exceto', 'excetuado', 'excetuada', 'excetuados', 'excetuadas', 'excluído', 'excluída', 'excluídos', 'excluídas',
      'excluido', 'excluida', 'excluidos', 'excluidas', 'salvo', 'exclusive', 'inclusive', 'de'] },
    ranges: { operators: ['a', 'até', 'ate', '-', '–', '—'] },
    exceptions: { markers: ['exceto', 'excetuado', 'excetuada', 'excetuados', 'excetuadas', 'excluído', 'excluída', 'excluídos', 'excluídas', 'excluido', 'excluida', 'excluidos', 'excluidas', 'salvo', 'exclusive'] },
    table: { ambiguousGeometry: 'unknown_partial' },
  } },
  { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'CONFAZ' }, fields: {
    classes: { historical: ['RedaoAnt', 'RemissoAnt', 'A8-2RemissaoAnt', 'A8-3RedacaoAnt'],
      editorialNote: ['DataPublicao', 'A2DataPublicacao', 'Remisso', 'RemissoAnt', 'A8-1Remissao', 'A8-2RemissaoAnt'],
      body: ['TextoAcordo', 'A5-1TextoAcordo', 'RedaoAnt', 'A8-3RedacaoAnt'], epigraph: ['TituloAcordo'], summary: ['Ementa'] },
  } },
  { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'DOU' }, fields: {
    classes: { epigraph: ['identifica'], summary: ['ementa'], signature: ['assina', 'cargo'] },
    blockStarts: { rectificationOriginal: ['Onde se lê', 'Onde se le'], rectificationCorrected: ['Leia-se'] },
  } },
] as AnatomyProfile[]);
