import type { ConnectorExecutionOutcome } from './connector.executor.js';

export type CollectionRunTerminalStatus =
  | 'SUCCESS'
  | 'SUCCESS_NO_RESULTS'
  | 'PARTIAL_SUCCESS'
  | 'SOURCE_UNAVAILABLE'
  | 'FETCH_FAILED'
  | 'PROCESSING_FAILED'
  | 'CANCELLED';

export function resolveCollectionRunStatus(
  outcome: ConnectorExecutionOutcome,
): CollectionRunTerminalStatus {
  if (outcome.ok) {
    const hasPartialFailures =
      (outcome.result.partialFailures?.length ?? 0) > 0;

    // A voluntary early stop (e.g. TIME_BUDGET_REACHED) left work pending:
    // it is a partial success, never a timeout or a failure.
    if (hasPartialFailures || outcome.result.completion?.complete === false) {
      return 'PARTIAL_SUCCESS';
    }

    return outcome.result.publications.length > 0
      ? 'SUCCESS'
      : 'SUCCESS_NO_RESULTS';
  }

  switch (outcome.status) {
    case 'SOURCE_UNAVAILABLE':
      return 'SOURCE_UNAVAILABLE';

    case 'NETWORK_ERROR':
    case 'HTTP_ERROR':
    case 'FETCH_ERROR':
    case 'RATE_LIMITED':
    case 'TIMEOUT':
      return 'FETCH_FAILED';

    case 'PROCESSING_ERROR':
      return 'PROCESSING_FAILED';

    case 'CANCELLED':
      return 'CANCELLED';
  }
}
