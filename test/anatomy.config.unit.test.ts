import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { DEFAULT_PROFILES, resolveEffectiveProfile } from '../src/modules/anatomy/profile.js';
import { RESERVED_ENTRY_IDS } from '../src/modules/anatomy/rules-simulation.js';
import { SAMPLE_ANNOTATIONS } from '../src/modules/anatomy/config/sample-annotations.js';
import { SYNTHETIC_SAMPLES } from '../src/modules/anatomy/config/sample-inputs.js';
import { applyChanges, ConfigValidationError, FIELD_CATALOG, styleOf, suggestRules, validateConfiguration, type Change } from '../src/modules/anatomy/config/rules.js';
import { describeResult, diffDescribed } from '../src/modules/anatomy/config/view.js';

/** ANAT-CONFIG-01: pure parts of the accessible configuration (guided changes, validation, translation, samples). */
const shipped = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
const run = (id: string, profiles: unknown[]) => {
  const s = SYNTHETIC_SAMPLES.find((x) => x.id === id)!;
  const r = analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-10-28', ruleSet: { id: 't', version: '1' }, profiles,
    input: { source: s.source, representationId: id, ...(s.format === 'html' ? { html: s.content } : { text: s.content }) } });
  return describeResult(id, r, SAMPLE_ANNOTATIONS[id] ?? []);
};
const NOTE: Change = { scope: { level: 'source', source: 'CONFAZ' }, path: 'classes.editorialNote', action: 'add', literal: 'NotaAlteracao' };

test('catalog covers every editable list of ANAT-PROFILE/1, in Portuguese, with an example', () => {
  const fields = Object.entries((DEFAULT_PROFILES[0]!.fields as Record<string, Record<string, unknown>>))
    .flatMap(([g, v]) => Object.keys(v).map((f) => `${g}.${f}`)).filter((p) => p !== 'table.ambiguousGeometry').sort();
  assert.deepEqual(FIELD_CATALOG.map((f) => f.path).sort(), fields);
  for (const f of FIELD_CATALOG) { assert.ok(f.title && f.help && f.example, f.path); assert.doesNotMatch(f.title, /[{}[\]]/u); }
});

test('guided change: adding at a scope keeps the inherited literals and does not touch other scopes or the input', () => {
  const base = shipped(); const copy = structuredClone(base);
  const out = applyChanges(base, [NOTE]);
  assert.deepEqual(base, copy, 'input not mutated');
  const confaz = resolveEffectiveProfile(out, { source: 'CONFAZ' }).fields.classes.editorialNote;
  assert.ok(confaz.includes('NotaAlteracao') && confaz.includes('Remisso'));
  assert.equal(resolveEffectiveProfile(out, { source: 'DOU' }).effectiveHash, resolveEffectiveProfile(shipped(), { source: 'DOU' }).effectiveHash);
  // A new family scope inherits default → source before adding.
  const fam = applyChanges(base, [{ scope: { level: 'family', source: 'CONFAZ', family: 'Ajuste SINIEF' }, path: 'classes.editorialNote', action: 'add', literal: 'NotaAjuste' }]);
  const eff = resolveEffectiveProfile(fam, { source: 'CONFAZ', family: 'Ajuste SINIEF' }).fields.classes.editorialNote;
  assert.ok(eff.includes('Remisso') && eff.includes('NotaAjuste'));
  // Undo = the inverse change.
  assert.equal(resolveEffectiveProfile(applyChanges(out, [{ ...NOTE, action: 'remove' }]), { source: 'CONFAZ' }).effectiveHash,
    resolveEffectiveProfile(shipped(), { source: 'CONFAZ' }).effectiveHash);
});

test('specific messages in Portuguese for incomplete or invalid input', () => {
  const issues = (changes: Change[]) => { try { validateConfiguration(applyChanges(shipped(), changes)); return []; } catch (e) { assert.ok(e instanceof ConfigValidationError); return e.issues.map((i) => i.message); } };
  assert.match(issues([{ ...NOTE, literal: ' ' }])[0]!, /Informe o texto para "Estilo de nota editorial"/u);
  assert.match(issues([{ ...NOTE, literal: 'Nota Alteracao' }])[0]!, /não pode ter espaço/u);
  assert.match(issues([{ ...NOTE, path: 'classes.nope' }])[0]!, /Campo desconhecido/u);
  assert.match(issues([{ ...NOTE, literal: 'Remisso' }])[0]!, /já está/u);
  assert.match(issues([{ ...NOTE, action: 'remove', literal: 'Remisso' }])[0]!, /"Remisso" é proteção de fábrica em estilo de nota editorial/u);
  assert.match(issues([{ scope: { level: 'default' }, path: 'quotes.close', action: 'add', literal: '»' }])[0]!, /fecharia textos citados/u);
  assert.match(issues([{ ...NOTE, action: 'remove', literal: 'Inexistente' }])[0]!, /não está/u);
  assert.match(issues([{ ...NOTE, literal: 'x'.repeat(65) }])[0]!, /formato inválido/u);
  assert.deepEqual(issues([NOTE]), []);
});

test('describeResult: structure, nature and validity are separate; a note never sets validity; review list explains', () => {
  const before = run('sint-confaz-estilo-novo', shipped());
  const note = before.passages.find((p) => p.text.startsWith('Acrescentado'))!;
  assert.deepEqual([note.nature, note.validity], ['ambiguous', 'unknown']);
  assert.ok(before.review.some((r) => r.kind === 'not_recognized' && r.partKey === note.key && /Leitura da IA: Nota editorial/u.test(r.detail)));
  const after = run('sint-confaz-estilo-novo', applyChanges(shipped(), [NOTE]));
  const note2 = after.passages.find((p) => p.key === note.key)!;
  assert.deepEqual([note2.nature, note2.validity, note2.ai?.nature], ['editorial_note', 'unknown', 'editorial_note']);
  const clause = after.passages.find((p) => p.text.startsWith('Cláusula primeira'))!;
  assert.deepEqual([clause.nature, clause.validity], ['operative', 'unknown'], 'the "Acrescentado pelo" note does not make the clause current');
  const d = diffDescribed(before, after);
  assert.deepEqual(d.changed.map((c) => [c.fromLabel, c.toLabel]), [['A conferir (não reconhecido)', 'Nota editorial']]);
  assert.ok(d.reviewAfter < d.reviewBefore);
  // Historical text, quoted text of another act, references and NCM are shown apart.
  const conv = run('sint-confaz-convenio', shipped());
  assert.equal(conv.passages.find((p) => p.text.includes('9031.80.00'))!.nature, 'historical');
  const port = run('sint-dou-portaria', shipped());
  assert.equal(port.passages.find((p) => p.text.startsWith('"Art. 5º'))!.nature, 'amendment');
  assert.deepEqual(port.passages.find((p) => p.text.startsWith('Art. 1º'))!.references, ['Portaria Exemplo nº 10']);
  assert.deepEqual(port.passages.find((p) => p.text.startsWith('Art. 2º'))!.ai!.references, ['art. 3º da Lei Exemplo nº 1.234, de 2080']);
  assert.ok(conv.passages.find((p) => p.text.startsWith('Cláusula primeira Fica'))!.ncm.includes('9031.80.99'));
  // Plain text the engine cannot segment is a stated limitation, not a configuration problem.
  assert.ok(run('sint-doe-sp-resolucao', shipped()).review.some((r) => r.kind === 'limitation' && /limitação do motor/u.test(r.title)));
});

test('corrections: a passage correction is an expectation; unmet corrections are listed, met ones are not', () => {
  const before = run('sint-confaz-estilo-novo', shipped());
  const key = before.passages.find((p) => p.text.startsWith('Acrescentado'))!.key;
  const s = SYNTHETIC_SAMPLES.find((x) => x.id === 'sint-confaz-estilo-novo')!;
  const r = analyzeAnatomy({ publicationVersionId: s.id, referenceDate: '2026-10-28', ruleSet: { id: 't', version: '1' }, profiles: shipped(), input: { source: 'CONFAZ', representationId: s.id, html: s.content } });
  const withCorr = describeResult(s.id, r, SAMPLE_ANNOTATIONS[s.id]!, [{ sampleId: s.id, partKey: key, expected: 'editorial_note' }]);
  assert.ok(withCorr.review.some((x) => x.kind === 'correction_unmet' && x.partKey === key));
  const r2 = analyzeAnatomy({ publicationVersionId: s.id, referenceDate: '2026-10-28', ruleSet: { id: 't', version: '1' }, profiles: applyChanges(shipped(), [NOTE]), input: { source: 'CONFAZ', representationId: s.id, html: s.content } });
  assert.equal(describeResult(s.id, r2, SAMPLE_ANNOTATIONS[s.id]!, [{ sampleId: s.id, partKey: key, expected: 'editorial_note' }]).review.some((x) => x.partKey === key), false);
});

test('suggestions come from the passage itself and only use supported mechanisms', () => {
  const s = SYNTHETIC_SAMPLES.find((x) => x.id === 'sint-confaz-estilo-novo')!;
  assert.equal(styleOf(s, 'Acrescentado pelo Ajuste SINIEF'), 'NotaAlteracao');
  const out = suggestRules(s, 'Acrescentado pelo Ajuste SINIEF Exemplo 45/99', 'editorial_note');
  assert.equal(out.suggestions.length, 1); assert.match(out.suggestions[0]!.why, /estilo "NotaAlteracao"/u);
  const none = suggestRules(SYNTHETIC_SAMPLES.find((x) => x.id === 'sint-doe-sp-resolucao')!, 'RESOLUÇÃO', 'historical');
  assert.deepEqual(none.suggestions, []); assert.match(none.unsupported!, /correção do trecho/u);
});

test('samples are synthetic, annotated with evidence and a second check, and never use reserved corpus IDs', () => {
  assert.ok(SYNTHETIC_SAMPLES.length >= 6);
  const sources = new Set(SYNTHETIC_SAMPLES.map((s) => s.source));
  for (const src of ['CONFAZ', 'DOU', 'DOE-SP', 'RFB']) assert.ok(sources.has(src as never), src);
  for (const s of SYNTHETIC_SAMPLES) {
    assert.equal(s.provenance.kind, 'synthetic', s.id);
    assert.ok(!RESERVED_ENTRY_IDS.includes(s.id) && !/^\d+$/u.test(s.id), s.id);
    const ann = SAMPLE_ANNOTATIONS[s.id]; assert.ok(ann && ann.length > 0, s.id);
    for (const a of ann) { assert.ok(a.evidence && a.explanation && a.secondCheck.note, `${s.id} ${a.anchor}`); if (a.nature === 'ambiguous') assert.ok(a.ambiguity, a.anchor); }
    // Every annotation matches a passage of the engine output (no orphan reading).
    const d = run(s.id, shipped());
    for (const a of ann) assert.ok(d.passages.some((p) => p.ai?.anchor === a.anchor), `${s.id}: "${a.anchor}" not matched`);
  }
});
