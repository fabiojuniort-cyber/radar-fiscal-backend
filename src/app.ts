import Fastify, {
  type FastifyInstance,
} from 'fastify';

import { healthRoutes } from './api/routes/health.route.js';
import { createDatabase } from './infrastructure/database/client.js';
import { loggerOptions } from './infrastructure/logging/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
  });

  const db = createDatabase(app.log);

  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await db.destroy();
  });

  await app.register(healthRoutes);

  return app;
}