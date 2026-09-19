import Fastify, {
  type FastifyInstance,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { authRoutes } from './api/routes/auth.route.js';
import { healthRoutes } from './api/routes/health.route.js';
import { createDatabase } from './infrastructure/database/client.js';
import { loggerOptions } from './infrastructure/logging/logger.js';
import { registerAuthSupport } from './modules/auth/auth.plugin.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = createDatabase(app.log);

  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await db.destroy();
  });

  await registerAuthSupport(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);

  return app;
}
