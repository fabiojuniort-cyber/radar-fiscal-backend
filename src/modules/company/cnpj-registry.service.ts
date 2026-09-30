export type CnpjRegistryCnae = {
  code: string;
  description: string;
  isPrimary: boolean;
};

export type CnpjRegistryRecord = {
  cnpj: string;
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
  source:
    | 'BRASILAPI_MINHA_RECEITA'
    | 'MINHA_RECEITA_DIRECT'
    | 'CNPJ_WS_PUBLIC';
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

type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
  source: CnpjRegistryRecord['source'] =
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

export function parseCnpjWsCnpj(
  payload: unknown,
  consultedAt = new Date(),
): CnpjRegistryRecord {
  const row = recordValue(payload);
  const establishment = recordValue(
    row?.estabelecimento,
  );
  const state = recordValue(
    establishment?.estado,
  );
  const city = recordValue(
    establishment?.cidade,
  );
  const primaryActivity = recordValue(
    establishment?.atividade_principal,
  );

  if (!row || !establishment) {
    throw new CnpjRegistryError(
      'cnpj_provider_invalid_response',
    );
  }

  const streetType = textValue(
    establishment.tipo_logradouro,
  );
  const streetName = textValue(
    establishment.logradouro,
  );
  const street = [streetType, streetName]
    .filter((value): value is string =>
      Boolean(value),
    )
    .join(' ') || null;

  return parseBrasilApiCnpj(
    {
      cnpj: establishment.cnpj,
      razao_social: row.razao_social,
      nome_fantasia:
        establishment.nome_fantasia,
      uf: state?.sigla,
      municipio: city?.nome,
      codigo_municipio_ibge:
        city?.ibge_id,
      cep: establishment.cep,
      logradouro: street,
      numero: establishment.numero,
      complemento:
        establishment.complemento,
      bairro: establishment.bairro,
      descricao_situacao_cadastral:
        establishment.situacao_cadastral,
      data_inicio_atividade:
        establishment.data_inicio_atividade,
      cnae_fiscal:
        primaryActivity?.id,
      cnae_fiscal_descricao:
        primaryActivity?.descricao,
      cnaes_secundarios:
        Array.isArray(
          establishment.atividades_secundarias,
        )
          ? establishment.atividades_secundarias.map(
              (activity) => {
                const item =
                  recordValue(activity);

                return {
                  codigo: item?.id,
                  descricao:
                    item?.descricao,
                };
              },
            )
          : [],
    },
    consultedAt,
    'CNPJ_WS_PUBLIC',
  );
}

type RegistryProvider = {
  url: (cnpj: string) => string;
  source: CnpjRegistryRecord['source'];
  parse: (
    payload: unknown,
    consultedAt: Date,
  ) => CnpjRegistryRecord;
};

const PRIMARY_REGISTRY_PROVIDERS:
  RegistryProvider[] = [
    {
      url: (cnpj) =>
        `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      source: 'BRASILAPI_MINHA_RECEITA',
      parse: (payload, consultedAt) =>
        parseBrasilApiCnpj(
          payload,
          consultedAt,
          'BRASILAPI_MINHA_RECEITA',
        ),
    },
    {
      url: (cnpj) =>
        `https://minhareceita.org/${cnpj}`,
      source: 'MINHA_RECEITA_DIRECT',
      parse: (payload, consultedAt) =>
        parseBrasilApiCnpj(
          payload,
          consultedAt,
          'MINHA_RECEITA_DIRECT',
        ),
    },
  ];

const FALLBACK_REGISTRY_PROVIDERS:
  RegistryProvider[] = [
    {
      url: (cnpj) =>
        `https://publica.cnpj.ws/cnpj/${cnpj}`,
      source: 'CNPJ_WS_PUBLIC',
      parse: (payload, consultedAt) =>
        parseCnpjWsCnpj(
          payload,
          consultedAt,
        ),
    },
  ];

type RegistryProviderResult =
  | {
      kind: 'success';
      record: CnpjRegistryRecord;
    }
  | { kind: 'not_found' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

async function fetchRegistryProvider(
  provider: RegistryProvider,
  normalizedCnpj: string,
  fetcher: RegistryFetch,
): Promise<RegistryProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    8_000,
  );

  try {
    const response = await fetcher(
      provider.url(normalizedCnpj),
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
      return { kind: 'not_found' };
    }

    if (!response.ok) {
      return { kind: 'unavailable' };
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return { kind: 'invalid' };
    }

    try {
      const record = provider.parse(
        payload,
        new Date(),
      );

      if (record.cnpj !== normalizedCnpj) {
        return { kind: 'invalid' };
      }

      return {
        kind: 'success',
        record,
      };
    } catch (error) {
      if (
        error instanceof CnpjRegistryError &&
        error.code ===
          'cnpj_provider_invalid_response'
      ) {
        return { kind: 'invalid' };
      }

      throw error;
    }
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstSuccessfulProvider(
  providers: RegistryProvider[],
  normalizedCnpj: string,
  fetcher: RegistryFetch,
): Promise<{
  success?: CnpjRegistryRecord;
  outcomes: RegistryProviderResult[];
}> {
  const outcomes = new Array<
    RegistryProviderResult | undefined
  >(providers.length);

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
            ): outcome is RegistryProviderResult =>
              outcome !== undefined,
          ),
      });
    };

    providers.forEach(
      (provider, index) => {
        void fetchRegistryProvider(
          provider,
          normalizedCnpj,
          fetcher,
        ).then((outcome) => {
          outcomes[index] = outcome;
          pending -= 1;

          if (
            outcome.kind === 'success' &&
            !settled
          ) {
            settled = true;
            resolve({
              success: outcome.record,
              outcomes:
                outcomes.filter(
                  (
                    current,
                  ): current is RegistryProviderResult =>
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
  fetcher: RegistryFetch = fetch,
): Promise<CnpjRegistryRecord> {
  const normalized =
    cnpj.replace(/\D/g, '');

  const primary =
    await fetchFirstSuccessfulProvider(
      PRIMARY_REGISTRY_PROVIDERS,
      normalized,
      fetcher,
    );

  if (primary.success) {
    return primary.success;
  }

  const fallback =
    await fetchFirstSuccessfulProvider(
      FALLBACK_REGISTRY_PROVIDERS,
      normalized,
      fetcher,
    );

  if (fallback.success) {
    return fallback.success;
  }

  const outcomes = [
    ...primary.outcomes,
    ...fallback.outcomes,
  ];

  if (
    outcomes.some(
      (outcome) =>
        outcome.kind === 'not_found',
    )
  ) {
    throw new CnpjRegistryError(
      'cnpj_not_found',
    );
  }

  if (
    outcomes.some(
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
