import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { CgibsConnector } from './cgibs.connector.js';
import { DoeSpConnector, resolveDoeSpSourceLimits } from './doe-sp.connector.js';
import { readDoeSpSourceState } from './doe-sp-source-state.repository.js';
import { DoeSpLegacyConnector, resolveDoeSpLegacySourceLimits } from './doe-sp-legacy.connector.js';
import { readDoeSpLegacySourceState } from './doe-sp-legacy-source-state.repository.js';
import { RfbNormasConnector } from './rfb-normas.connector.js';
import { readRfbNormasSourceState } from './rfb-normas-source-state.repository.js';
import { readCgibsSourceState } from './cgibs-source-state.repository.js';
import { ConfazConnector } from './confaz.connector.js';
import { DouConnector } from './dou.connector.js';
import { readDouSourceState } from './dou-source-state.repository.js';
import {
  readConfazSourceState,
} from './confaz-source-state.repository.js';
import { ConnectorRegistry } from './connector.registry.js';
import { NfeEncatConnector } from './nfe-encat.connector.js';
import { readNfeEncatSourceState } from './nfe-encat-source-state.repository.js';
import { SpedConnector } from './sped.connector.js';
import { readSpedSourceState } from './sped-source-state.repository.js';
import {
  createMandatorySimulatedConnectors,
} from './simulated.connectors.js';

export interface BuildConnectorRegistryOptions {
  includeSimulated?: boolean;
  db?: Kysely<DB>;
  includeDou?: boolean;
}

export function buildConnectorRegistry(
  options: BuildConnectorRegistryOptions = {},
): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  if (options.includeDou ?? process.env.DOU_CONNECTOR_ENABLED === 'true') {
    registry.register(new DouConnector({
      credentials: () => process.env.INLABS_EMAIL && process.env.INLABS_PASSWORD
        ? { email: process.env.INLABS_EMAIL, password: process.env.INLABS_PASSWORD } : undefined,
      ...(options.db ? { readState: (sourceId: string, runId: string) => readDouSourceState(options.db!, sourceId, runId) } : {}),
    }));
  }

  registry.register(
    new RfbNormasConnector({
      ...(options.db
        ? {
            readState: (sourceId) =>
              readRfbNormasSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  registry.register(
    new CgibsConnector({
      ...(options.db
        ? {
            readState: (sourceId) =>
              readCgibsSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  const doeSpLimits = resolveDoeSpSourceLimits();
  registry.register(
    new DoeSpConnector({
      client: { minRequestIntervalMs: doeSpLimits.minRequestIntervalMs },
      maxDownloadBytesPerRun: doeSpLimits.maxDownloadBytesPerRun,
      ...(options.db
        ? {
            readState: (sourceId) =>
              readDoeSpSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  const doeSpLegacyLimits = resolveDoeSpLegacySourceLimits();
  registry.register(
    new DoeSpLegacyConnector({
      client: { minRequestIntervalMs: doeSpLegacyLimits.minRequestIntervalMs },
      maxDownloadBytesPerRun: doeSpLegacyLimits.maxDownloadBytesPerRun,
      ...(doeSpLegacyLimits.maxPeriodsPerRun > 0 ? { maxPeriodsPerRun: doeSpLegacyLimits.maxPeriodsPerRun } : {}),
      ...(options.db
        ? {
            readState: (sourceId) =>
              readDoeSpLegacySourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  registry.register(
    new ConfazConnector({
      ...(options.db
        ? {
            readSourceState: (sourceId) =>
              readConfazSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  registry.register(
    new NfeEncatConnector({
      ...(options.db
        ? {
            readState: (sourceId) =>
              readNfeEncatSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  registry.register(
    new SpedConnector({
      ...(options.db
        ? {
            readState: (sourceId) =>
              readSpedSourceState(options.db!, sourceId),
          }
        : {}),
    }),
  );

  if (options.includeSimulated) {
    const simulated =
      createMandatorySimulatedConnectors();

    for (const connector of Object.values(simulated)) {
      registry.register(connector);
    }
  }

  return registry;
}
