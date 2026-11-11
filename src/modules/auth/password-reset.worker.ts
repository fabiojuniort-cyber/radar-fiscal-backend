import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  decryptResetToken,
  passwordResetLink,
  sendZohoPasswordResetMail,
  type PasswordResetMessage,
  type PasswordResetSender,
} from './password-reset.service.js';

const LEASE_SECONDS = 20;
const MAX_RETRY_DELAY_SECONDS = 30;

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
  'EMPTY' | 'ACCEPTED' | 'RETRY' | 'FAILED' | 'EXPIRED' | 'IGNORED';

export async function processPasswordResetOutboxOnce(
  db: Kysely<DB>,
  config: PasswordResetWorkerOptions,
): Promise<PasswordResetWorkerOutcome> {
  await sql`SELECT public.auth_password_reset_reap()`.execute(db);
  const claimed = await sql<ClaimedJob>`SELECT * FROM public.auth_password_reset_claim(${LEASE_SECONDS})`.execute(db);
  const job = claimed.rows[0];
  if (!job) return 'EMPTY';

  const finish = async (accepted: boolean): Promise<PasswordResetWorkerOutcome> => {
    const result = await sql<{ status: string }>`SELECT public.auth_password_reset_finish(
    ${job.job_id}::uuid, ${job.lease_id}::uuid, ${accepted},
    ${accepted ? null : 'TRANSIENT'}, ${MAX_RETRY_DELAY_SECONDS}
  ) AS status`.execute(db);
    const state = result.rows[0]?.status ?? 'IGNORED';
    return (
      state === 'ACCEPTED' || state === 'RETRY' || state === 'FAILED' ||
      state === 'EXPIRED' || state === 'IGNORED'
    ) ? state : 'IGNORED';
  };

  try {
    const stillActive = await sql<{ active: boolean }>`SELECT public.auth_password_reset_claim_active(
      ${job.job_id}::uuid, ${job.lease_id}::uuid
    ) AS active`.execute(db);
    if (!stillActive.rows[0]?.active) return finish(false);

    const token = decryptResetToken({
      ciphertext: job.ciphertext,
      nonce: job.iv,
      authTag: job.mac,
    }, job.digest.trim(), config.tokenKey);
    const link = passwordResetLink(config.publicUrl, token);

    // Ultima verificacao antes da chamada externa, sem depender de memoria.
    const secondCheck = await sql<{ active: boolean }>`SELECT public.auth_password_reset_claim_active(
      ${job.job_id}::uuid, ${job.lease_id}::uuid
    ) AS active`.execute(db);
    if (!secondCheck.rows[0]?.active) return finish(false);

    await config.send({ to: job.recipient, link });
    // ACCEPTED = provedor aceitou submissao; nao significa entrega.
    return finish(true);
  } catch {
    // Nao registrar exception, destinatario, criptograma, token ou link.
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
  },
): Promise<void> {
  const settings: PasswordResetWorkerOptions = {
    tokenKey: input.tokenKey,
    publicUrl: input.publicUrl,
    send: (message: PasswordResetMessage) => sendZohoPasswordResetMail(message, {
      apiKey: input.apiKey,
      fromAddress: input.fromAddress,
    }),
  };

  while (!input.isStopping()) {
    try {
      const result = await processPasswordResetOutboxOnce(db, settings);
      if (result !== 'EMPTY') input.onResult(result);
      if (result === 'EMPTY') {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch {
      input.onResult('FAILED');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
