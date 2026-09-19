import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import * as argon2 from 'argon2';
import {
  sql,
  type Kysely,
  type Transaction,
} from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  REFRESH_INACTIVITY_DAYS,
  SESSION_ABSOLUTE_DAYS,
} from './auth.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

export interface SessionTokens {
  user: AuthenticatedUser;
  sessionId: string;
  refreshToken: string;
}

export interface RefreshedSession {
  userId: string;
  sessionId: string;
  refreshToken: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashRefreshToken(token: string): string {
  return createHash('sha256')
    .update(token, 'utf8')
    .digest('hex');
}

function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(passwordHash, password);
}

export async function hashPassword(
  password: string,
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

export async function loginWithPassword(
  db: Kysely<DB>,
  email: string,
  password: string,
  metadata: {
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  },
): Promise<SessionTokens | null> {
  const normalizedEmail = normalizeEmail(email);

  const account = await db
    .selectFrom('app_users')
    .innerJoin(
      'user_credentials',
      'user_credentials.user_id',
      'app_users.id',
    )
    .select([
      'app_users.id',
      'app_users.email',
      'app_users.name',
      'app_users.status',
      'user_credentials.password_hash',
      'user_credentials.locked_until',
    ])
    .where('app_users.email', '=', normalizedEmail)
    .executeTakeFirst();

  if (!account || account.status !== 'ACTIVE') {
    return null;
  }

  const now = new Date();

  if (
    account.locked_until &&
    account.locked_until.getTime() > now.getTime()
  ) {
    return null;
  }

  const passwordValid = await verifyPassword(
    account.password_hash,
    password,
  );

  if (!passwordValid) {
    await db
      .updateTable('user_credentials')
      .set({
        failed_login_attempts:
          sql<number>`failed_login_attempts + 1`,
      })
      .where('user_id', '=', account.id)
      .execute();

    return null;
  }

  const absoluteExpiresAt = new Date(
    now.getTime() + SESSION_ABSOLUTE_DAYS * DAY_MS,
  );

  const idleExpiresAt = minDate(
    new Date(
      now.getTime() + REFRESH_INACTIVITY_DAYS * DAY_MS,
    ),
    absoluteExpiresAt,
  );

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const familyId = randomUUID();

  const sessionId = await db
    .transaction()
    .execute(async (trx) => {
      await trx
        .updateTable('user_credentials')
        .set({
          failed_login_attempts: 0,
          locked_until: null,
        })
        .where('user_id', '=', account.id)
        .execute();

      const session = await trx
        .insertInto('auth_sessions')
        .values({
          user_id: account.id,
          idle_expires_at: idleExpiresAt,
          absolute_expires_at: absoluteExpiresAt,
          ip_address: metadata.ipAddress ?? null,
          user_agent: metadata.userAgent ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('auth_refresh_tokens')
        .values({
          session_id: session.id,
          family_id: familyId,
          token_hash: refreshTokenHash,
          expires_at: idleExpiresAt,
        })
        .execute();

      return session.id;
    });

  return {
    user: {
      id: account.id,
      email: account.email,
      name: account.name,
    },
    sessionId,
    refreshToken,
  };
}

async function revokeRefreshFamily(
  trx: Transaction<DB>,
  sessionId: string,
  familyId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('auth_refresh_tokens')
    .set({
      revoked_at: now,
    })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute();

  await trx
    .updateTable('auth_sessions')
    .set({
      revoked_at: now,
      revoke_reason: reason,
    })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

export async function rotateRefreshToken(
  db: Kysely<DB>,
  token: string,
): Promise<RefreshedSession | null> {
  const tokenHash = hashRefreshToken(token);
  const nextRefreshToken = generateRefreshToken();
  const nextTokenHash = hashRefreshToken(nextRefreshToken);

  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('auth_refresh_tokens')
      .innerJoin(
        'auth_sessions',
        'auth_sessions.id',
        'auth_refresh_tokens.session_id',
      )
      .innerJoin(
        'app_users',
        'app_users.id',
        'auth_sessions.user_id',
      )
      .select([
        'auth_refresh_tokens.id as token_id',
        'auth_refresh_tokens.session_id',
        'auth_refresh_tokens.family_id',
        'auth_refresh_tokens.expires_at as token_expires_at',
        'auth_refresh_tokens.used_at',
        'auth_refresh_tokens.revoked_at as token_revoked_at',
        'auth_sessions.revoked_at as session_revoked_at',
        'auth_sessions.idle_expires_at',
        'auth_sessions.absolute_expires_at',
        'auth_sessions.user_id',
        'app_users.status as user_status',
      ])
      .where('auth_refresh_tokens.token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();

    if (!current) {
      return null;
    }

    const now = new Date();

    if (
      current.used_at ||
      current.token_revoked_at
    ) {
      await trx
        .updateTable('auth_refresh_tokens')
        .set({
          reuse_detected_at: now,
        })
        .where('id', '=', current.token_id)
        .execute();

      await revokeRefreshFamily(
        trx,
        current.session_id,
        current.family_id,
        'REFRESH_TOKEN_REUSE',
        now,
      );

      return null;
    }

    const sessionExpired =
      current.session_revoked_at !== null ||
      current.user_status !== 'ACTIVE' ||
      current.token_expires_at.getTime() <= now.getTime() ||
      current.idle_expires_at.getTime() <= now.getTime() ||
      current.absolute_expires_at.getTime() <= now.getTime();

    if (sessionExpired) {
      await revokeRefreshFamily(
        trx,
        current.session_id,
        current.family_id,
        'SESSION_EXPIRED',
        now,
      );

      return null;
    }

    const nextIdleExpiresAt = minDate(
      new Date(
        now.getTime() + REFRESH_INACTIVITY_DAYS * DAY_MS,
      ),
      current.absolute_expires_at,
    );

    const nextToken = await trx
      .insertInto('auth_refresh_tokens')
      .values({
        session_id: current.session_id,
        family_id: current.family_id,
        token_hash: nextTokenHash,
        parent_token_id: current.token_id,
        expires_at: nextIdleExpiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('auth_refresh_tokens')
      .set({
        used_at: now,
        replaced_by_token_id: nextToken.id,
      })
      .where('id', '=', current.token_id)
      .execute();

    await trx
      .updateTable('auth_sessions')
      .set({
        last_seen_at: now,
        idle_expires_at: nextIdleExpiresAt,
      })
      .where('id', '=', current.session_id)
      .execute();

    return {
      userId: current.user_id,
      sessionId: current.session_id,
      refreshToken: nextRefreshToken,
    };
  });
}

export async function validateSession(
  db: Kysely<DB>,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const session = await db
    .selectFrom('auth_sessions')
    .innerJoin(
      'app_users',
      'app_users.id',
      'auth_sessions.user_id',
    )
    .select([
      'auth_sessions.revoked_at',
      'auth_sessions.idle_expires_at',
      'auth_sessions.absolute_expires_at',
      'app_users.status',
    ])
    .where('auth_sessions.id', '=', sessionId)
    .where('auth_sessions.user_id', '=', userId)
    .executeTakeFirst();

  if (!session || session.status !== 'ACTIVE') {
    return false;
  }

  const now = Date.now();

  return (
    session.revoked_at === null &&
    session.idle_expires_at.getTime() > now &&
    session.absolute_expires_at.getTime() > now
  );
}

export async function revokeSession(
  db: Kysely<DB>,
  sessionId: string,
  reason = 'LOGOUT',
): Promise<void> {
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('auth_sessions')
      .set({
        revoked_at: now,
        revoke_reason: reason,
      })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();

    await trx
      .updateTable('auth_refresh_tokens')
      .set({
        revoked_at: now,
      })
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}
