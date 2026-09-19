import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';

export type SimulatedConnectorAction =
  | {
      type: 'RESULT';
      result: ConnectorResult;
    }
  | {
      type: 'ERROR';
      error: ConnectorError;
    }
  | {
      type: 'TIMEOUT';
    };

export class ScriptedSimulatedConnector
  implements CollectionConnector
{
  readonly version = 'simulated-1.0.0';

  private callCount = 0;

  constructor(
    readonly key: string,
    private readonly actions: readonly SimulatedConnectorAction[],
  ) {
    if (actions.length === 0) {
      throw new RangeError(
        'Simulated connector requires at least one action',
      );
    }
  }

  get calls(): number {
    return this.callCount;
  }

  async collect(
    _context: ConnectorExecutionContext,
  ): Promise<ConnectorResult> {
    const index = Math.min(
      this.callCount,
      this.actions.length - 1,
    );

    this.callCount += 1;

    const action = this.actions[index]!;

    if (action.type === 'RESULT') {
      return structuredClone(action.result);
    }

    if (action.type === 'ERROR') {
      throw action.error;
    }

    return new Promise<ConnectorResult>(() => undefined);
  }
}

function publication(
  suffix: string,
  content = 'Conteúdo original.',
) {
  return {
    title: `Ato Simulado ${suffix}`,
    agency: 'ÓRGÃO SIMULADO',
    sphere: 'FEDERAL' as const,
    actType: 'ATO SIMULADO',
    actNumber: suffix,
    publishedAt: new Date(
      '2026-09-19T00:00:00Z',
    ),
    content,
    officialUrl:
      `https://simulated.example.test/${suffix}`,
    externalId: `sim-${suffix}`,
  };
}

export function createMandatorySimulatedConnectors(): {
  successWithNew: ScriptedSimulatedConnector;
  noResults: ScriptedSimulatedConnector;
  duplicatePublication: ScriptedSimulatedConnector;
  updatedContent: ScriptedSimulatedConnector;
  timeout: ScriptedSimulatedConnector;
  fetchError: ScriptedSimulatedConnector;
  processingError: ScriptedSimulatedConnector;
  partialResult: ScriptedSimulatedConnector;
  retrySuccess: ScriptedSimulatedConnector;
  retriesExhausted: ScriptedSimulatedConnector;
} {
  const duplicate = publication('duplicate');

  return {
    successWithNew: new ScriptedSimulatedConnector(
      'simulated.success-new',
      [
        {
          type: 'RESULT',
          result: {
            publications: [
              publication('success-new'),
            ],
          },
        },
      ],
    ),

    noResults: new ScriptedSimulatedConnector(
      'simulated.no-results',
      [
        {
          type: 'RESULT',
          result: {
            publications: [],
          },
        },
      ],
    ),

    duplicatePublication:
      new ScriptedSimulatedConnector(
        'simulated.duplicate',
        [
          {
            type: 'RESULT',
            result: {
              publications: [
                duplicate,
                duplicate,
              ],
            },
          },
        ],
      ),

    updatedContent: new ScriptedSimulatedConnector(
      'simulated.updated-content',
      [
        {
          type: 'RESULT',
          result: {
            publications: [
              publication(
                'updated-content',
                'Versão original.',
              ),
            ],
          },
        },
        {
          type: 'RESULT',
          result: {
            publications: [
              publication(
                'updated-content',
                'Versão atualizada.',
              ),
            ],
          },
        },
      ],
    ),

    timeout: new ScriptedSimulatedConnector(
      'simulated.timeout',
      [
        {
          type: 'TIMEOUT',
        },
      ],
    ),

    fetchError: new ScriptedSimulatedConnector(
      'simulated.fetch-error',
      [
        {
          type: 'ERROR',
          error: new ConnectorError(
            'Simulated fetch error',
            {
              kind: 'FETCH_ERROR',
              code: 'SIMULATED_FETCH_ERROR',
              retryable: false,
            },
          ),
        },
      ],
    ),

    processingError:
      new ScriptedSimulatedConnector(
        'simulated.processing-error',
        [
          {
            type: 'ERROR',
            error: new ConnectorError(
              'Simulated parser failure',
              {
                kind: 'PROCESSING_ERROR',
                code:
                  'SIMULATED_PROCESSING_ERROR',
                retryable: false,
              },
            ),
          },
        ],
      ),

    partialResult: new ScriptedSimulatedConnector(
      'simulated.partial-result',
      [
        {
          type: 'RESULT',
          result: {
            publications: [
              publication('partial-result'),
            ],
            partialFailures: [
              {
                code: 'SIMULATED_PARTIAL_FAILURE',
                message:
                  'One simulated source section failed.',
                itemReference: 'section-b',
              },
            ],
          },
        },
      ],
    ),

    retrySuccess: new ScriptedSimulatedConnector(
      'simulated.retry-success',
      [
        {
          type: 'ERROR',
          error: new ConnectorError(
            'Transient simulated fetch failure',
            {
              kind: 'FETCH_ERROR',
              code: 'SIMULATED_TRANSIENT_ERROR',
              retryable: true,
            },
          ),
        },
        {
          type: 'RESULT',
          result: {
            publications: [
              publication('retry-success'),
            ],
          },
        },
      ],
    ),

    retriesExhausted:
      new ScriptedSimulatedConnector(
        'simulated.retries-exhausted',
        [
          {
            type: 'ERROR',
            error: new ConnectorError(
              'Persistent simulated fetch failure',
              {
                kind: 'FETCH_ERROR',
                code:
                  'SIMULATED_PERSISTENT_ERROR',
                retryable: true,
              },
            ),
          },
        ],
      ),
  };
}
