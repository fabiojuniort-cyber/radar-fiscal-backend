import { ConnectorRegistry } from './connector.registry.js';
import {
  createMandatorySimulatedConnectors,
} from './simulated.connectors.js';

export interface BuildConnectorRegistryOptions {
  includeSimulated?: boolean;
}

export function buildConnectorRegistry(
  options: BuildConnectorRegistryOptions = {},
): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  if (options.includeSimulated) {
    const simulated =
      createMandatorySimulatedConnectors();

    for (const connector of Object.values(simulated)) {
      registry.register(connector);
    }
  }

  return registry;
}
