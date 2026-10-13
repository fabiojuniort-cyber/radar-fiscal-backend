import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMgWeeklyCadastro, lookupMgWeeklyCadastro,
  readAuthorizedMgWeeklyCadastro,
} from '../src/modules/company/mg-weekly-cadastro.js';
import { lookupStateRegistration } from '../src/modules/company/state-registration.service.js';

const CONTENT = [
  'Inscrição Estadual;CNPJ;Nome do Contribuinte;Situação Cadastral;CNAE',
  '001234567890;12.345.678/0001-95;"Empreendimentos; Brasil";H;0111303',
  '009876543210;98.765.432/0001-10;Contribuinte Inativo;N;4632001',
].join('\r\n');
const DATE = '2026-10-10T12:00:00Z';
test('T06 MG parses SEF weekly semicolon format, quoted names, leading zeros', () => {
  const snapshot = parseMgWeeklyCadastro(CONTENT, DATE);
  assert.equal(snapshot.entries.size, 2);
  const found = lookupMgWeeklyCadastro(snapshot, '12.345.678/0001-95', new Date('2026-10-12T12:00:00Z'));
  assert.deepEqual({
    registration:found.registration, registrationStatus:found.registrationStatus,
    status:found.lookupStatus, source:found.source,
  }, {
    registration:'001234567890',registrationStatus:'HABILITADO',
    status:'SUCCESS',source:'SEF_MG_WEEKLY_CADASTRO',
  });
  const disabled = lookupMgWeeklyCadastro(snapshot, '98.765.432/0001-10', new Date('2026-10-12T12:00:00Z'));
  assert.equal(disabled.registrationStatus, 'NAO_HABILITADO');
});
test('T06 MG never promotes missing, conflicting or stale data to known absence', () => {
  const snapshot = parseMgWeeklyCadastro(CONTENT, DATE);
  assert.equal(lookupMgWeeklyCadastro(snapshot,'11.111.111/0001-91',new Date('2026-10-12T12:00:00Z')).lookupStatus,'UNAVAILABLE');
  assert.equal(lookupMgWeeklyCadastro(snapshot,'12.345.678/0001-95',new Date('2026-11-01T12:00:00Z')).lookupStatus,'UNAVAILABLE');
  const multiple = parseMgWeeklyCadastro(CONTENT + '\n003333333333;12.345.678/0001-95;Outra IE;H;0111303',DATE);
  assert.equal(lookupMgWeeklyCadastro(multiple,'12345678000195',new Date('2026-10-12T12:00:00Z')).lookupStatus,'UNAVAILABLE');
});
test('T06 MG fail-closed when CSV is truncated/malformed/ambiguous', () => {
  assert.throws(()=>parseMgWeeklyCadastro('abc;123',DATE),/MG_FILE_EMPTY_OR_TRUNCATED/);
  assert.throws(()=>parseMgWeeklyCadastro(CONTENT.replace('Contribuinte Inativo;N;4632001','Contribuinte Inativo;X;4632001'),DATE),/MG_CSV_VALUE_INVALID/);
  assert.throws(()=>parseMgWeeklyCadastro(CONTENT+'\n001234567890;12345678000195;Conflito;N;0111303',DATE),/MG_FILE_CONFLICTING/);
  assert.throws(()=>parseMgWeeklyCadastro(CONTENT+'\n"sem fechamento;1234',DATE),/MG_CSV_UNCLOSED_QUOTE/);
});
test('T06 preserves GO and manual fallback for MG/other UFs by default', async () => {
  const before = process.env.T06_MG_WEEKLY_REUSE_APPROVED;
  delete process.env.T06_MG_WEEKLY_REUSE_APPROVED;
  try {
    for (const uf of ['MG','BA','MS','MT','PI','PA','TO','MA','SP','RJ']) {
      const result = await lookupStateRegistration('12.345.678/0001-95',uf,async () => {
        throw new Error('No network expected');
      });
      assert.equal(result.lookupStatus,'NOT_SUPPORTED');
      assert.equal(result.registration,null);
    }
  } finally {
    if (before === undefined) delete process.env.T06_MG_WEEKLY_REUSE_APPROVED;
    else process.env.T06_MG_WEEKLY_REUSE_APPROVED = before;
  }
});
test('T06 blocks loading SEF MG file until separate rights approval',async()=>{
  const was = process.env.T06_MG_WEEKLY_REUSE_APPROVED;
  delete process.env.T06_MG_WEEKLY_REUSE_APPROVED;
  try {
    await assert.rejects(readAuthorizedMgWeeklyCadastro('/tmp/nonexistent',DATE),/MG_WEEKLY_REUSE_NOT_APPROVED/);
  } finally {
    if (was === undefined) delete process.env.T06_MG_WEEKLY_REUSE_APPROVED;
    else process.env.T06_MG_WEEKLY_REUSE_APPROVED = was;
  }
});
