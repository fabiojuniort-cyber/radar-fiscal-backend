import { auditHistoryRoutes } from './api/routes/audit-history.route.js';
import {closeCollectionFilterActNameInventory} from './modules/collection/collection-filter.act-name-inventory.js';
import Fastify, {
  type FastifyInstance,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { authRoutes } from './api/routes/auth.route.js';
import { catalogMonitoringRoutes } from './api/routes/catalog-monitoring.route.js';
import { companyManualRoutes } from './api/routes/company-manual.route.js';
import { establishmentManualRoutes } from './api/routes/establishment-manual.route.js';
import { healthRoutes } from './api/routes/health.route.js';
import { newsRoutes } from './api/routes/news.route.js';
import { productNcmRoutes } from './api/routes/product-ncm.route.js';
import { platformAdminRoutes } from './api/routes/platform-admin.route.js';
import { collectionFilterAdminRoutes } from './api/routes/collection-filter-admin.route.js';
import { publicRoutes } from './api/routes/public.route.js';
import { productRoutes } from './api/routes/product.route.js';
import { taxonomyAdminRoutes } from './api/routes/taxonomy-admin.route.js';
import { publicationTaxonomyRoutes } from './api/routes/publication-taxonomy.route.js';
import { createDatabase } from './infrastructure/database/client.js';
import { createCuratorPool } from './infrastructure/database/curator-client.js';
import { loggerOptions } from './infrastructure/logging/logger.js';
import { registerAnatomyRulesAdmin } from './modules/anatomy/admin/rules-admin.wiring.js';
import { registerAuthSupport } from './modules/auth/auth.plugin.js';
import { env } from './config/env.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = createDatabase(app.log);

  app.decorate('db', db);

  const curatorPool = createCuratorPool(app.log);
  app.decorate('curatorPool', curatorPool);

  app.addHook('onClose', async () => {
    await closeCollectionFilterActNameInventory(db);
    await db.destroy();
    await curatorPool?.end();
  });

  await registerAuthSupport(app);

  await app.register(healthRoutes);
  await app.register(publicRoutes);
  await app.register(authRoutes);
  await app.register(productRoutes);
  await app.register(auditHistoryRoutes);
  await app.register(productNcmRoutes);
  await app.register(newsRoutes);
  await app.register(catalogMonitoringRoutes);
  await app.register(companyManualRoutes);
  await app.register(establishmentManualRoutes);
  await app.register(platformAdminRoutes);
  await app.register(collectionFilterAdminRoutes);
  await app.register(taxonomyAdminRoutes);
  await app.register(publicationTaxonomyRoutes);
  await registerAnatomyRulesAdmin(app, {
    enabled: env.ANAT_RULES_ADMIN_ENABLED === 'true', connectionString: env.DATABASE_URL,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS, connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  return app;
}

