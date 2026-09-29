import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publicSignupBodySchema,
} from '../src/modules/auth/public-signup.service.js';

const strongPassword = 'Senha-Segura-2026!';

test('public signup validation accepts the required contract and normalizes CNPJ', () => {
  const parsed = publicSignupBodySchema.parse({
    name: '  Pessoa Teste  ',
    email: ' PESSOA@Example.Test ',
    company: '  Empresa Teste  ',
    cnpj: '12.345.678/0001-99',
    password: strongPassword,
    confirmPassword: strongPassword,
    acceptedTerms: true,
  });

  assert.equal(parsed.name, 'Pessoa Teste');
  assert.equal(parsed.email, 'PESSOA@Example.Test');
  assert.equal(parsed.company, 'Empresa Teste');
  assert.equal(parsed.cnpj, '12345678000199');
});

test('public signup validation rejects weak/mismatched passwords and missing consent', () => {
  for (const input of [
    {
      password: 'weak',
      confirmPassword: 'weak',
      acceptedTerms: true,
    },
    {
      password: strongPassword,
      confirmPassword: 'Outra-Senha-2026!',
      acceptedTerms: true,
    },
    {
      password: strongPassword,
      confirmPassword: strongPassword,
      acceptedTerms: false,
    },
  ]) {
    const parsed =
      publicSignupBodySchema.safeParse({
        name: 'Pessoa Teste',
        email: 'pessoa@example.test',
        company: 'Empresa Teste',
        cnpj: '',
        ...input,
      });

    assert.equal(parsed.success, false);
  }
});

test('public signup validation rejects malformed optional CNPJ', () => {
  const parsed =
    publicSignupBodySchema.safeParse({
      name: 'Pessoa Teste',
      email: 'pessoa@example.test',
      company: 'Empresa Teste',
      cnpj: 'ABC-123',
      password: strongPassword,
      confirmPassword: strongPassword,
      acceptedTerms: true,
    });

  assert.equal(parsed.success, false);
});
