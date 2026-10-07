import type { PoolClient } from 'pg';

import type { SqlRunner } from './curation/curation.read.js';

export const TAXONOMY_COMPATIBILITY_MANIFEST_KEY = 'taxonomyCompatibility';

export interface TaxonomyCodeCompatibility {
  version: 1;
  redirects: Record<string, string>;
  retiredCodes: string[];
}

const EMPTY_COMPATIBILITY: TaxonomyCodeCompatibility = {
  version: 1,
  redirects: {},
  retiredCodes: [],
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseTaxonomyCodeCompatibility(
  manifest: unknown,
): TaxonomyCodeCompatibility {
  const root = recordValue(manifest);
  const raw = recordValue(root?.[TAXONOMY_COMPATIBILITY_MANIFEST_KEY]);
  if (!raw) return { ...EMPTY_COMPATIBILITY, redirects: {} };

  const redirectsRaw = recordValue(raw.redirects);
  const redirects: Record<string, string> = {};
  for (const [from, to] of Object.entries(redirectsRaw ?? {})) {
    if (typeof to === 'string' && from.trim() && to.trim()) {
      redirects[from] = to;
    }
  }

  const retiredCodes = Array.isArray(raw.retiredCodes)
    ? [
        ...new Set(
          raw.retiredCodes.filter(
            (code): code is string => typeof code === 'string' && code.trim().length > 0,
          ),
        ),
      ].sort()
    : [];

  return {
    version: 1,
    redirects,
    retiredCodes,
  };
}

export function resolveTaxonomyConceptCode(
  code: string,
  compatibility: TaxonomyCodeCompatibility,
): string | null {
  const retired = new Set(compatibility.retiredCodes);
  const visited = new Set<string>();
  let current = code;

  while (compatibility.redirects[current]) {
    if (visited.has(current)) {
      throw new Error('TAXONOMY_CODE_REDIRECT_CYCLE:' + code);
    }
    visited.add(current);
    current = compatibility.redirects[current]!;
  }

  return retired.has(current) ? null : current;
}

export function canonicalizeTaxonomyConceptCodes(
  codes: readonly string[],
  compatibility: TaxonomyCodeCompatibility,
): string[] {
  return [
    ...new Set(
      codes
        .map((code) => resolveTaxonomyConceptCode(code, compatibility))
        .filter((code): code is string => Boolean(code)),
    ),
  ].sort();
}

export async function loadTaxonomyCodeCompatibility(
  run: SqlRunner,
  releaseId: string,
): Promise<TaxonomyCodeCompatibility> {
  const rows = await run<{ manifest: unknown }>(
    'SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid',
    [releaseId],
  );
  return parseTaxonomyCodeCompatibility(rows[0]?.manifest);
}

export interface TaxonomyCodeCompatibilityPatch {
  redirects?: Readonly<Record<string, string>>;
  retiredCodes?: readonly string[];
}

function terminalRedirectTarget(
  code: string,
  redirects: Readonly<Record<string, string>>,
): string {
  const visited = new Set<string>();
  let current = code;
  while (redirects[current]) {
    if (visited.has(current)) {
      throw new Error('TAXONOMY_CODE_REDIRECT_CYCLE:' + code);
    }
    visited.add(current);
    current = redirects[current]!;
  }
  return current;
}

export function applyTaxonomyCodeCompatibilityPatch(
  compatibility: TaxonomyCodeCompatibility,
  patch: TaxonomyCodeCompatibilityPatch,
): TaxonomyCodeCompatibility {
  const redirects = { ...compatibility.redirects };
  const retired = new Set(compatibility.retiredCodes);

  for (const [from, to] of Object.entries(patch.redirects ?? {})) {
    if (!from || !to || from === to) continue;
    redirects[from] = to;
    retired.delete(from);
    // Redirect targets are active successors (including RESTORE targets).
    retired.delete(to);
  }

  for (const code of patch.retiredCodes ?? []) {
    if (!redirects[code]) retired.add(code);
  }

  // If a canonical target is retired, every inherited alias that resolves to
  // it also becomes retired. Keeping alias -> retired-target redirects would
  // be fail-closed at publish time but would make the next release impossible
  // to publish without manually repairing compatibility.
  const aliasesOfRetiredTargets = Object.keys(redirects).filter((from) =>
    retired.has(terminalRedirectTarget(from, redirects)),
  );
  for (const from of aliasesOfRetiredTargets) {
    delete redirects[from];
    retired.add(from);
  }

  // Collapse inherited redirect chains to the newest canonical code and
  // refuse cycles before they can become part of a published release.
  const merged: TaxonomyCodeCompatibility = {
    version: 1,
    redirects,
    retiredCodes: [...retired].sort(),
  };
  for (const [from, to] of Object.entries({ ...redirects })) {
    const resolved = resolveTaxonomyConceptCode(to, merged);
    if (resolved) redirects[from] = resolved;
  }

  return {
    version: 1,
    redirects: Object.fromEntries(
      Object.entries(redirects).sort(([left], [right]) => left.localeCompare(right)),
    ),
    retiredCodes: [...retired].sort(),
  };
}

export async function updateDraftTaxonomyCodeCompatibility(
  client: PoolClient,
  releaseId: string,
  patch: TaxonomyCodeCompatibilityPatch,
): Promise<TaxonomyCodeCompatibility> {
  const current = await client.query<{ manifest: unknown }>(
    "SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid AND status = 'DRAFT'",
    [releaseId],
  );
  if (!current.rows[0]) {
    throw new Error('DRAFT_NOT_FOUND');
  }

  const compatibility = parseTaxonomyCodeCompatibility(current.rows[0].manifest);
  const next = applyTaxonomyCodeCompatibilityPatch(compatibility, patch);

  const updated = await client.query(
    `
      UPDATE taxonomy_releases
      SET manifest = jsonb_set(
        COALESCE(manifest, '{}'::jsonb),
        '{taxonomyCompatibility}',
        $2::jsonb,
        true
      )
      WHERE id = $1::uuid AND status = 'DRAFT'
    `,
    [releaseId, JSON.stringify(next)],
  );
  if (updated.rowCount !== 1) throw new Error('DRAFT_NOT_FOUND');
  return next;
}
