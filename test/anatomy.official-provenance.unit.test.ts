import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_SAMPLES } from '../src/modules/anatomy/config/config.service.js';
import { assertOfficialSamples, validateOfficialSamples } from '../src/modules/anatomy/config/official-provenance.js';
import { SYNTHETIC_SAMPLES, type SampleInput } from '../src/modules/anatomy/config/sample-inputs.js';

/** ANAT-OFFICIAL-01: the provenance gate. The sample below is a shape only (example.invalid content), not an official act. */
const official = (over: Partial<SampleInput> = {}, prov: Record<string, string> = {}): SampleInput => ({
  id: 'ofc-confaz-teste', documentId: 'ofc-confaz-teste', version: 'v1', title: 'Forma de teste', source: 'CONFAZ', family: null,
  format: 'html', content: '<p>conteúdo de forma</p>', covers: ['forma'],
  provenance: { kind: 'official', url: 'https://www.confaz.fazenda.gov.br/legislacao/x', consultedAt: '2026-10-30', version: 'texto compilado',
    reason: 'Exercita notas de alteração do CONFAZ.', ...prov } as SampleInput['provenance'],
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
  assert.match(msgs(official({ documentId: 'ofc-convenio-icms-52-91' })).join(), /ANAT-03/u);
  assert.match(validateOfficialSamples([official(), official()], '2026-10-31').map((i) => i.message).join(), /repetido/u);
});

test('the gate fails closed and the shipped OFFICIAL_SAMPLES pass it', () => {
  assert.throws(() => assertOfficialSamples([official({}, { url: 'https://example.invalid/x' })]), /procedência incompleta/u);
  assert.deepEqual(validateOfficialSamples(OFFICIAL_SAMPLES), []);
});
