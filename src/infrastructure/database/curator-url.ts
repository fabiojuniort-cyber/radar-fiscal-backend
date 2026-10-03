export const CURATOR_RUNTIME_ROLE = 'radar_taxonomy_curator_runtime';

/**
 * Connection string for the dedicated taxonomy curator login.
 *
 * DATABASE_CURATOR_URL wins when set. Otherwise the URL is derived from
 * DATABASE_URL (same host/database) with the curator login and
 * DB_CURATOR_RUNTIME_PASSWORD, so production only needs one new secret.
 * Free of the app config so ops scripts can use it with their own env.
 */
export function resolveCuratorDatabaseUrl(source: {
  DATABASE_URL: string;
  DATABASE_CURATOR_URL?: string | undefined;
  DB_CURATOR_RUNTIME_PASSWORD?: string | undefined;
}): string | null {
  if (source.DATABASE_CURATOR_URL) return source.DATABASE_CURATOR_URL;
  if (!source.DB_CURATOR_RUNTIME_PASSWORD) return null;

  const url = new URL(source.DATABASE_URL);
  url.username = CURATOR_RUNTIME_ROLE;
  url.password = source.DB_CURATOR_RUNTIME_PASSWORD;
  return url.toString();
}
