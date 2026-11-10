import { createHash, randomBytes } from 'node:crypto';

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
  input: { email: string; ip: string; publicUrl: string; send: PasswordResetSender },
): Promise<void> {
  const email = normalizeEmail(input.email);
  const [emailRate, ipRate] = await Promise.all([
    rateLimit(db, rateKey('request-email', email), PASSWORD_RESET_REQUESTS_PER_EMAIL),
    rateLimit(db, rateKey('request-ip', input.ip), PASSWORD_RESET_REQUESTS_PER_IP),
  ]);

  if (!emailRate.allowed || !ipRate.allowed) {
    throw new PasswordResetRateLimitedError(
      Math.max(emailRate.retryAfterSeconds, ipRate.retryAfterSeconds),
    );
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSecret(token);
  const result = await sql<{ issued: boolean }>`
    SELECT public.auth_password_reset_issue(
      ${email}, ${tokenHash}, ${PASSWORD_RESET_TTL_SECONDS}
    ) AS issued
  `.execute(db);

  // Mesma resposta publica para e-mail cadastrado ou desconhecido.
  if (!result.rows[0]?.issued) return;

  const link = passwordResetLink(input.publicUrl, token);
  await input.send({ to: email, link });
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

  const passwordHash = await hashPassword(input.password);
  const tokenHash = hashSecret(input.token);

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
      '<p><a href="' + message.link + '">Definir nova senha</a></p>' +
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
