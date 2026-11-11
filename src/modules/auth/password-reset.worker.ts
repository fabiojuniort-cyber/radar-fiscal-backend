import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  decryptResetRecipient,
  decryptResetToken,
  encryptResetToken,
  passwordResetKeyFingerprint,
  passwordResetLink,
  sendZohoPasswordResetMail,
  type PasswordResetMessage,
  type PasswordResetSender,
} from './password-reset.service.js';

const LEASE_SECONDS = 20;
const MAX_RETRY_DELAY_SECONDS = 30;

interface ClaimedRequest {
  request_id: string;
  lease_id: string;
  email_digest: string;
  ciphertext: string;
  iv: string;
  mac: string;
}

interface ClaimedJob {
  job_id: string;
  lease_id: string;
  digest: string;
  ciphertext: string;
  iv: string;
  mac: string;
  recipient: string;
}

export interface PasswordResetWorkerOptions {
  tokenKey: string;
  publicUrl: string;
  send: PasswordResetSender;
}

export type PasswordResetWorkerOutcome =
  'EMPTY' | 'ACCEPTED' | 'RETRY' | 'FAILED' | 'EXPIRED' | 'IGNORED' |
  'PREPARED' | 'UNKNOWN' | 'SUPERSEDED' | 'UNAVAILABLE';

export interface PasswordResetQueueHealth {
  pending: number;
  claimed: number;
  failed: number;
  oldestPendingSeconds: number;
}

export async function heartbeatPasswordResetWorker(
  db: Kysely<DB>, tokenKey: string, instanceId: string,
): Promise<boolean> {
  const fingerprint = passwordResetKeyFingerprint(tokenKey);
  const result = await sql<{ ready: boolean }>`
    SELECT public.auth_password_reset_worker_heartbeat(
      ${instanceId}::uuid, ${fingerprint}
    ) AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}

export async function readPasswordResetQueueHealth(
  db: Kysely<DB>,
): Promise<PasswordResetQueueHealth> {
  const result = await sql<{
    pending: string; claimed: string; failed: string;
    oldest_pending_seconds: string;
  }>`SELECT * FROM public.auth_password_reset_queue_health()`.execute(db);
  const row = result.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    claimed: Number(row?.claimed ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingSeconds: Number(row?.oldest_pending_seconds ?? 0),
  };
}

async function processNeutralRequest(
  db: Kysely<DB>, settings: PasswordResetWorkerOptions,
): Promise<PasswordResetWorkerOutcome | null> {
  const claimed = await sql<ClaimedRequest>`
    SELECT * FROM public.auth_password_reset_request_claim(${LEASE_SECONDS})
  `.execute(db);
  const request = claimed.rows[0];
  if (!request) return null;

  try {
    const email = decryptResetRecipient({
      ciphertext: request.ciphertext, nonce: request.iv, authTag: request.mac,
    }, request.request_id, settings.tokenKey);
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(token).digest('hex');
    const encrypted = encryptResetToken(token, digest, settings.tokenKey);
    // All-or-nothing SQL transaction: consume request + issue token/outbox.
    const result = await sql<{ state: string }>`
      SELECT public.auth_password_reset_prepare_request(
        ${request.request_id}::uuid, ${request.lease_id}::uuid,
        ${email}, ${digest}, ${encrypted.ciphertext},
        ${encrypted.nonce}, ${encrypted.authTag}, 1800
      ) AS state
    `.execute(db);
    const state = result.rows[0]?.state;
    if (state === 'PREPARED' || state === 'UNKNOWN' ||
        state === 'SUPERSEDED' || state === 'EXPIRED') {
      return state;
    }
    return 'IGNORED';
  } catch {
    // Never log decrypted recipient, exception or plaintext token.
    const result = await sql<{ state: string }>`
      SELECT public.auth_password_reset_request_fail(
        ${request.request_id}::uuid, ${request.lease_id}::uuid, 10
      ) AS state
    `.execute(db);
    return result.rows[0]?.state === 'RETRY' ? 'RETRY' : 'FAILED';
  }
}

export async function processPasswordResetOutboxOnce(
  db: Kysely<DB>,
  config: PasswordResetWorkerOptions,
): Promise<PasswordResetWorkerOutcome> {
  await sql`SELECT public.auth_password_reset_reap()`.execute(db);

  // Neutral request is prepared on the worker, NEVER while HTTP 202 waits.
  const requestOutcome = await processNeutralRequest(db, config);

  const claimed = await sql<ClaimedJob>`
    SELECT * FROM public.auth_password_reset_claim(${LEASE_SECONDS})
  `.execute(db);
  const job = claimed.rows[0];
  if (!job) return requestOutcome ?? 'EMPTY';

  const finish = async (accepted: boolean): Promise<PasswordResetWorkerOutcome> => {
    const result = await sql<{ status: string }>`
      SELECT public.auth_password_reset_finish(
        ${job.job_id}::uuid, ${job.lease_id}::uuid, ${accepted},
        ${accepted ? null : 'TRANSIENT'}, ${MAX_RETRY_DELAY_SECONDS}
      ) AS status
    `.execute(db);
    const state = result.rows[0]?.status ?? 'IGNORED';
    return state === 'ACCEPTED' || state === 'RETRY' || state === 'FAILED' ||
      state === 'EXPIRED' || state === 'IGNORED' ? state : 'IGNORED';
  };

  try {
    // First, re-check token and active account. A stale claim cannot send.
    const active = await sql<{ active: boolean }>`
      SELECT public.auth_password_reset_claim_active(
        ${job.job_id}::uuid, ${job.lease_id}::uuid
      ) AS active
    `.execute(db);
    if (!active.rows[0]?.active) return finish(false);

    const token = decryptResetToken({
      ciphertext: job.ciphertext, nonce: job.iv, authTag: job.mac,
    }, job.digest.trim(), config.tokenKey);
    const link = passwordResetLink(config.publicUrl, token);

    // Begin-send moves the attempt counter only at the outbound boundary.
    // Crashes after claim but before here do not consume send attempts.
    const started = await sql<{ started: boolean }>`
      SELECT public.auth_password_reset_begin_send(
        ${job.job_id}::uuid, ${job.lease_id}::uuid
      ) AS started
    `.execute(db);
    if (!started.rows[0]?.started) return finish(false);

    await config.send({ to: job.recipient, link });
    // ACCEPTED means provider submission, not inbox delivery.
    return finish(true);
  } catch {
    return finish(false);
  }
}

export async function runPasswordResetOutboxWorker(
  db: Kysely<DB>,
  input: {
    tokenKey: string;
    publicUrl: string;
    fromAddress: string;
    apiKey: string;
    isStopping: () => boolean;
    onResult: (result: PasswordResetWorkerOutcome) => void;
    onHealth?: (health: PasswordResetQueueHealth) => void;
  },
): Promise<void> {
  const instanceId = randomUUID();
  let lastHealthAt = 0;
  const settings: PasswordResetWorkerOptions = {
    tokenKey: input.tokenKey,
    publicUrl: input.publicUrl,
    send: (message: PasswordResetMessage) => sendZohoPasswordResetMail(message, {
      apiKey: input.apiKey, fromAddress: input.fromAddress,
    }),
  };

  while (!input.isStopping()) {
    try {
      const ready = await heartbeatPasswordResetWorker(
        db, input.tokenKey, instanceId,
      );
      if (!ready) {
        input.onResult('UNAVAILABLE');
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue; // Mismatched key can never claim.
      }
      const result = await processPasswordResetOutboxOnce(db, settings);
      if (result !== 'EMPTY') input.onResult(result);
      if (input.onHealth && Date.now() - lastHealthAt >= 30_000) {
        input.onHealth(await readPasswordResetQueueHealth(db));
        lastHealthAt = Date.now();
      }
      if (result === 'EMPTY') {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch {
      input.onResult('FAILED');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
