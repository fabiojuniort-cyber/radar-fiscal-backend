import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { DEFAULT_PROFILES, resolveEffectiveProfile } from '../src/modules/anatomy/profile.js';
import { RESERVED_ENTRY_IDS } from '../src/modules/anatomy/rules-simulation.js';
import { SAMPLE_ANNOTATIONS } from '../src/modules/anatomy/config/sample-annotations.js';
import { SYNTHETIC_SAMPLES } from '../src/modules/anatomy/config/sample-inputs.js';
import { applyChanges, ConfigValidationError, FIELD_CATALOG, styleOf, suggestRules, validateConfiguration, type Change } from '../src/modules/anatomy/config/rules.js';
import { describeResult, diffDescribed, documentHash, type Correction } from '../src/modules/anatomy/config/view.js';

/** ANAT-CONFIG-01: pure parts of the accessible configuration (guided changes, validation, translation, samples). */
const shipped = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
const run = (id: string, profiles: unknown[], corrections: Correction[] = []) => {
  const s = SYNTHETIC_SAMPLES.find((x) => x.id === id)!;
  const r = analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-10-28', ruleSet: { id: 't', version: '1' }, profiles,
    input: { source: s.source, representationId: id, ...(s.format === 'html' ? { html: s.content } : { text: s.content }) } });
  return describeResult(s, r, SAMPLE_ANNOTATIONS[id] ?? [], corrections);
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

test('corrections: applied on top of the engine result to the exact document version and passage only', () => {
  const conv = SYNTHETIC_SAMPLES.find((x) => x.id === 'sint-confaz-convenio')!;
  const sig = run(conv.id, shipped()).passages.find((p) => p.text.startsWith('Presidente do CONFAZ'))!;
  assert.equal(sig.nature, 'operative');
  const c: Correction = { documentId: conv.documentId, documentHash: documentHash(conv.content), partKey: sig.key, expected: 'structure', reason: 'É a assinatura', author: 'u1', createdAt: 't', sinceVersion: 1 };
  // Applied: the engine result is kept and the correction is shown apart.
  const d = run(conv.id, shipped(), [c]);
  const p = d.passages.find((x) => x.key === sig.key)!;
  assert.deepEqual([p.nature, p.effectiveNature, p.correction?.reason, p.correction?.sinceVersion], ['operative', 'structure', 'É a assinatura', 1]);
  assert.equal(d.corrections.applied.length, 1); assert.equal(d.review.some((r) => r.partKey === sig.key), false);
  // A similar document with the same line is NOT corrected (a correction is never widened).
  const other = run('sint-confaz-convenio-outro', shipped(), [c]);
  const sig2 = other.passages.find((x) => x.text.startsWith('Presidente do CONFAZ'))!;
  assert.deepEqual([sig2.effectiveNature, sig2.correction, other.corrections.applied.length, other.corrections.stale.length], ['operative', null, 0, 0]);
  // A modified version of the same document does not receive it silently: it is reported stale.
  const v2 = run('sint-confaz-convenio-v2', shipped(), [c]);
  assert.equal(v2.passages.some((x) => x.correction), false);
  assert.deepEqual(v2.corrections.stale.map((x) => x.why), ['document_changed']);
  assert.ok(v2.review.some((r) => r.kind === 'stale_correction' && /O documento mudou/u.test(r.detail)));
  // Same version but a passage that no longer exists: stale, not applied.
  const gone = run(conv.id, shipped(), [{ ...c, partKey: '0'.repeat(16) }]);
  assert.deepEqual(gone.corrections.stale.map((x) => x.why), ['passage_not_found']);
});

test('CONFIG-R2-01: repeated identical passages get distinct identities; a correction hits only the intended occurrence', () => {
  const content = '<html><body><p class="TituloAcordo">CONVÊNIO ICMS EXEMPLO Nº 903, DE 1 DE JUNHO DE 2099</p>'
    + '<p class="TextoAcordo">Cláusula primeira Fica autorizado o teste.</p><p class="TextoAcordo">Assinatura</p>'
    + '<p class="TextoAcordo">Cláusula segunda Este convênio entra em vigor na data da publicação.</p><p class="TextoAcordo">Assinatura</p></body></html>';
  const doc = { id: 'rep', documentId: 'rep', content };
  const r = analyzeAnatomy({ publicationVersionId: 'rep', referenceDate: '2026-10-28', ruleSet: { id: 't', version: '1' }, profiles: shipped(), input: { source: 'CONFAZ', representationId: 'rep', html: content } });
  const base = describeResult(doc, r, []);
  const sigs = base.passages.filter((p) => p.text === 'Assinatura');
  assert.equal(sigs.length, 2);
  assert.notEqual(sigs[0]!.key, sigs[1]!.key, 'identical text, different identity');
  assert.equal(new Set(base.passages.map((p) => p.key)).size, base.passages.length, 'every passage key is unique');
  const c: Correction = { documentId: 'rep', documentHash: documentHash(content), partKey: sigs[1]!.key, expected: 'structure', reason: 'Segunda assinatura', author: 'u', createdAt: 't' };
  const out = describeResult(doc, r, [], [c]);
  const [first, second] = out.passages.filter((p) => p.text === 'Assinatura');
  assert.deepEqual([first!.correction, first!.effectiveNature], [null, first!.nature], 'the first occurrence is untouched');
  assert.equal(second!.effectiveNature, 'structure');
  assert.equal(second!.nature, sigs[1]!.nature, 'engine result kept');
  // The pre-fix key (document + text only) no longer resolves: it is reported, never applied to the first occurrence.
  const legacy = createHash('sha256').update(`rep|Assinatura`, 'utf8').digest('hex').slice(0, 16);
  const old = describeResult(doc, r, [], [{ ...c, partKey: legacy }]);
  assert.equal(old.passages.some((p) => p.correction), false);
  assert.deepEqual(old.corrections.stale.map((x) => x.why), ['passage_not_found']);
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
