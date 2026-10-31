import { DEFAULT_PROFILES, PROFILE_SOURCES, ProfileValidationError, resolveEffectiveProfile, validateProfile, type ProfileScope } from '../profile.js';
import type { Nature } from './sample-annotations.js';
import type { SampleInput } from './sample-inputs.js';

/**
 * ANAT-CONFIG-01: the configuration as the administrator sees it. Every editable list of ANAT-PROFILE/1 is described
 * in Portuguese with an example and the nature it produces; a change is a guided operation (add/remove a literal in
 * one field, at one scope), never JSON. The server applies the operations to the version in force and validates the
 * result with the engine's own validator (protections, limits, conflicts) before preview or save.
 */
export interface FieldInfo { path: string; group: string; field: string; title: string; help: string; example: string; produces: Nature | 'structure_label' | 'ncm'; kind: 'style' | 'start' | 'quote' | 'label' | 'ncm' }
export const FIELD_CATALOG: readonly FieldInfo[] = Object.freeze([
  { path: 'classes.historical', title: 'Estilo de redação anterior', help: 'Blocos com este estilo são redação anterior (histórico): ficam fora do texto atual.', example: 'RedaoAnt', produces: 'historical', kind: 'style' },
  { path: 'classes.editorialNote', title: 'Estilo de nota editorial', help: 'Blocos com este estilo são notas do editor (ex.: "Nova redação dada…"). Não são texto normativo e não decidem a vigência do dispositivo.', example: 'Remisso', produces: 'editorial_note', kind: 'style' },
  { path: 'classes.body', title: 'Estilo de texto do ato', help: 'Blocos com este estilo são corpo do ato.', example: 'TextoAcordo', produces: 'operative', kind: 'style' },
  { path: 'classes.epigraph', title: 'Estilo de epígrafe (título do ato)', help: 'Blocos com este estilo são o título que identifica o ato.', example: 'TituloAcordo', produces: 'structure', kind: 'style' },
  { path: 'classes.summary', title: 'Estilo de ementa', help: 'Blocos com este estilo são a ementa (resumo do ato).', example: 'Ementa', produces: 'structure', kind: 'style' },
  { path: 'classes.signature', title: 'Estilo de assinatura', help: 'Blocos com este estilo são assinatura ou cargo do signatário.', example: 'assina', produces: 'structure', kind: 'style' },
  { path: 'blockStarts.preamble', title: 'Início de preâmbulo', help: 'Bloco que começa com estas palavras é o preâmbulo (fórmula de abertura).', example: 'O Conselho', produces: 'structure', kind: 'start' },
  { path: 'blockStarts.rectificationOriginal', title: 'Início do texto errado (retificação)', help: 'Bloco que começa assim traz o texto que está sendo corrigido.', example: 'Onde se lê', produces: 'amendment', kind: 'start' },
  { path: 'blockStarts.rectificationCorrected', title: 'Início do texto corrigido (retificação)', help: 'Bloco que começa assim traz o texto correto.', example: 'Leia-se', produces: 'amendment', kind: 'start' },
  { path: 'quotes.open', title: 'Aspas que abrem texto citado', help: 'Bloco que abre com este sinal é texto de outro ato (nova redação).', example: '“', produces: 'amendment', kind: 'quote' },
  { path: 'quotes.close', title: 'Aspas que fecham texto citado', help: 'Sinal que fecha o texto citado. Só é aceito um sinal que a configuração de fábrica já reconhece.', example: '”', produces: 'amendment', kind: 'quote' },
  { path: 'quotes.closeSuffix', title: 'Marca depois do texto citado', help: 'Marca que aparece depois das aspas de fechamento.', example: '(NR)', produces: 'amendment', kind: 'quote' },
  { path: 'labels.article', title: 'Rótulo de artigo', help: 'Palavra que abre um artigo.', example: 'Art.', produces: 'structure_label', kind: 'label' },
  { path: 'labels.clause', title: 'Rótulo de cláusula', help: 'Palavra que abre uma cláusula.', example: 'Cláusula', produces: 'structure_label', kind: 'label' },
  { path: 'labels.paragraph', title: 'Rótulo de parágrafo', help: 'Palavra ou sinal que abre um parágrafo.', example: '§', produces: 'structure_label', kind: 'label' },
  { path: 'labels.annex', title: 'Rótulo de anexo', help: 'Palavra que abre um anexo.', example: 'ANEXO', produces: 'structure_label', kind: 'label' },
  { path: 'ncm.markers', title: 'Palavra antes de códigos NCM', help: 'Palavra que anuncia uma lista de códigos NCM no texto.', example: 'NCM', produces: 'ncm', kind: 'ncm' },
  { path: 'ncm.columnHeaders', title: 'Cabeçalho de coluna NCM', help: 'Cabeçalho de tabela que indica coluna de códigos NCM.', example: 'CÓDIGO NCM', produces: 'ncm', kind: 'ncm' },
  { path: 'ncm.columnBlockers', title: 'Cabeçalho que não é NCM', help: 'Cabeçalho de coluna que NÃO deve ser lido como NCM (ex.: NBM, TIPI).', example: 'NBM', produces: 'ncm', kind: 'ncm' },
  { path: 'lists.tokens', title: 'Palavra dentro de lista de códigos', help: 'Palavra que pode aparecer entre códigos de uma mesma lista.', example: 'e', produces: 'ncm', kind: 'ncm' },
  { path: 'ranges.operators', title: 'Ligação de faixa de códigos', help: 'O que liga dois códigos numa faixa (ex.: "a", "até").', example: 'até', produces: 'ncm', kind: 'ncm' },
  { path: 'exceptions.markers', title: 'Palavra que abre exceção', help: 'Palavra que exclui códigos (ex.: "exceto").', example: 'exceto', produces: 'ncm', kind: 'ncm' },
].map((f) => { const [group, field] = f.path.split('.') as [string, string]; return { ...f, group, field } as FieldInfo; }));
const FIELD = new Map(FIELD_CATALOG.map((f) => [f.path, f]));

export type Scope = { level: 'default' } | { level: 'source'; source: (typeof PROFILE_SOURCES)[number] } | { level: 'family'; source: (typeof PROFILE_SOURCES)[number]; family: string };
export interface Change { scope: Scope; path: string; action: 'add' | 'remove'; literal: string }
export const SOURCE_PT: Record<string, string> = { CONFAZ: 'CONFAZ', DOU: 'Diário Oficial da União', 'DOE-SP': 'Diário Oficial de SP', RFB: 'Receita Federal' };
export const scopePt = (s: Scope) => (s.level === 'default' ? 'Padrão geral (todas as fontes)' : s.level === 'source' ? `Fonte: ${SOURCE_PT[s.source]}` : `Família "${s.family}" da fonte ${SOURCE_PT[s.source]}`);
export function describeChange(c: Change): string {
  const f = FIELD.get(c.path); const what = f ? f.title.toLowerCase() : c.path;
  return `${c.action === 'add' ? 'Incluir' : 'Retirar'} "${c.literal}" em ${what} — ${scopePt(c.scope)}`;
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: { message: string; change?: number }[]) { super('invalid_configuration'); this.name = 'ConfigValidationError'; }
}
const sameScope = (a: ProfileScope, b: Scope) => a.level === b.level && (a.level === 'default' || (a.source === (b as { source: string }).source
  && (a.level === 'source' || (a as { family: string }).family === (b as { family: string }).family)));

/** Applies the guided changes to a copy of `profiles`. Shape errors are reported in Portuguese, per change. */
export function applyChanges(profiles: readonly unknown[], changes: readonly Change[]): unknown[] {
  const out = structuredClone([...profiles]) as { profileVersion: string; scope: ProfileScope; fields: Record<string, Record<string, string[]>> }[];
  const issues: { message: string; change?: number }[] = [];
  changes.forEach((c, i) => {
    const f = FIELD.get(c.path);
    if (!f) { issues.push({ change: i, message: `Campo desconhecido: ${c.path}.` }); return; }
    const literal = typeof c.literal === 'string' ? c.literal.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
    if (!literal) { issues.push({ change: i, message: `Informe o texto para "${f.title}".` }); return; }
    if (f.kind === 'style' && /\s/u.test(literal)) { issues.push({ change: i, message: `Nome de estilo não pode ter espaço: "${literal}". Use o nome exatamente como aparece no ato (ex.: ${f.example}).` }); return; }
    let profile = out.find((p) => sameScope(p.scope, c.scope));
    if (!profile) {
      if (c.action === 'remove') { issues.push({ change: i, message: `Não há "${literal}" em ${f.title.toLowerCase()} para ${scopePt(c.scope)}.` }); return; }
      profile = { profileVersion: 'ANAT-PROFILE/1', scope: structuredClone(c.scope) as ProfileScope, fields: {} }; out.push(profile);
    }
    // A more specific scope that does not define the field inherits it: start from the inherited list, so adding one
    // literal never silently drops the inherited ones.
    let list = profile.fields[f.group]?.[f.field];
    if (!list) {
      list = [...inheritedList(out, c.scope, f.group, f.field)];
    }
    const has = list.includes(literal);
    if (c.action === 'add') { if (has) { issues.push({ change: i, message: `"${literal}" já está em ${f.title.toLowerCase()} (${scopePt(c.scope)}).` }); return; } list = [...list, literal]; }
    else { if (!has) { issues.push({ change: i, message: `"${literal}" não está em ${f.title.toLowerCase()} (${scopePt(c.scope)}).` }); return; } list = list.filter((x) => x !== literal); }
    profile.fields[f.group] = { ...(profile.fields[f.group] ?? {}), [f.field]: list };
  });
  if (issues.length) throw new ConfigValidationError(issues);
  return out;
}
function inheritedList(profiles: { scope: ProfileScope; fields: Record<string, Record<string, string[]>> }[], scope: Scope, group: string, field: string): string[] {
  const chain: Scope[] = scope.level === 'default' ? [] : scope.level === 'source' ? [{ level: 'default' }] : [{ level: 'default' }, { level: 'source', source: scope.source }];
  let list: string[] = [];
  for (const s of chain) { const v = profiles.find((p) => sameScope(p.scope, s))?.fields[group]?.[field]; if (v) list = v; }
  return list;
}

const PT_CODE: Record<string, string> = {
  protection_weakened: 'retira uma proteção de fábrica', semantic_conflict: 'repete um item ou entra em conflito com outro', effective_conflict: 'entra em conflito com outra regra herdada',
  invalid_fields: 'tem um valor em formato inválido', incomplete_default: 'deixa o padrão geral incompleto', profile_too_large: 'fica grande demais', invalid_profile: 'tem formato inválido',
};
/** Validates every profile and the effective configuration of every source and family (fail closed), in Portuguese. */
export function validateConfiguration(profiles: readonly unknown[]): { effective: { source: string; family: string | null; effectiveHash: string }[] } {
  const issues: { message: string }[] = [];
  const pt = (e: unknown, where: string) => {
    if (!(e instanceof ProfileValidationError)) throw e;
    const shipped = /([a-zA-Z]+\.[a-zA-Z]+): shipped protection "([^"]+)" cannot be removed/u.exec(e.message);
    if (shipped) return issues.push({ message: `${where}: "${shipped[2]}" é proteção de fábrica em ${FIELD.get(shipped[1]!)?.title.toLowerCase() ?? shipped[1]} e não pode ser retirado.` });
    const ceiling = /([a-zA-Z]+\.[a-zA-Z]+): "([^"]+)" would close quotations/u.exec(e.message);
    if (ceiling) return issues.push({ message: `${where}: "${ceiling[2]}" fecharia textos citados que a configuração de fábrica mantém abertos; não é aceito em ${FIELD.get(ceiling[1]!)?.title.toLowerCase() ?? ceiling[1]}.` });
    const path = /([a-zA-Z]+)\.([a-zA-Z]+)/u.exec(e.message); const f = path ? FIELD.get(`${path[1]}.${path[2]}`) : undefined;
    return issues.push({ message: `${where}: a configuração ${PT_CODE[e.code] ?? 'é inválida'}${f ? ` (${f.title.toLowerCase()})` : ''}.` });
  };
  const list = [...profiles];
  if (list.length === 0 || list.length > 64) throw new ConfigValidationError([{ message: 'A configuração precisa ter entre 1 e 64 perfis.' }]);
  for (const p of list) { try { validateProfile(p); } catch (e) { pt(e, scopePt(((p as { scope?: Scope })?.scope ?? { level: 'default' }) as Scope)); } }
  const effective: { source: string; family: string | null; effectiveHash: string }[] = [];
  if (!issues.length) {
    const targets = [...PROFILE_SOURCES.map((source) => ({ source, family: null as string | null })),
      ...list.map((p) => (p as { scope: ProfileScope }).scope).filter((s): s is Extract<ProfileScope, { level: 'family' }> => s.level === 'family').map((s) => ({ source: s.source, family: s.family }))];
    for (const t of targets) {
      try { effective.push({ ...t, effectiveHash: resolveEffectiveProfile(structuredClone(list), t).effectiveHash }); } catch (e) { pt(e, t.family ? `Família "${t.family}" (${SOURCE_PT[t.source]})` : SOURCE_PT[t.source]!); }
    }
  }
  if (issues.length) throw new ConfigValidationError(issues);
  return { effective };
}

/** Reads the style (HTML class) of the block whose text starts with `text`, from the sample's own HTML. */
export function styleOf(sample: SampleInput, text: string): string | null {
  if (sample.format !== 'html') return null;
  const head = text.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`<p class="([^" ]+)">\\s*${head}`, 'u').exec(sample.content)?.[1] ?? null;
}
const STYLE_FOR: Partial<Record<Nature, string>> = { editorial_note: 'classes.editorialNote', historical: 'classes.historical', operative: 'classes.body', structure: 'classes.epigraph' };
/**
 * Rule suggestions for "tratar trechos semelhantes como <nature>". Only mechanisms the engine supports are proposed;
 * when none applies the answer says so (a passage correction is then the only option).
 */
export function suggestRules(sample: SampleInput, text: string, wanted: Nature): { suggestions: (Change & { description: string; why: string })[]; unsupported: string | null } {
  const out: (Change & { description: string; why: string })[] = [];
  const source = { level: 'source' as const, source: sample.source };
  const style = styleOf(sample, text);
  const stylePath = STYLE_FOR[wanted];
  if (style && stylePath) {
    const c = { scope: source, path: stylePath, action: 'add' as const, literal: style };
    out.push({ ...c, description: describeChange(c), why: `O bloco usa o estilo "${style}". Todos os blocos com esse estilo em atos de ${SOURCE_PT[sample.source]} passam a ser tratados assim.` });
  }
  const first = text.trim().charAt(0);
  if (wanted === 'amendment' && first && !/[\p{L}\p{N}]/u.test(first)) {
    const c = { scope: source, path: 'quotes.open', action: 'add' as const, literal: first };
    out.push({ ...c, description: describeChange(c), why: `O trecho abre com "${first}". Blocos que abrem com esse sinal passam a ser lidos como texto citado de outro ato.` });
  }
  if (wanted === 'structure') {
    const words = text.trim().split(/\s+/u).slice(0, 2).join(' ');
    if (words && /^[A-ZÀ-Ú]/u.test(words)) {
      const c = { scope: source, path: 'blockStarts.preamble', action: 'add' as const, literal: words };
      out.push({ ...c, description: describeChange(c), why: `Blocos que começam com "${words}" passam a ser preâmbulo. Use só se essa abertura não iniciar dispositivos.` });
    }
  }
  return { suggestions: out, unsupported: out.length ? null : 'A configuração não tem regra que reconheça este caso com segurança. Registre uma correção do trecho: ela fica na lista de conferência e serve de teste para regras futuras.' };
}

export const SHIPPED_PROFILES = (): unknown[] => structuredClone([...DEFAULT_PROFILES]);
