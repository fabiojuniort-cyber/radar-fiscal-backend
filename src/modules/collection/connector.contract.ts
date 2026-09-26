export type ConnectorSphere = 'FEDERAL' | 'STATE';

export type ConnectorFileVersionRole =
  | 'MATERIAL_CONTENT'
  | 'PROVENANCE';

export type ConnectorContentHashPolicy =
  | 'LEGACY_ALL_FILES'
  | 'HTML_PRIMARY_MATERIAL_FILES';

export interface ConnectorFile {
  url: string;
  name?: string;
  mimeType?: string;
  externalId?: string;
  rawSha256?: string;
  sizeBytes?: number;
  sourceEtag?: string;
  sourceLastModified?: string;

  /**
   * MATERIAL_CONTENT participates in semantic versioning.
   * PROVENANCE is preserved for the source/origin but does not define
   * the canonical content version under an opt-in content hash policy.
   * Omitted files keep the legacy all-files behavior.
   */
  versionRole?: ConnectorFileVersionRole;
  metadata?: Record<string, unknown>;
}

export interface ConnectorPublication {
  title: string;

  agency?: string;
  sphere: ConnectorSphere;
  stateCode?: string;

  actType?: string;
  actNumber?: string;

  publishedAt?: Date;
  effectiveAt?: Date;

  content?: string;
  officialUrl: string;

  /**
   * Identificador estável fornecido pela própria fonte, quando existir.
   * Não deve ser inventado pelo conector.
   */
  externalId?: string;

  /**
   * Chave canônica interna de correlação para o mesmo documento
   * publicado em espelhos/origens oficiais diferentes dentro da mesma fonte.
   * Não substitui externalId e não é um identificador fornecido pela fonte.
   */
  identityKey?: string;

  /**
   * Opt-in version semantics. Omitted publications preserve the exact
   * legacy v1 hash behavior used by all existing connectors.
   */
  contentHashPolicy?: ConnectorContentHashPolicy;

  files?: ConnectorFile[];

  /**
   * Dados específicos da fonte que podem compor metadata da versão.
   */
  metadata?: Record<string, unknown>;

  /**
   * Evidência específica da origem observada que não deve ser promovida
   * ao metadata canônico da versão (ex.: authCode/status de PDF redundante).
   * É persistida somente em collection_items/publication_origins.
   */
  originMetadata?: Record<string, unknown>;
}

export interface ConnectorPartialFailure {
  code: string;
  message: string;

  /**
   * Referência opcional ao item que não pôde ser processado.
   */
  itemReference?: string;
}

/**
 * Reason a connector finished voluntarily with work still pending.
 */
export type ConnectorIncompleteReason =
  | 'TIME_BUDGET_REACHED'
  | 'PARTIAL_FAILURE_RETRY_REQUIRED';

export interface ConnectorCompletion {
  /**
   * false = the connector stopped at a safe point before covering everything.
   * Everything returned is consistent and its checkpoint is valid; the next
   * run continues from it. This is NOT a failure and NOT a timeout.
   */
  complete: boolean;
  reason?: ConnectorIncompleteReason;
  /** Optional connector-specific counters describing the pending work. */
  pending?: Record<string, number>;
}

/**
 * Operational checkpoint produced by an attempt. Stored by the engine in
 * collection_checkpoints (not in collection_attempts.metadata). Only
 * persisted when the connector returns normally.
 */
export interface ConnectorCheckpoint {
  version: number;
  state: Record<string, unknown>;
}

export interface ConnectorResult {
  publications: ConnectorPublication[];

  /**
   * Permite ao conector informar que parte da fonte foi processada
   * com sucesso e parte falhou.
   */
  partialFailures?: ConnectorPartialFailure[];

  metadata?: Record<string, unknown>;

  /** Opt-in: voluntary early stop (e.g. time budget) with pending work. */
  completion?: ConnectorCompletion;

  /** Opt-in: heavy operational state kept outside attempt history. */
  checkpoint?: ConnectorCheckpoint;
}

/**
 * Time budget of one attempt. The hard timeout is still enforced by the
 * executor; the budget lets a connector stop gracefully before it.
 */
export interface ConnectorTimeBudget {
  /** Hard timeout instant (the attempt is aborted as TIMEOUT after it). */
  readonly deadlineAt: Date;
  /** Instant after which the connector should stop starting new work. */
  readonly softDeadlineAt: Date;
  remainingMs(): number;
  /** true once the soft deadline has passed. */
  shouldYield(): boolean;
}

export interface ConnectorExecutionContext {
  sourceId: string;
  runId: string;
  attemptId: string;
  signal: AbortSignal;
  /** Always provided by the executor; optional for direct/test invocations. */
  budget?: ConnectorTimeBudget;
}

export interface CollectionConnector {
  /**
   * Identificador lógico do tipo de conector.
   * Exemplos futuros: "dou", "confaz", "receita-federal".
   *
   * Não corresponde ao UUID da tabela sources.
   */
  readonly key: string;
  readonly version?: string;

  collect(context: ConnectorExecutionContext): Promise<ConnectorResult>;
}
