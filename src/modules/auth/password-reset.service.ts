import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { hashPassword, normalizeEmail } from './auth.service.js';

export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
export const PASSWORD_RESET_RATE_WINDOW_SECONDS = 15 * 60;
export const PASSWORD_RESET_REQUESTS_PER_EMAIL = 5;
export const PASSWORD_RESET_REQUESTS_PER_IP = 60;
export const PASSWORD_RESET_CONFIRMATIONS_PER_IP = 60;

export interface PasswordResetMessage {
  to: string;
  link: string;
}

export type PasswordResetSender = (message: PasswordResetMessage) => Promise<void>;

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rateKey(namespace: string, value: string): string {
  return hashSecret('auth-reset-v1:' + namespace + ':' + value);
}

async function rateLimit(
  db: Kysely<DB>,
  keyHash: string,
  maxAttempts: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  // Reutiliza o contador persistente e transacional ja existente no signup.
  // Prefixos segregam as cotas de signup e reset.
  const result = await sql<{
    allowed: boolean;
    retry_after_seconds: number;
  }>`
    SELECT allowed, retry_after_seconds
      FROM public.auth_public_signup_rate_limit(
        ${keyHash},
        ${PASSWORD_RESET_RATE_WINDOW_SECONDS},
        ${maxAttempts}
      )
  `.execute(db);

  return {
    allowed: result.rows[0]?.allowed ?? false,
    retryAfterSeconds: result.rows[0]?.retry_after_seconds ?? 60,
  };
}

export class PasswordResetDeliveryError extends Error {
  constructor() {
    super('password_reset_delivery_failed');
    this.name = 'PasswordResetDeliveryError';
  }
}

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('password_reset_encryption_key_invalid');
  }
  return Buffer.from(hex, 'hex');
}

export interface EncryptedResetToken {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

export function encryptResetToken(
  token: string, digest: string, keyHex: string,
): EncryptedResetToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseKey(keyHex), nonce);
  cipher.setAAD(Buffer.from(digest, 'ascii'));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptResetToken(
  encrypted: EncryptedResetToken, digest: string, keyHex: string,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm', parseKey(keyHex), Buffer.from(encrypted.nonce, 'base64'),
  );
  decipher.setAAD(Buffer.from(digest, 'ascii'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const token = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  if (hashSecret(token) !== digest || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('password_reset_ciphertext_invalid');
  }
  return token;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export interface EncryptedResetRecipient {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

export function passwordResetKeyFingerprint(keyHex: string): string {
  return createHash('sha256')
    .update('tri-auth-reset-worker-key:v1:')
    .update(parseKey(keyHex))
    .digest('hex');
}

export function passwordResetRecipientDigest(email: string, keyHex: string): string {
  return createHmac('sha256', parseKey(keyHex))
    .update('tri-auth-reset-email:v1:' + normalizeEmail(email), 'utf8')
    .digest('hex');
}

export function encryptResetRecipient(
  email: string, requestId: string, keyHex: string,
): EncryptedResetRecipient {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseKey(keyHex), nonce);
  cipher.setAAD(Buffer.from('tri-auth-reset-request:v1:' + requestId, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(normalizeEmail(email), 'utf8'), cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptResetRecipient(
  value: EncryptedResetRecipient, requestId: string, keyHex: string,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm', parseKey(keyHex), Buffer.from(value.nonce, 'base64'),
  );
  decipher.setAAD(Buffer.from('tri-auth-reset-request:v1:' + requestId, 'utf8'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  const email = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  if (email !== normalizeEmail(email) || email.length > 320 ||
      !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('invalid_reset_request_recipient');
  }
  return email;
}

export class PasswordResetUnavailableError extends Error {
  constructor() {
    super('password_reset_unavailable');
    this.name = 'PasswordResetUnavailableError';
  }
}

export class PasswordResetRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('password_reset_rate_limited');
    this.name = 'PasswordResetRateLimitedError';
  }
}

export function passwordResetLink(publicUrl: string, token: string): string {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('invalid_password_reset_public_url');
  }
  // Fragmento nao vai para request HTTP, access logs nem Referer.
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export async function requestPasswordReset(
  db: Kysely<DB>,
  input: { email: string; ip: string; publicUrl: string; tokenKey: string },
): Promise<void> {
  const email = normalizeEmail(input.email);
  // Validation and readiness are identical for existing and unknown accounts.
  passwordResetLink(input.publicUrl, 'validation');
  parseKey(input.tokenKey);
  const fingerprint = passwordResetKeyFingerprint(input.tokenKey);
  const ready = await sql<{ ready: boolean }>`
    SELECT public.auth_password_reset_worker_ready(${fingerprint}) AS ready
  `.execute(db);
  if (!ready.rows[0]?.ready) throw new PasswordResetUnavailableError();

  // Rate-limit state depends on the submitted address, never on its existence.
  const ipRate = await rateLimit(
    db, rateKey('request-ip', input.ip), PASSWORD_RESET_REQUESTS_PER_IP,
  );
  if (!ipRate.allowed) {
    throw new PasswordResetRateLimitedError(ipRate.retryAfterSeconds);
  }
  const emailRate = await rateLimit(
    db, rateKey('request-email', email), PASSWORD_RESET_REQUESTS_PER_EMAIL,
  );
  if (!emailRate.allowed) return; // Always public HTTP 202.

  // IMPORTANT: this code never SELECTs or locks app_users, and never creates
  // a recovery token. A completely neutral, encrypted request is committed
  // for EVERY valid e-mail. Account resolution happens later, on the worker.
  const requestId = randomUUID();
  const recipient = encryptResetRecipient(email, requestId, input.tokenKey);
  const digest = passwordResetRecipientDigest(email, input.tokenKey);
  await sql`
    SELECT public.auth_password_reset_enqueue(
      ${requestId}::uuid, ${digest}, ${recipient.ciphertext},
      ${recipient.nonce}, ${recipient.authTag}, 1800
    )
  `.execute(db);
}

export async function completePasswordReset(
  db: Kysely<DB>,
  input: { token: string; password: string; ip: string },
): Promise<'success' | 'invalid'> {
  const limit = await rateLimit(
    db,
    rateKey('confirm-ip', input.ip),
    PASSWORD_RESET_CONFIRMATIONS_PER_IP,
  );
  if (!limit.allowed) {
    throw new PasswordResetRateLimitedError(limit.retryAfterSeconds);
  }

  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return 'invalid';

  const tokenHash = hashSecret(input.token);

  // Token aleatorio invalido nao deve consumir CPU executando Argon2.
  // O redeem valida novamente sob lock, sem confiar neste preflight.
  const active = await sql<{ active: boolean }>`
    SELECT public.auth_password_reset_token_active(${tokenHash}) AS active
  `.execute(db);
  if (!active.rows[0]?.active) return 'invalid';

  const passwordHash = await hashPassword(input.password);

  const redeemed = await sql<{ redeemed: boolean }>`
    SELECT public.auth_password_reset_redeem(
      ${tokenHash}, ${passwordHash}
    ) AS redeemed
  `.execute(db);

  return redeemed.rows[0]?.redeemed ? 'success' : 'invalid';
}

export interface ZohoPasswordResetOptions {
  apiKey: string;
  fromAddress: string;
  fetchImpl?: typeof fetch;
}

export async function sendZohoPasswordResetMail(
  message: PasswordResetMessage,
  options: ZohoPasswordResetOptions,
): Promise<void> {
  if (!options.apiKey || !/^[^\s@]+@[^\s@]+$/.test(options.fromAddress)) {
    throw new Error('zoho_password_reset_not_configured');
  }

  const body = {
    from: { address: options.fromAddress, name: 'TriFaros' },
    to: [{ email_address: { address: message.to } }],
    subject: 'TriFaros — recuperação de senha',
    textbody: 'Você solicitou a recuperação de senha da TriFaros.\n' +
      'Use este link uma única vez, em até 30 minutos:\n' + message.link +
      '\n\nSe não solicitou, ignore esta mensagem.',
    htmlbody: '<p>Você solicitou a recuperação de senha da TriFaros.</p>' +
      '<p><a href="' + escapeHtml(message.link) + '">Definir nova senha</a></p>' +
      '<p>O link vale por 30 minutos e pode ser usado uma única vez.</p>' +
      '<p>Se não solicitou, ignore esta mensagem.</p>',
    // Nunca entregar links de reset a redirecionadores de tracking.
    track_clicks: false,
    track_opens: false,
  };

  const requester = options.fetchImpl ?? fetch;
  const response = await requester('https://cpaas.zoho.com/v1.1/email', {
    method: 'POST',
    headers: {
      Authorization: 'Zoho-enczapikey ' + options.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error('zoho_password_reset_delivery_failed');
  }

  const responseBody: unknown = await response.json().catch(() => null);
  if (
    !responseBody || typeof responseBody !== 'object' ||
    !('message' in responseBody) ||
    responseBody.message !== 'OK' ||
    !('data' in responseBody) ||
    !Array.isArray(responseBody.data) ||
    responseBody.data.length === 0 ||
    !responseBody.data.every(
      (item: unknown) => typeof item === 'object' && item !== null &&
        'code' in item && item.code === 'EM_104',
    )
  ) {
    throw new Error('zoho_password_reset_delivery_unconfirmed');
  }
}
