import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyRequest } from 'fastify';

import {
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from '../src/modules/auth/auth.service.js';
import {
  getTenantIdFromRequest,
  TenantHeaderInvalidError,
  TenantHeaderRequiredError,
} from '../src/modules/auth/tenant-request.js';

function requestWithTenantHeader(
  value?: string,
): FastifyRequest {
  return {
    headers:
      value === undefined
        ? {}
        : {
            'x-tenant-id': value,
          },
  } as FastifyRequest;
}

test('normalizeEmail trims and lowercases email', () => {
  assert.equal(
    normalizeEmail('  User.Name@Example.COM  '),
    'user.name@example.com',
  );
});

test('Argon2id password hash verifies the correct password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');

  assert.equal(
    await verifyPassword(
      hash,
      'correct-horse-battery-staple',
    ),
    true,
  );

  assert.equal(
    await verifyPassword(hash, 'wrong-password'),
    false,
  );
});

test('X-Tenant-Id is required', () => {
  assert.throws(
    () => getTenantIdFromRequest(requestWithTenantHeader()),
    TenantHeaderRequiredError,
  );
});

test('X-Tenant-Id must be a valid UUID', () => {
  assert.throws(
    () =>
      getTenantIdFromRequest(
        requestWithTenantHeader('not-a-uuid'),
      ),
    TenantHeaderInvalidError,
  );
});

test('X-Tenant-Id accepts and trims a valid UUID', () => {
  const tenantId =
    '123e4567-e89b-42d3-a456-426614174000';

  assert.equal(
    getTenantIdFromRequest(
      requestWithTenantHeader(`  ${tenantId}  `),
    ),
    tenantId,
  );
});
