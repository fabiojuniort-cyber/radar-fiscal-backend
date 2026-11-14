import { onboardingPhraseRoutes } from './api/routes/onboarding-phrases.route.js';
import { onboardingRoutes } from './api/routes/onboarding.route.js';
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
import { passwordResetRoutes } from './api/routes/password-reset.route.js';
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
import { registerAnatomyConfig } from './modules/anatomy/config/config.wiring.js';
import { registerAuthSupport } from './modules/auth/auth.plugin.js';
import { sql } from 'kysely';
import { env } from './config/env.js';

export interface BuildAppOptions {
  passwordReset?: {
    enabled?: boolean;
    publicUrl?: string;
    // Apenas injecao de um emissor simulado em testes isolados.
    tokenKey?: string;
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Proxy Railway: NAO PROVADO ate CIDRs exatos serem ratificados.
  // Nao confiar em X-Forwarded-For fora da origem verificada.
  const rawProxyList = env.AUTH_PASSWORD_RESET_TRUSTED_PROXY_CIDRS
    .split(',').map((part) => part.trim()).filter(Boolean);
  const validProxyList = rawProxyList.length > 0 && rawProxyList.every(
    (value) => /^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:\d|[12]\d|3[0-2]))?$/.test(value) &&
      value !== '0.0.0.0/0' && value !== '127.0.0.1/8',
  );
  const trustedProxies = validProxyList ? rawProxyList : [];
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: trustedProxies.length > 0 ? trustedProxies : false,
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
  const resetEnabled = options.passwordReset?.enabled ??
    (env.AUTH_PASSWORD_RESET_ENABLED === 'true' && trustedProxies.length > 0);
  const resetPublicUrl = options.passwordReset?.publicUrl ??
    env.AUTH_PASSWORD_RESET_PUBLIC_URL;
  const tokenKey = options.passwordReset?.tokenKey ??
    env.AUTH_PASSWORD_RESET_TOKEN_KEY;
  await app.register(passwordResetRoutes, {
    enabled: resetEnabled && Boolean(tokenKey) && Boolean(resetPublicUrl),
    ...(resetPublicUrl ? { publicUrl: resetPublicUrl } : {}),
    ...(tokenKey ? { tokenKey } : {}),
  });
  // R3 janitor: can remain enabled if delivery is intentionally disabled.
  // It runs with the API's limited EXECUTE grant and never logs PII.
  if (env.AUTH_PASSWORD_RESET_JANITOR_ENABLED === 'true') {
    const cleanup = async (): Promise<void> => {
      try {
        await sql`SELECT public.auth_password_reset_reap()`.execute(db);
      } catch {
        app.log.warn({ component: 'AUTH_RESET', event: 'cleanup_failed' },
          'Password reset expiry cleanup unavailable');
      }
    };
    const janitor = setInterval(() => { void cleanup(); }, 60_000);
    janitor.unref();
    app.addHook('onClose', async () => { clearInterval(janitor); });
    app.addHook('onReady', async () => { await cleanup(); });
  }
  await app.register(productRoutes);
  await app.register(onboardingRoutes);
  await app.register(onboardingPhraseRoutes);
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
  // ANAT-CONFIG-01 replaces the double-approval flow: with the new flag on, the legacy routes are not registered.
  await registerAnatomyRulesAdmin(app, {
    enabled: env.ANAT_RULES_ADMIN_ENABLED === 'true' && env.ANAT_CONFIG_ENABLED !== 'true', connectionString: env.DATABASE_URL,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS, connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });
  await registerAnatomyConfig(app, {
    enabled: env.ANAT_CONFIG_ENABLED === 'true', connectionString: env.DATABASE_URL,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS, connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  return app;
}

