/**
 * ANAT-OFFICIAL-01 R1: one official consultation with a fully validated HTTP chain.
 * - R1-2: redirects are followed manually; protocol and host are checked BEFORE each next request (max 5 hops).
 * - R1-3: only a 2xx answer with an HTML or PDF content type becomes a snapshot; any other answer is a recorded
 *   failure without body, never an "original".
 * - R1-5: the manifest's urlStatus travels with the result; only 'verified' URLs can ever be promoted.
 * - R2-03: a verified URL is not a valid representation. The body must match the declared format (PDF signature for
 *   application/pdf; non-empty markup, and not a PDF, for HTML); otherwise the answer is the recorded failure
 *   `invalid_representation`, without body. `verified` requires BOTH a verified URL and a valid representation.
 */
import { createHash } from 'node:crypto';

export interface ManifestAct { id: string; source: string; act: string; url: string | null; urlStatus: 'candidate' | 'verified' | 'to-locate'; reason: string }
export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
export type Outcome =
  | { ok: true; body: Buffer; meta: { id: string; act: string; url: string; finalUrl: string; hops: string[]; status: number; contentType: string;
      lastModified: string | null; sha256: string; bytes: number; consultedAt: string; urlStatus: ManifestAct['urlStatus']; urlVerified: boolean; representation: 'pdf' | 'html'; verified: boolean; reason: string } }
  | { ok: false; failure: { id: string; url: string; hops: string[]; code: 'host_not_allowed' | 'too_many_redirects' | 'http_error' | 'content_type' | 'network' | 'no_url' | 'invalid_representation';
      detail: string; at: string } };

const ACCEPTED = /^(text\/html|application\/xhtml\+xml|application\/pdf)\b/iu;

/** R2-03: does the body really carry the declared format? Returns the problem, or null when valid. */
export function representationProblem(contentType: string, body: Buffer): string | null {
  if (body.length === 0) return 'corpo vazio';
  const head = body.subarray(0, 1024);
  const pdfAt = head.indexOf('%PDF-');
  if (/^application\/pdf\b/iu.test(contentType)) {
    if (pdfAt < 0 || head.subarray(0, pdfAt).some((b) => b > 0x20)) return 'declarado application/pdf, mas o corpo não começa com a assinatura %PDF-';
    if (!body.includes('%%EOF')) return 'PDF sem marcador %%EOF (truncado ou inválido)';
    return null;
  }
  if (pdfAt >= 0 && head.subarray(0, pdfAt).every((b) => b <= 0x20)) return 'declarado HTML, mas o corpo é um PDF';
  const text = body.toString('utf8');
  if (!text.trim()) return 'corpo HTML sem conteúdo';
  if (!/<[a-z!][^>]*>/iu.test(text)) return 'declarado HTML, mas o corpo não contém marcação';
  return null;
}

export async function consultOfficial(a: ManifestAct, allowedHosts: readonly string[], doFetch: FetchLike, now = () => new Date()): Promise<Outcome> {
  const fail = (code: Extract<Outcome, { ok: false }>['failure']['code'], detail: string, hops: string[]): Outcome =>
    ({ ok: false, failure: { id: a.id, url: a.url ?? '', hops, code, detail, at: now().toISOString() } });
  if (!a.url) return fail('no_url', `URL ainda não localizada (${a.urlStatus})`, []);
  const allowed = (u: URL) => u.protocol === 'https:' && allowedHosts.includes(u.hostname);
  let current = new URL(a.url); const hops = [current.href];
  if (!allowed(current)) return fail('host_not_allowed', current.href, hops);
  for (let hop = 0; hop <= 5; hop++) {
    let res;
    try { res = await doFetch(current.href, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'TriBusca-ANAT-OFFICIAL-01 (consulta pontual)' } }); }
    catch (e) { const c = (e as Error).cause; return fail('network', c instanceof Error ? c.message : (e as Error).message, hops); }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return fail('http_error', `redirecionamento ${res.status} sem Location`, hops);
      const next = new URL(location, current);
      hops.push(next.href);
      if (!allowed(next)) return fail('host_not_allowed', `redirecionamento para ${next.protocol}//${next.hostname} recusado antes da requisição`, hops);
      current = next; continue;
    }
    if (res.status < 200 || res.status >= 300) return fail('http_error', `HTTP ${res.status}`, hops);
    const contentType = res.headers.get('content-type') ?? '';
    if (!ACCEPTED.test(contentType)) return fail('content_type', `tipo de conteúdo não aceito: ${contentType || '(ausente)'}`, hops);
    const body = Buffer.from(await res.arrayBuffer());
    const problem = representationProblem(contentType, body);
    if (problem) return fail('invalid_representation', problem, hops);
    const representation = /^application\/pdf\b/iu.test(contentType) ? 'pdf' as const : 'html' as const;
    return { ok: true, body, meta: { id: a.id, act: a.act, url: a.url, finalUrl: current.href, hops, status: res.status, contentType,
      lastModified: res.headers.get('last-modified'), sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length,
      consultedAt: now().toISOString(), urlStatus: a.urlStatus, urlVerified: a.urlStatus === 'verified', representation, verified: a.urlStatus === 'verified', reason: a.reason } };
  }
  return fail('too_many_redirects', 'mais de 5 redirecionamentos', hops);
}
