import type { CollectionConnector } from './connector.contract.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, CollectionConnector>();

  register(connector: CollectionConnector): void {
    if (this.connectors.has(connector.key)) {
      throw new Error(`Connector already registered: ${connector.key}`);
    }

    this.connectors.set(connector.key, connector);
  }

  get(connectorKey: string): CollectionConnector {
    const connector = this.connectors.get(connectorKey);

    if (!connector) {
      throw new Error(`Connector not registered: ${connectorKey}`);
    }

    return connector;
  }

  has(connectorKey: string): boolean {
    return this.connectors.has(connectorKey);
  }
}
