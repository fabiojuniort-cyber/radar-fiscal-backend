import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertDatabaseConnection } from './infrastructure/database/client.js';

const app = await buildApp();

async function shutdown(
  signal: string,
): Promise<void> {
  app.log.info(
    { signal },
    'Shutdown signal received',
  );

  await app.close();

  app.log.info(
    'Application shutdown completed',
  );
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await assertDatabaseConnection(app.db);

  app.log.info(
    'PostgreSQL connection verified',
  );

  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.fatal(
    { err: error },
    'Failed to start application',
  );

  await app.close();

  process.exit(1);
}