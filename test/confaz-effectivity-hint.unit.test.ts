import assert from 'node:assert/strict';
import test from 'node:test';

import {parseConfazEffectivityHint} from '../src/modules/taxonomy/legal-scope/confaz-effectivity-hint.js';

test('TAX13 CONFAZ 52/91: 2026 new wording and predecessor have distinct intervals', () => {
  const newer = parseConfazEffectivityHint(
    'Nova redação dada ao §2º da cláusula quarta-feira pelo Conv. ICMS 10/26, efeitos a partir de 01.05.26.',
  );
  assert.deepEqual(newer, {
    kind:'NEW_WORDING', from:'2026-05-01', through:null,
    modifyingAct:'Conv. ICMS 10/26',
    evidenceLevel:'EDITORIAL_HINT_ONLY',canAttestCurrent:false,
  });
  const prior = parseConfazEffectivityHint(
    'Redação anterior acrescida do §2º da cláusula quarta pelo Conv. 165/21, efeitos de 26.10.21 a 30.04.26.',
  );
  assert.equal(prior?.kind,'PREVIOUS_WORDING');
  assert.equal(prior?.from,'2021-10-26');
  assert.equal(prior?.through,'2026-04-30');
  assert.equal(prior?.canAttestCurrent,false);
});

test('TAX13 CONFAZ 52/91: revoked annex subitem is only an editorial hint', () => {
  const result = parseConfazEffectivityHint(
    'Revogado o subitem 40.2 do Anexo I pelo Conv. ICMS 154/15, efeitos a partir de 30.12.15.',
  );
  assert.equal(result?.kind,'REVOKED');
  assert.equal(result?.from,'2015-12-30');
  assert.equal(result?.modifyingAct,'Conv. ICMS 154/15');
  assert.equal(result?.canAttestCurrent,false);
});

test('TAX13 CONFAZ date interval and historical notes reject malformed/inverted effects', () => {
  assert.equal(parseConfazEffectivityHint(
    'Redação anterior pelo Conv. ICMS 89/09, efeitos de 15.10.09 a 22.04.10.',
  )?.through,'2010-04-22');
  assert.equal(parseConfazEffectivityHint(
    'Redação anterior efeitos de 31.02.2015 a 10.03.2015',
  ),null);
  assert.equal(parseConfazEffectivityHint(
    'Redação anterior efeitos de 10.01.2015 a 09.01.2015',
  ),null);
  assert.equal(parseConfazEffectivityHint(
    'Máquinas para irrigação NCM 8424.81.21',
  ),null);
  assert.equal(parseConfazEffectivityHint(
    'Efeitos a partir de 01.05.26.',
  ),null);
  assert.equal(parseConfazEffectivityHint(
    'Redação anterior efeitos até 30.09.19',
  )?.through, '2019-09-30');
});
