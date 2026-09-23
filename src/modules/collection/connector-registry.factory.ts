import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { CgibsConnector } from './cgibs.connector.js';
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
    new CgibsConnector({
      ...(options.db
        ? {
            readState: (sourceId) =>
              readCgibsSourceState(options.db!, sourceId),
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
