import { processLogger } from '../../infrastructure/logging/process-logger.js';

export type CnpjRegistryCnae = {
  code: string;
  description: string;
  isPrimary: boolean;
};

export type CnpjRegistrySource =
  | 'BRASILAPI_MINHA_RECEITA'
  | 'MINHA_RECEITA_DIRECT'
  | 'SERPRO_CNPJ';

export type CnpjRegistryRecord = {
  cnpj: string;
  isHeadOffice?: boolean | null;
  legalName: string;
  tradeName: string | null;
  uf: string;
  municipalityName: string | null;
  municipalityIbgeCode: string | null;
  postalCode: string | null;
  street: string | null;
  streetNumber: string | null;
  complement: string | null;
  district: string | null;
  registrationStatus: string | null;
  openedOn: string | null;
  cnaes: CnpjRegistryCnae[];
  source: CnpjRegistrySource;
  consultedAt: string;
};

export class CnpjRegistryError extends Error {
  constructor(
    public readonly code:
      | 'cnpj_not_found'
      | 'cnpj_provider_unavailable'
      | 'cnpj_provider_invalid_response',
  ) {
    super(code);
  }
}

export type CnpjRegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CnpjRegistryProviderResult =
  | {
      kind: 'success';
      record: CnpjRegistryRecord;
      httpStatus?: number;
    }
  | {
      kind: 'not_found';
      httpStatus?: number;
    }
  | {
      kind: 'invalid';
      httpStatus?: number;
      errorClass?: string;
    }
  | {
      kind: 'unavailable';
      httpStatus?: number;
      errorClass?: string;
    }
  | {
      kind: 'cancelled';
      errorClass?: string;
    };

export interface CnpjRegistryProvider {
  readonly code: string;
  readonly source: CnpjRegistrySource;
  lookup(
    normalizedCnpj: string,
    fetcher: CnpjRegistryFetch,
    externalSignal?: AbortSignal,
  ): Promise<CnpjRegistryProviderResult>;
}

function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0
    ? normalized
    : null;
}

function digits(
  value: unknown,
  length?: number,
): string | null {
  const raw =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';

  const normalized = raw.replace(/\D/g, '');

  if (!normalized) return null;
  if (length && normalized.length > length) return null;

  return length
    ? normalized.padStart(length, '0')
    : normalized;
}

function normalizeUf(
  value: unknown,
): string | null {
  const uf = textValue(value)?.toUpperCase() ?? null;
  return uf && /^[A-Z]{2}$/.test(uf)
    ? uf
    : null;
}

function parseCnae(
  value: unknown,
  isPrimary: boolean,
): CnpjRegistryCnae | null {
  const row = recordValue(value);
  if (!row) return null;

  const code = digits(
    row.codigo ?? row.code,
    7,
  );
  const description = textValue(
    row.descricao ?? row.description,
  );

  if (!code || !description) return null;

  return {
    code,
    description,
    isPrimary,
  };
}

function dedupeCnaes(
  items: CnpjRegistryCnae[],
): CnpjRegistryCnae[] {
  const byCode = new Map<
    string,
    CnpjRegistryCnae
  >();

  for (const item of items) {
    const existing = byCode.get(item.code);

    if (!existing || item.isPrimary) {
      byCode.set(item.code, {
        ...item,
        isPrimary:
          item.isPrimary ||
          Boolean(existing?.isPrimary),
      });
    }
  }

  return [...byCode.values()].sort(
    (left, right) =>
      Number(right.isPrimary) -
        Number(left.isPrimary) ||
      left.code.localeCompare(right.code),
  );
}

export function parseBrasilApiCnpj(
  payload: unknown,
  consultedAt = new Date(),
  source: CnpjRegistrySource =
    'BRASILAPI_MINHA_RECEITA',
): CnpjRegistryRecord {
  const row = recordValue(payload);

  if (!row) {
    throw new CnpjRegistryError(
      'cnpj_provider_invalid_response',
    );
  }

  const cnpj = digits(row.cnpj, 14);
  const legalName = textValue(
    row.razao_social,
  );
  const uf = normalizeUf(row.uf);

  if (!cnpj || !legalName || !uf) {
    throw new CnpjRegistryError(
      'cnpj_provider_invalid_response',
    );
  }

  const primaryCode = digits(
    row.cnae_fiscal,
    7,
  );
  const primaryDescription =
    textValue(row.cnae_fiscal_descricao) ??
    textValue(
      recordValue(
        Array.isArray(
          row.cnaes_secundarios,
        )
          ? row.cnaes_secundarios.find(
              (item) =>
                digits(
                  recordValue(item)
                    ?.codigo,
                  7,
                ) === primaryCode,
            )
          : undefined,
      )?.descricao,
    );

  const cnaes: CnpjRegistryCnae[] = [];

  if (primaryCode) {
    cnaes.push({
      code: primaryCode,
      description:
        primaryDescription ??
        'Descrição não informada pelo provedor',
      isPrimary: true,
    });
  }

  if (
    Array.isArray(
      row.cnaes_secundarios,
    )
  ) {
    for (
      const item of
      row.cnaes_secundarios
    ) {
      const parsed = parseCnae(
        item,
        false,
      );
      if (parsed) cnaes.push(parsed);
    }
  }

  return {
    cnpj,
    isHeadOffice:
      String(row.identificador_matriz_filial ?? row.matriz_filial ?? '').toUpperCase() === '1' ||
      String(row.identificador_matriz_filial ?? row.matriz_filial ?? '').toUpperCase() === 'MATRIZ'
        ? true
        : String(row.identificador_matriz_filial ?? row.matriz_filial ?? '').toUpperCase() === '2' ||
          String(row.identificador_matriz_filial ?? row.matriz_filial ?? '').toUpperCase() === 'FILIAL'
          ? false : null,
    legalName,
    tradeName: textValue(
      row.nome_fantasia,
    ),
    uf,
    municipalityName:
      textValue(row.municipio),
    municipalityIbgeCode:
      digits(
        row.codigo_municipio_ibge ??
          row.codigo_municipio,
        7,
      ),
    postalCode: digits(row.cep, 8),
    street: textValue(row.logradouro),
    streetNumber: textValue(row.numero),
    complement: textValue(
      row.complemento,
    ),
    district: textValue(row.bairro),
    registrationStatus:
      textValue(
        row.descricao_situacao_cadastral,
      ) ??
      textValue(row.situacao_cadastral),
    openedOn:
      textValue(
        row.data_inicio_atividade,
      ),
    cnaes: dedupeCnaes(cnaes),
    source,
    consultedAt:
      consultedAt.toISOString(),
  };
}

function errorClass(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.name || 'Error';
  }

  return typeof error;
}

function createJsonProvider(
  code: string,
  source: CnpjRegistrySource,
  url: (cnpj: string) => string,
): CnpjRegistryProvider {
  return {
    code,
    source,
    async lookup(
      normalizedCnpj,
      fetcher,
      externalSignal,
    ) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8_000);
      const abortFromExternal = () =>
        controller.abort();

      if (externalSignal?.aborted) {
        controller.abort();
      } else {
        externalSignal?.addEventListener(
          'abort',
          abortFromExternal,
          { once: true },
        );
      }

      try {
        const response = await fetcher(
          url(normalizedCnpj),
          {
            headers: {
              Accept: 'application/json',
              'User-Agent':
                'TriBusca-Radar-Fiscal/1.0',
            },
            signal: controller.signal,
          },
        );

        if (response.status === 404) {
          return {
            kind: 'not_found',
            httpStatus: 404,
          };
        }

        if (!response.ok) {
          return {
            kind: 'unavailable',
            httpStatus: response.status,
          };
        }

        let payload: unknown;

        try {
          payload = await response.json();
        } catch (error) {
          return {
            kind: 'invalid',
            httpStatus: response.status,
            errorClass: errorClass(error),
          };
        }

        try {
          const record = parseBrasilApiCnpj(
            payload,
            new Date(),
            source,
          );

          if (record.cnpj !== normalizedCnpj) {
            return {
              kind: 'invalid',
              httpStatus: response.status,
              errorClass: 'CnpjMismatch',
            };
          }

          return {
            kind: 'success',
            record,
            httpStatus: response.status,
          };
        } catch (error) {
          if (
            error instanceof CnpjRegistryError &&
            error.code ===
              'cnpj_provider_invalid_response'
          ) {
            return {
              kind: 'invalid',
              httpStatus: response.status,
              errorClass: error.name,
            };
          }

          throw error;
        }
      } catch (error) {
        if (
          externalSignal?.aborted &&
          !timedOut
        ) {
          return {
            kind: 'cancelled',
            errorClass: errorClass(error),
          };
        }

        return {
          kind: 'unavailable',
          errorClass: errorClass(error),
        };
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener(
          'abort',
          abortFromExternal,
        );
      }
    },
  };
}

const DEFAULT_CNPJ_REGISTRY_PROVIDERS:
  readonly CnpjRegistryProvider[] = [
    createJsonProvider(
      'BRASILAPI',
      'BRASILAPI_MINHA_RECEITA',
      (cnpj) =>
        `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    ),
    createJsonProvider(
      'MINHA_RECEITA',
      'MINHA_RECEITA_DIRECT',
      (cnpj) =>
        `https://minhareceita.org/${cnpj}`,
    ),
  ];

export function getDefaultCnpjRegistryProviders():
  readonly CnpjRegistryProvider[] {
  return DEFAULT_CNPJ_REGISTRY_PROVIDERS;
}

function logProviderResult(
  provider: CnpjRegistryProvider,
  result: CnpjRegistryProviderResult,
  startedAt: number,
): void {
  const durationMs = Math.max(
    0,
    Date.now() - startedAt,
  );
  const data: Record<string, unknown> = {
    provider: provider.code,
    source: provider.source,
    outcome: result.kind,
    durationMs,
  };

  if (
    'httpStatus' in result &&
    result.httpStatus !== undefined
  ) {
    data.httpStatus = result.httpStatus;
  }

  if (
    'errorClass' in result &&
    result.errorClass
  ) {
    data.errorClass = result.errorClass;
  }

  if (
    result.kind === 'success' ||
    result.kind === 'not_found' ||
    result.kind === 'cancelled'
  ) {
    processLogger.info(
      data,
      'cnpj_registry_provider_attempt',
    );
    return;
  }

  processLogger.warn(
    data,
    'cnpj_registry_provider_attempt',
  );
}

async function runProvider(
  provider: CnpjRegistryProvider,
  normalizedCnpj: string,
  fetcher: CnpjRegistryFetch,
  externalSignal?: AbortSignal,
): Promise<CnpjRegistryProviderResult> {
  const startedAt = Date.now();
  let result: CnpjRegistryProviderResult;

  try {
    result = await provider.lookup(
      normalizedCnpj,
      fetcher,
      externalSignal,
    );
  } catch (error) {
    result = {
      kind: 'unavailable',
      errorClass: errorClass(error),
    };
  }

  logProviderResult(
    provider,
    result,
    startedAt,
  );

  return result;
}

async function fetchFirstSuccessfulProvider(
  providers: readonly CnpjRegistryProvider[],
  normalizedCnpj: string,
  fetcher: CnpjRegistryFetch,
): Promise<{
  success?: CnpjRegistryRecord;
  outcomes: CnpjRegistryProviderResult[];
}> {
  if (providers.length === 0) {
    return { outcomes: [] };
  }

  const outcomes = new Array<
    CnpjRegistryProviderResult | undefined
  >(providers.length);
  const groupController =
    new AbortController();

  return new Promise((resolve) => {
    let pending = providers.length;
    let settled = false;

    const finishWithoutSuccess = () => {
      if (pending !== 0 || settled) return;

      settled = true;
      resolve({
        outcomes:
          outcomes.filter(
            (
              outcome,
            ): outcome is CnpjRegistryProviderResult =>
              outcome !== undefined,
          ),
      });
    };

    providers.forEach(
      (provider, index) => {
        void runProvider(
          provider,
          normalizedCnpj,
          fetcher,
          groupController.signal,
        ).then((outcome) => {
          outcomes[index] = outcome;
          pending -= 1;

          if (
            outcome.kind === 'success' &&
            !settled
          ) {
            settled = true;
            groupController.abort();
            resolve({
              success: outcome.record,
              outcomes:
                outcomes.filter(
                  (
                    current,
                  ): current is CnpjRegistryProviderResult =>
                    current !== undefined,
                ),
            });
            return;
          }

          finishWithoutSuccess();
        });
      },
    );
  });
}

export async function lookupCnpjRegistry(
  cnpj: string,
  fetcher: CnpjRegistryFetch = fetch,
  providers: readonly CnpjRegistryProvider[] =
    DEFAULT_CNPJ_REGISTRY_PROVIDERS,
): Promise<CnpjRegistryRecord> {
  const normalized =
    cnpj.replace(/\D/g, '');

  const result =
    await fetchFirstSuccessfulProvider(
      providers,
      normalized,
      fetcher,
    );

  if (result.success) {
    return result.success;
  }

  const meaningful = result.outcomes.filter(
    (outcome) =>
      outcome.kind !== 'cancelled',
  );

  if (
    meaningful.length > 0 &&
    meaningful.every(
      (outcome) =>
        outcome.kind === 'not_found',
    )
  ) {
    throw new CnpjRegistryError(
      'cnpj_not_found',
    );
  }

  if (
    meaningful.some(
      (outcome) =>
        outcome.kind === 'invalid',
    )
  ) {
    throw new CnpjRegistryError(
      'cnpj_provider_invalid_response',
    );
  }

  throw new CnpjRegistryError(
    'cnpj_provider_unavailable',
  );
}
