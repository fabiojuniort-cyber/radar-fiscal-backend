import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export async function healthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get('/health', async (request, reply) => {
    try {
      await sql<{ ok: number }>`
        select 1 as ok
      `.execute(app.db);

      return reply.status(200).send({
        status: 'ok',
        service: 'radar-fiscal-api',
        database: 'up',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      request.log.error(
        { err: error },
        'Database health check failed',
      );

      return reply.status(503).send({
        status: 'degraded',
        service: 'radar-fiscal-api',
        database: 'down',
        timestamp: new Date().toISOString(),
      });
    }
  });
}