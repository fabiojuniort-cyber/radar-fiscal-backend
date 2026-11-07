/**
 * Request budget for finite official collections (R2 of #303, c.6708499687). FAIL CLOSED.
 *
 * - The state file must exist, parse and match the schema exactly; anything else refuses (no request is sent).
 * - A run needs an exact, active, unexpired GRANT (grantId, owner, package, per-type and total caps, approval ref).
 *   The caller must name the same grantId and owner. The historical 28/25 ledger is NOT a grant and is never read here.
 * - Every attempt is DEBITED AND PERSISTED BEFORE it is sent (write to a temp file + rename), then settled with its
 *   outcome (HTTP status, redirect target, error/timeout). An attempt that throws stays debited. Counters only grow.
 * - Redirects are never followed implicitly: each hop is a new attempt, debited like any other.
 * - A local lease (exclusive lock file) refuses a concurrent or re-entrant run on this checkout. A stale lock after a
 *   crash is NOT broken automatically: it refuses until a person inspects the state. The lock does not coordinate
 *   different checkouts/machines — that is the single owner's job (the grant names one owner).
 * - R3 (#303 c.6709334225): the lease is acquired BEFORE the state is read and validated, so no run can decide on a
 *   stale snapshot; a refused open releases the lease it took (never a lease it did not take). Before EVERY debit the
 *   state is re-read from disk under the lease and must be exactly the one this run last wrote, with the grant still
 *   active, unexpired and the same grant/owner/package. close() invalidates the instance: any later debit, settle or
 *   send is refused (nothing is sent).
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';

export class BudgetRefused extends Error {}
export interface Grant {
  grantId: string; owner: string; package: string; approvedBy: string; status: 'active' | 'suspended' | 'closed';
  expiresAt: string; total: number; perType: Record<string, number>;
}
export interface Attempt { n: number; type: string; kind: string; url: string; debitedAt: string; state: 'sent' | 'settled'; outcome: string | null; settledAt: string | null }
export interface BudgetState { schema: 'request-budget/1'; grant: Grant | null; used: { total: number; perType: Record<string, number> }; attempts: Attempt[] }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isRecordOfInt = (v: unknown): v is Record<string, number> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isInt);

/** Strict schema check; returns the reason it is invalid, or null. */
export function invalidState(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'state is not an object';
  const st = s as Partial<BudgetState>;
  if (st.schema !== 'request-budget/1') return 'unknown schema';
  if (!st.used || !isInt(st.used.total) || !isRecordOfInt(st.used.perType)) return 'invalid used counters';
  if (!Array.isArray(st.attempts) || st.attempts.length !== st.used.total) return 'attempts do not match the used total';
  if (st.attempts.some((a, i) => !a || a.n !== i + 1 || !isStr(a.type) || !isStr(a.url) || !['sent', 'settled'].includes(a.state))) return 'invalid attempt rows';
  const perType: Record<string, number> = {}; for (const a of st.attempts) perType[a.type] = (perType[a.type] ?? 0) + 1;
  if (Object.keys(perType).some((k) => perType[k] !== st.used!.perType[k]) || Object.keys(st.used.perType).some((k) => st.used!.perType[k] !== (perType[k] ?? 0))) return 'per-type counters do not match the attempts';
  if (st.grant !== null) {
    const g = st.grant as Partial<Grant> | undefined;
    if (!g || !isStr(g.grantId) || !isStr(g.owner) || !isStr(g.package) || !isStr(g.approvedBy) || !['active', 'suspended', 'closed'].includes(g.status as string)
      || !isStr(g.expiresAt) || Number.isNaN(Date.parse(g.expiresAt)) || !isInt(g.total) || g.total < 1 || !isRecordOfInt(g.perType)
      || Object.keys(g.perType).length === 0 || Object.values(g.perType).some((x) => x < 1)) return 'invalid grant';
  }
  return null;
}

type Who = { grantId: string; owner: string; package: string };
/** Reads and validates the state file; the grant must be active, unexpired and the caller's. Throws BudgetRefused. */
function readActive(file: string, who: Who, now: () => Date): BudgetState {
  if (!existsSync(file)) throw new BudgetRefused('budget state is missing');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new BudgetRefused('budget state is not valid JSON'); }
  const bad = invalidState(parsed); if (bad) throw new BudgetRefused(`budget state is invalid: ${bad}`);
  const s = parsed as BudgetState; const g = s.grant;
  if (!g) throw new BudgetRefused('no grant: nothing may be sent');
  if (g.status !== 'active') throw new BudgetRefused(`grant ${g.grantId} is ${g.status}`);
  if (Date.parse(g.expiresAt) <= now().getTime()) throw new BudgetRefused(`grant ${g.grantId} expired at ${g.expiresAt}`);
  if (g.grantId !== who.grantId || g.owner !== who.owner || g.package !== who.package) throw new BudgetRefused('grant id, owner or package differs from the caller');
  return s;
}

export class RequestBudget {
  private closed = false;
  private constructor(private readonly file: string, private readonly lock: string, private state: BudgetState, private readonly who: Who, private readonly now: () => Date) {}

  /**
   * Opens the budget for one run. Acquires the local lease FIRST, then reads and validates the state under it; any
   * refusal releases the lease this call took. `onLeased` is a test seam (deterministic interleaving), called right
   * after the lease is taken and before the state is read.
   */
  static open(file: string, who: Who & { requested: { total: number; perType?: Record<string, number> } }, now = () => new Date(), onLeased?: () => void): RequestBudget {
    if (!existsSync(file)) throw new BudgetRefused('budget state is missing');
    const lock = `${file}.lock`;
    let fd: number;
    try { fd = openSync(lock, 'wx'); } catch { throw new BudgetRefused('another run holds the lease (or a crashed run left it): inspect the state before removing the lock'); }
    try {
      writeSync(fd, JSON.stringify({ owner: who.owner, grantId: who.grantId, pid: process.pid, at: now().toISOString() })); closeSync(fd);
      onLeased?.();
      const s = readActive(file, who, now); const g = s.grant!;
      if (!isInt(who.requested.total) || who.requested.total < 1) throw new BudgetRefused('requested total must be a positive integer');
      const remaining = g.total - s.used.total;
      if (who.requested.total > remaining) throw new BudgetRefused(`requested ${who.requested.total} exceeds the remaining ${remaining} of grant ${g.grantId}`);
      for (const [t, q] of Object.entries(who.requested.perType ?? {})) {
        if (!isInt(q) || !(t in g.perType)) throw new BudgetRefused(`type ${t} is not in grant ${g.grantId}`);
        if (q > g.perType[t]! - (s.used.perType[t] ?? 0)) throw new BudgetRefused(`requested ${q} for ${t} exceeds its remaining cap`);
      }
      return new RequestBudget(file, lock, s, { grantId: who.grantId, owner: who.owner, package: who.package }, now);
    } catch (e) {
      // Release only the lease this call created (a refused open never leaves a lock behind).
      try { unlinkSync(lock); } catch { /* already gone */ }
      throw e;
    }
  }

  private assertOpen(): void { if (this.closed) throw new BudgetRefused('budget is closed: no further debit, settle or send'); }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`); renameSync(tmp, this.file);
  }

  /** Debits one attempt and PERSISTS it before returning; refuses beyond the per-type or total cap. */
  debit(type: string, kind: string, url: string): number {
    this.assertOpen();
    if (!existsSync(this.lock)) throw new BudgetRefused('the lease is gone: nothing may be sent');
    // Re-read under the lease: the grant must still be active/unexpired and the state exactly what this run wrote.
    const disk = readActive(this.file, this.who, this.now);
    if (JSON.stringify({ used: disk.used, attempts: disk.attempts }) !== JSON.stringify({ used: this.state.used, attempts: this.state.attempts })) throw new BudgetRefused('budget state changed outside this run');
    this.state = disk;
    const g = this.state.grant!;
    if (!(type in g.perType)) throw new BudgetRefused(`type ${type} is not in the grant`);
    if (this.state.used.total + 1 > g.total) throw new BudgetRefused('grant total exhausted');
    if ((this.state.used.perType[type] ?? 0) + 1 > g.perType[type]!) throw new BudgetRefused(`cap for ${type} exhausted`);
    this.state.used.total++; this.state.used.perType[type] = (this.state.used.perType[type] ?? 0) + 1;
    const n = this.state.used.total;
    this.state.attempts.push({ n, type, kind, url, debitedAt: this.now().toISOString(), state: 'sent', outcome: null, settledAt: null });
    this.persist();
    return n;
  }

  settle(n: number, outcome: string): void {
    this.assertOpen();
    const a = this.state.attempts[n - 1]; if (!a || a.state !== 'sent') throw new Error(`attempt ${n} cannot be settled`);
    a.state = 'settled'; a.outcome = outcome.slice(0, 300); a.settledAt = this.now().toISOString(); this.persist();
  }

  remaining(type?: string): number {
    const g = this.state.grant!;
    return type ? g.perType[type]! - (this.state.used.perType[type] ?? 0) : g.total - this.state.used.total;
  }

  /** fetch wrapper: debit → send with redirect:'manual' → settle (status, redirect target, error or timeout). */
  fetcher(type: string, kind: string, doFetch: typeof fetch): typeof fetch {
    this.assertOpen();
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const n = this.debit(type, kind, url);
      try {
        const r = await doFetch(input, { ...init, redirect: 'manual' });
        const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
        this.settle(n, loc ? `redirect ${r.status} → ${loc} (not followed; a hop is a new attempt)` : `HTTP ${r.status}`);
        return r;
      } catch (e) {
        const err = e as Error; this.settle(n, `${err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'error'}: ${err.message}`);
        throw e;
      }
    }) as typeof fetch;
  }

  close(): void { if (this.closed) return; this.closed = true; if (existsSync(this.lock)) unlinkSync(this.lock); }
}
