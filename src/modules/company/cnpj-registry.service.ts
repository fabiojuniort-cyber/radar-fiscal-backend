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
  source: 'BRASILAPI_MINHA_RECEITA';
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
    source: 'BRASILAPI_MINHA_RECEITA',
    consultedAt:
      consultedAt.toISOString(),
  };
}

export async function lookupCnpjRegistry(
  cnpj: string,
  fetcher: RegistryFetch = fetch,
): Promise<CnpjRegistryRecord> {
  const normalized =
    cnpj.replace(/\D/g, '');

  const controller =
    new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    8_000,
  );

  try {
    const response = await fetcher(
      `https://brasilapi.com.br/api/cnpj/v1/${normalized}`,
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
      throw new CnpjRegistryError(
        'cnpj_not_found',
      );
    }

    if (!response.ok) {
      throw new CnpjRegistryError(
        'cnpj_provider_unavailable',
      );
    }

    const payload =
      await response.json();

    return parseBrasilApiCnpj(
      payload,
    );
  } catch (error) {
    if (
      error instanceof CnpjRegistryError
    ) {
      throw error;
    }

    throw new CnpjRegistryError(
      'cnpj_provider_unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
}
