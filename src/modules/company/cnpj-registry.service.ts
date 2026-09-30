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
    | 'MINHA_RECEITA_DIRECT';
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

type RegistryProvider = {
  url: (cnpj: string) => string;
  source: CnpjRegistryRecord['source'];
};

const REGISTRY_PROVIDERS: RegistryProvider[] = [
  {
    url: (cnpj) =>
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    source: 'BRASILAPI_MINHA_RECEITA',
  },
  {
    url: (cnpj) =>
      `https://minhareceita.org/${cnpj}`,
    source: 'MINHA_RECEITA_DIRECT',
  },
];

async function fetchRegistryProvider(
  provider: RegistryProvider,
  normalizedCnpj: string,
  fetcher: RegistryFetch,
): Promise<
  | { kind: 'success'; record: CnpjRegistryRecord }
  | { kind: 'not_found' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
> {
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
      const record = parseBrasilApiCnpj(
        payload,
        new Date(),
        provider.source,
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

export async function lookupCnpjRegistry(
  cnpj: string,
  fetcher: RegistryFetch = fetch,
): Promise<CnpjRegistryRecord> {
  const normalized =
    cnpj.replace(/\D/g, '');

  let sawNotFound = false;
  let sawInvalid = false;

  for (const provider of REGISTRY_PROVIDERS) {
    const result =
      await fetchRegistryProvider(
        provider,
        normalized,
        fetcher,
      );

    if (result.kind === 'success') {
      return result.record;
    }

    if (result.kind === 'not_found') {
      sawNotFound = true;
      continue;
    }

    if (result.kind === 'invalid') {
      sawInvalid = true;
    }
  }

  if (sawNotFound) {
    throw new CnpjRegistryError(
      'cnpj_not_found',
    );
  }

  if (sawInvalid) {
    throw new CnpjRegistryError(
      'cnpj_provider_invalid_response',
    );
  }

  throw new CnpjRegistryError(
    'cnpj_provider_unavailable',
  );
}
