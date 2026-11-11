/**
 * E9 P2-c, COORD decision D (tribusca-control#116): the route GUARD for the controlled discovery of the ADE Corat
 * 33/2025 Anexo Único (Agenda Tributária, janeiro de 2026). Pure function, offline: there is NO collector and NO
 * request here — discovery and capture stay unauthorized. The path is a HYPOTHESIS to confirm.
 *
 * One canonical form, so the initial URL and the allowed prefix can never disagree:
 * - INDEX (canonical, no trailing slash): https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria
 *   ("…/agenda-tributaria/" is normalized to INDEX; it is the same resource).
 * - CHILD: INDEX + "/" + 1 to 3 segments of [a-z0-9-] (e.g. …/agenda-tributaria/2026/janeiro).
 * Refused (fail closed, before any request): C0/NUL/DEL controls and non-canonical scheme forms (R2 D-1/D-2), other scheme/host, port, credentials, query, fragment, encoded or literal
 * dot segments, encoded slash/backslash, empty segments ("//"), uppercase or other characters in the path, siblings
 * that only share the prefix text ("…/agenda-tributaria-2025"), and anything else on gov.br.
 */
export const CORAT_INDEX = 'https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria';
const INDEX_PATH = new URL(CORAT_INDEX).pathname;
export type CoratRoute = { kind: 'index' | 'child'; href: string };

export function coratRoute(raw: string): CoratRoute | { refused: string } {
  // R2 D-1: control characters are refused on the RAW input (URL() would silently strip C0 controls such as NUL).
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return { refused: 'control character (C0/NUL/DEL) in the URL' };
  // R2 D-2: only the canonical scheme form "https://" + host (lowercase scheme, exactly two slashes) is accepted.
  if (!/^https:\/\/[^/\\]/u.test(raw)) return { refused: 'non-canonical scheme form (must start with "https://host")' };
  if (/[\\\s]/u.test(raw)) return { refused: 'backslash or whitespace in the URL' };
  if (/%(2e|2f|5c|00)/iu.test(raw)) return { refused: 'percent-encoded dot, slash, backslash or NUL' };
  let u: URL; try { u = new URL(raw); } catch { return { refused: 'not a URL' }; }
  if (u.protocol !== 'https:') return { refused: 'scheme must be https' };
  if (u.hostname !== 'www.gov.br') return { refused: `host ${u.hostname} is not www.gov.br` };
  if (u.port || u.username || u.password) return { refused: 'port or credentials not allowed' };
  if (u.search || raw.includes('?')) return { refused: 'query not allowed' };
  if (u.hash || raw.includes('#')) return { refused: 'fragment not allowed' };
  // literal dot segments are resolved by URL(); compare against the raw path so they cannot be smuggled
  const rawPath = raw.replace(/^https:\/\/[^/]+/iu, '');
  if (/(^|\/)\.{1,2}(\/|$)/u.test(rawPath)) return { refused: 'dot segment in the path' };
  if (rawPath.includes('//')) return { refused: 'empty path segment' };
  const path = u.pathname;
  if (path === INDEX_PATH || path === `${INDEX_PATH}/`) return { kind: 'index', href: CORAT_INDEX };
  if (!path.startsWith(`${INDEX_PATH}/`)) return { refused: `outside ${INDEX_PATH}/` };
  const rest = path.slice(INDEX_PATH.length + 1).replace(/\/$/u, '');
  const segs = rest.split('/');
  if (!segs.length || segs.length > 3 || segs.some((s) => !/^[a-z0-9-]{1,80}$/u.test(s))) return { refused: 'child path must be 1–3 lowercase [a-z0-9-] segments' };
  return { kind: 'child', href: `${CORAT_INDEX}/${segs.join('/')}` };
}
