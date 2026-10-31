import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { anatomyConfigRoutes } from '../../../api/routes/anatomy-config.route.js';
import { SimulationExecutor } from '../simulation-executor.js';

/**
 * ANAT-CONFIG-01: wiring of the accessible anatomy configuration behind the SERVER flag ANAT_CONFIG_ENABLED (default
 * off; when off nothing is created and no route exists). Same shape as rules-admin.wiring.ts: a small dedicated pool
 * and ONE isolated executor per instance, both closed with the application; no executor → analysis answers 503.
 */
export interface AnatomyConfigWiringOptions { enabled: boolean; connectionString: string; idleTimeoutMillis?: number; connectionTimeoutMillis?: number; createExecutor?: () => SimulationExecutor }
export const ANAT_CONFIG_POOL_MAX = 4;

export async function registerAnatomyConfig(app: FastifyInstance, options: AnatomyConfigWiringOptions): Promise<{ enabled: boolean; pool: Pool | null; executor: SimulationExecutor | null }> {
  if (!options.enabled) return { enabled: false, pool: null, executor: null };
  const pool = new Pool({ connectionString: options.connectionString, max: ANAT_CONFIG_POOL_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis, connectionTimeoutMillis: options.connectionTimeoutMillis });
  pool.on('error', (error) => { app.log.error({ err: error }, 'Unexpected PostgreSQL anatomy-config pool error'); });
  let executor: SimulationExecutor | null = null;
  try { executor = (options.createExecutor ?? (() => new SimulationExecutor()))(); } catch (error) {
    app.log.error({ err: error }, 'Anatomy simulation executor unavailable: analysis answers 503');
  }
  app.addHook('onClose', async () => { await executor?.close(); await pool.end(); });
  await app.register(anatomyConfigRoutes, { pool, executor });
  return { enabled: true, pool, executor };
}
