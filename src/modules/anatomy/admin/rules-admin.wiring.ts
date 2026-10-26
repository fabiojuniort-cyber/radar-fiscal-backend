import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { anatomyRulesAdminRoutes } from '../../../api/routes/anatomy-rules-admin.route.js';
import { SimulationExecutor } from '../simulation-executor.js';

/**
 * ANAT-ADMIN-01 integration package 3 (issue tribusca-control#116): wiring of the administrative anatomy-rules API.
 * Behind the SERVER flag ANAT_RULES_ADMIN_ENABLED, off by default: when off nothing is created and no route exists.
 * When on, the plugin gets a dedicated small pool (the runtime login, which inherits radar_app; the plugin only calls
 * the audited SQL entry points) and ONE executor per instance; both are closed when the application closes. If the
 * executor cannot be created the routes stay up and simulation/comparison answer 503 SIMULATION_UNAVAILABLE.
 */
export interface AnatomyRulesAdminWiring { enabled: boolean; pool: Pool | null; executor: SimulationExecutor | null }
export interface AnatomyRulesAdminWiringOptions {
  enabled: boolean;
  connectionString: string;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  createExecutor?: () => SimulationExecutor;
}
export const ANAT_RULES_ADMIN_POOL_MAX = 4;

export async function registerAnatomyRulesAdmin(app: FastifyInstance, options: AnatomyRulesAdminWiringOptions): Promise<AnatomyRulesAdminWiring> {
  if (!options.enabled) return { enabled: false, pool: null, executor: null };
  const pool = new Pool({ connectionString: options.connectionString, max: ANAT_RULES_ADMIN_POOL_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis, connectionTimeoutMillis: options.connectionTimeoutMillis });
  pool.on('error', (error) => { app.log.error({ err: error }, 'Unexpected PostgreSQL anatomy-rules admin pool error'); });
  let executor: SimulationExecutor | null = null;
  try { executor = (options.createExecutor ?? (() => new SimulationExecutor()))(); } catch (error) {
    app.log.error({ err: error }, 'Anatomy simulation executor unavailable: simulation and comparison answer 503');
  }
  app.addHook('onClose', async () => {
    await executor?.close();
    await pool.end();
  });
  await app.register(anatomyRulesAdminRoutes, { pool, executor });
  return { enabled: true, pool, executor };
}
