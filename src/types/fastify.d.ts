import type {
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { Kysely } from 'kysely';

import type { DB } from '../infrastructure/database/database.types.js';

export interface RequestAuthContext {
  userId: string;
  sessionId: string;
}

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<DB>;
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    auth: RequestAuthContext | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

export {};
