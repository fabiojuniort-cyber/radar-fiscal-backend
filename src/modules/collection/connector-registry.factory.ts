import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { ConfazConnector } from './confaz.connector.js';
import {
  readConfazSourceState,
} from './confaz-source-state.repository.js';
import { ConnectorRegistry } from './connector.registry.js';
import {
  createMandatorySimulatedConnectors,
} from './simulated.connectors.js';

export interface BuildConnectorRegistryOptions {
  includeSimulated?: boolean;
  db?: Kysely<DB>;
}

export function buildConnectorRegistry(
  options: BuildConnectorRegistryOptions = {},
): ConnectorRegistry {
  const registry = new ConnectorRegistry();

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

  if (options.includeSimulated) {
    const simulated =
      createMandatorySimulatedConnectors();

    for (const connector of Object.values(simulated)) {
      registry.register(connector);
    }
  }

  return registry;
}
