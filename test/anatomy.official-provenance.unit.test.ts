import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_SAMPLES } from '../src/modules/anatomy/config/config.service.js';
import { assertOfficialSamples, validateOfficialSamples } from '../src/modules/anatomy/config/official-provenance.js';
import { SYNTHETIC_SAMPLES, type SampleInput } from '../src/modules/anatomy/config/sample-inputs.js';

/** ANAT-OFFICIAL-01: the provenance gate. The sample below is a shape only (example.invalid content), not an official act. */
const official = (over: Partial<SampleInput> = {}, prov: Record<string, string> = {}): SampleInput => ({
  id: 'ofc-confaz-teste', documentId: 'ofc-confaz-teste', version: 'v1', title: 'Forma de teste', source: 'CONFAZ', family: null,
  format: 'html', content: '<p>conteúdo de forma</p>', covers: ['forma'],
  provenance: { kind: 'official', act: 'Convênio ICMS 142/2018', url: 'https://www.confaz.fazenda.gov.br/legislacao/x', consultedAt: '2026-10-30', version: 'texto compilado',
    reason: 'Exercita notas de alteração do CONFAZ.', snapshotSha256: 'a'.repeat(64), ...prov } as SampleInput['provenance'],
  ...over,
});
const msgs = (s: SampleInput) => validateOfficialSamples([s], '2026-10-31').map((i) => i.message);

test('complete provenance on an official host passes; synthetic samples are ignored', () => {
  assert.deepEqual(validateOfficialSamples([official(), ...SYNTHETIC_SAMPLES], '2026-10-31'), []);
});

test('each missing or wrong provenance field is reported in Portuguese', () => {
  assert.match(msgs(official({}, { url: 'http://www.confaz.fazenda.gov.br/x' }))[0]!, /https/u);
  assert.match(msgs(official({}, { url: 'https://www.legjur.com/x' }))[0]!, /fonte oficial de CONFAZ/u);
  assert.match(msgs(official({ source: 'RFB' }))[0]!, /normas\.receita\.fazenda\.gov\.br/u);
  assert.match(msgs(official({}, { url: 'nao-e-url' }))[0]!, /URL inválida/u);
  assert.match(msgs(official({}, { consultedAt: '30/10/2026' }))[0]!, /AAAA-MM-DD/u);
  assert.match(msgs(official({}, { consultedAt: '2027-01-01' }))[0]!, /futuro/u);
  assert.match(msgs(official({}, { version: ' ' }))[0]!, /versão consultada/u);
  assert.match(msgs(official({}, { reason: 'curto' }))[0]!, /motivo/u);
  assert.match(msgs(official({ content: ' ' }))[0]!, /Conteúdo vazio/u);
  assert.match(msgs(official({ covers: [] }))[0]!, /exercita/u);
});

test('ids: official prefix, no reserved corpus ids, no ANAT-03 base acts, no duplicates', () => {
  assert.match(msgs(official({ id: 'confaz-x' })).join(), /"ofc-"/u);
  assert.match(msgs(official({ documentId: '04' })).join(), /reservado/u);
  assert.match(msgs(official({}, { act: 'Convênio ICMS 52/91' })).join(), /corpus reservado/u);
  assert.match(validateOfficialSamples([official(), official()], '2026-10-31').map((i) => i.message).join(), /repetido/u);
});

test('the gate fails closed and the shipped OFFICIAL_SAMPLES pass it', () => {
  assert.throws(() => assertOfficialSamples([official({}, { url: 'https://example.invalid/x' })]), /procedência incompleta/u);
  assert.deepEqual(validateOfficialSamples(OFFICIAL_SAMPLES), []);
});

test('R1-1: reserved acts are refused under any alias (inventory keys), and unreadable identities fail closed', () => {
  for (const act of ['Convênio ICMS 52/91', 'Conv. ICMS 52/1991', 'CONVENIO ICMS Nº 52, DE 26 DE SETEMBRO DE 1991', 'convênio 100/97', 'Instrução Normativa RFB nº 2.342, de 2026', 'IN RFB 2342/2026'])
    assert.match(msgs(official({ title: act }, { act })).join(' | '), /corpus reservado/u, act);
  for (const act of ['Convênio sem número', 'Ato qualquer', '']) assert.match(msgs(official({}, { act })).join(), /ilegível/u, `"${act}"`);
  assert.match(msgs(official({ title: 'Convênio ICMS 52/91 (cópia)' })).join(), /título indica outro ato/u, 'title naming a reserved act while act says otherwise');
});

test('R1-1: an official URL naming a corpus portal id is refused even when the act name differs', () => {
  assert.match(msgs(official({ source: 'RFB' }, { act: 'IN RFB 9999/2026', url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?idAto=153828' })).join(), /corpus reservado/u);
});

test('R1-4: the snapshot SHA-256 is mandatory and well-formed', () => {
  assert.match(msgs(official({}, { snapshotSha256: '' })).join(), /SHA-256 do snapshot/u);
  assert.match(msgs(official({}, { snapshotSha256: 'XYZ' })).join(), /SHA-256 do snapshot/u);
});
