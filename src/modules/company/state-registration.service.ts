export type StateRegistrationLookupStatus =
  | 'SUCCESS'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'NOT_SUPPORTED';

export type StateRegistrationLookup = {
  registration: string | null;
  registrationStatus: string | null;
  lookupStatus: StateRegistrationLookupStatus;
  source: string | null;
  checkedAt: string;
};

type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const GO_LANDING_URLS = [
  'https://appasp.sefaz.go.gov.br/Sintegra/Consulta/default.html',
  'https://appasp.sefaz.go.gov.br/Sintegra/Consulta/default.asp',
] as const;
const GO_RESULT_URL =
  'https://appasp.sefaz.go.gov.br/Sintegra/Consulta/consultar.asp';

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    aacute: 'á',
    Aacute: 'Á',
    atilde: 'ã',
    Atilde: 'Ã',
    ccedil: 'ç',
    Ccedil: 'Ç',
    eacute: 'é',
    Eacute: 'É',
    iacute: 'í',
    Iacute: 'Í',
    oacute: 'ó',
    Oacute: 'Ó',
    otilde: 'õ',
    Otilde: 'Õ',
    uacute: 'ú',
    Uacute: 'Ú',
  };

  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (match, entity: string) =>
      named[entity] ?? match,
    );
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/td>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function compactRegistration(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

export function parseGoSintegraResult(
  html: string,
  checkedAt = new Date(),
): StateRegistrationLookup {
  const text = htmlToText(html);

  const registrationMatch = text.match(
    /Inscri[cç][aã]o\s+Estadual(?:\s*-\s*CCE)?\s*:?[\s\n]*([0-9.\-]+)/i,
  );

  const statusMatch = text.match(
    /Situa[cç][aã]o\s+Cadastral(?:\s+Vigente|\s+Atual)?\s*:?[\s\n]*([^\n]{1,80})/i,
  );

  if (registrationMatch?.[1]) {
    return {
      registration: compactRegistration(registrationMatch[1]),
      registrationStatus:
        statusMatch?.[1]?.trim() ?? null,
      lookupStatus: 'SUCCESS',
      source: 'SEFAZ_GO_SINTEGRA',
      checkedAt: checkedAt.toISOString(),
    };
  }

  if (
    /n[aã]o\s+(?:foi\s+)?(?:encontrado|localizado)|nenhum\s+contribuinte|sem\s+registro/i.test(
      text,
    )
  ) {
    return {
      registration: null,
      registrationStatus: null,
      lookupStatus: 'NOT_FOUND',
      source: 'SEFAZ_GO_SINTEGRA',
      checkedAt: checkedAt.toISOString(),
    };
  }

  return {
    registration: null,
    registrationStatus: null,
    lookupStatus: 'UNAVAILABLE',
    source: 'SEFAZ_GO_SINTEGRA',
    checkedAt: checkedAt.toISOString(),
  };
}

function responseCookies(response: Response): string | undefined {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies
      .map((cookie) => cookie.split(';', 1)[0])
      .join('; ');
  }

  const raw = response.headers.get('set-cookie');
  return raw?.split(';', 1)[0];
}

async function lookupGoSintegra(
  cnpj: string,
  fetcher: RegistryFetch,
): Promise<StateRegistrationLookup> {
  const checkedAt = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const browserHeaders = {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
  };

  try {
    let landing: Response | null = null;
    let landingUrl = GO_LANDING_URLS[0];

    for (const candidate of GO_LANDING_URLS) {
      const response = await fetcher(candidate, {
        headers: browserHeaders,
        signal: controller.signal,
      });

      if (response.ok) {
        landing = response;
        landingUrl = candidate;
        break;
      }
    }

    if (!landing) {
      return {
        registration: null,
        registrationStatus: null,
        lookupStatus: 'UNAVAILABLE',
        source: 'SEFAZ_GO_SINTEGRA',
        checkedAt: checkedAt.toISOString(),
      };
    }

    const cookie = responseCookies(landing);
    const normalized = onlyDigits(cnpj);

    const body = new URLSearchParams({
      rTipoDoc: '2',
      tDoc: normalized,
      tCCE: '',
      tCNPJ: normalized,
      tCPF: '',
      btCGC: 'Consulta=',
      'zion.SystemAction': 'consultaSintegra()',
      'zion.OnSubmited': '',
      'zion.FormElementPosted': 'zionFormID_1',
      zionPostMethod: '',
      zionRichValidator: 'true',
    });

    const response = await fetcher(GO_RESULT_URL, {
      method: 'POST',
      headers: {
        ...browserHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: landingUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        registration: null,
        registrationStatus: null,
        lookupStatus: 'UNAVAILABLE',
        source: 'SEFAZ_GO_SINTEGRA',
        checkedAt: checkedAt.toISOString(),
      };
    }

    return parseGoSintegraResult(
      await response.text(),
      checkedAt,
    );
  } catch {
    return {
      registration: null,
      registrationStatus: null,
      lookupStatus: 'UNAVAILABLE',
      source: 'SEFAZ_GO_SINTEGRA',
      checkedAt: checkedAt.toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupStateRegistration(
  cnpj: string,
  uf: string,
  fetcher: RegistryFetch = fetch,
): Promise<StateRegistrationLookup> {
  const normalizedUf = uf.trim().toUpperCase();

  if (normalizedUf === 'GO') {
    return lookupGoSintegra(cnpj, fetcher);
  }

  return {
    registration: null,
    registrationStatus: null,
    lookupStatus: 'NOT_SUPPORTED',
    source: null,
    checkedAt: new Date().toISOString(),
  };
}
