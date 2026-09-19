import type { Kysely } from 'kysely';

import type { DB } from '../infrastructure/database/database.types.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<DB>;
  }
}

export {};