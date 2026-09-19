export type ConnectorSphere = 'FEDERAL' | 'STATE';

export interface ConnectorFile {
  url: string;
  name?: string;
  mimeType?: string;
  externalId?: string;
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

  files?: ConnectorFile[];

  /**
   * Dados específicos da fonte que precisam ser preservados,
   * mas que não pertencem ao modelo canônico comum.
   */
  metadata?: Record<string, unknown>;
}

export interface ConnectorPartialFailure {
  code: string;
  message: string;

  /**
   * Referência opcional ao item que não pôde ser processado.
   */
  itemReference?: string;
}

export interface ConnectorResult {
  publications: ConnectorPublication[];

  /**
   * Permite ao conector informar que parte da fonte foi processada
   * com sucesso e parte falhou.
   */
  partialFailures?: ConnectorPartialFailure[];

  metadata?: Record<string, unknown>;
}

export interface ConnectorExecutionContext {
  sourceId: string;
  runId: string;
  attemptId: string;
  signal: AbortSignal;
}

export interface CollectionConnector {
  /**
   * Identificador lógico do tipo de conector.
   * Exemplos futuros: "dou", "confaz", "receita-federal".
   *
   * Não corresponde ao UUID da tabela sources.
   */
  readonly key: string;

  collect(context: ConnectorExecutionContext): Promise<ConnectorResult>;
}
