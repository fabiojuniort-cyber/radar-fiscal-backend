/**
 * ANAT-ADMIN-01 operational rehearsal (issue tribusca-control#116): memory and failure behaviour of the COMPILED API in
 * its memory-limited container, over real HTTP. Same environment guard and variables as flow.ts, plus RH_CONTAINER (the
 * app container's name). Samples the container's cgroup (cgroup v1: memory.usage_in_bytes / max_usage_in_bytes) and the Node process (VmRSS /
 * VmHWM of PID 1) every 250 ms through `docker exec`, so the figures are the whole process (main thread + workers),
 * never the workers' heap alone.
 * Usage: node --import tsx ops/anatomy/rehearsal/load.ts [simulations=14]
 * Phases: near-limit candidates (20 examples × ~256 Ki UTF-16, 20 000 catalogue codes on 4 of them: the draft body stays under the route's 8 MiB); one burst of concurrent
 * simulations (2 running + 10 queued + overflow) with concurrent reads of the API; client cancellation; capacity check.
 * Prints one JSON line.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION } from '../../../src/modules/anatomy/profile.js';

const API = process.env.RH_API ?? ''; const ADMIN_URL = process.env.RH_ADMIN_URL ?? ''; const SECRET = process.env.RH_JWT ?? '';
const CONTAINER = process.env.RH_CONTAINER ?? 'anat-rh-app';
const target = new URL(ADMIN_URL || 'postgresql://invalid');
if (target.hostname !== '127.0.0.1' || target.port !== '55432' || target.pathname !== '/radar_rehearsal' || !API.startsWith('http://127.0.0.1:') || SECRET.length < 32) {
  throw new Error('rehearsal environment only (127.0.0.1:55432/radar_rehearsal, local API, rehearsal secret)');
}
const SIMS = Number(process.argv[2] ?? 14);
const db = new pg.Client({ connectionString: ADMIN_URL }); await db.connect();
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (sub: string, sid: string) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, sid, typ: 'access', iat: now, exp: now + 3600 })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const id = randomUUID(); const sid = randomUUID();
await db.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [id, `${id}@rehearsal.invalid`]);
await db.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', $2)", [id, randomUUID()]);
await db.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours')", [sid, id]);
await db.end();
const A = sign(id, sid);
const P = '/api/v1/admin/anatomy-rules';
async function call(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}${path}`, { method, signal, headers: { authorization: `Bearer ${A}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 200); }
    return { status: res.status, body: parsed as Record<string, any>, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, body: { error: (e as Error).name }, ms: Date.now() - t0 }; }
}

// Memory sampling of the whole container and of the Node process (PID 1).
type Sample = { t: number; cg: number; rss: number };
const samples: Sample[] = [];
const read = () => {
  const out = execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'cat /sys/fs/cgroup/memory/memory.usage_in_bytes; grep -E "VmRSS|VmHWM" /proc/1/status'], { encoding: 'utf8' });
  const [cg, ...rest] = out.trim().split('\n');
  const kb = (k: string) => Number(rest.find((l) => l.startsWith(k))!.replace(/\D+/g, '')) * 1024;
  return { cg: Number(cg), rss: kb('VmRSS'), hwm: kb('VmHWM') };
};
const MiB = (n: number) => Math.round(n / 1048576);
const t0 = Date.now(); let sampling = true;
const sampler = (async () => { while (sampling) { try { const r = read(); samples.push({ t: Date.now() - t0, cg: r.cg, rss: r.rss }); } catch { samples.push({ t: Date.now() - t0, cg: -1, rss: -1 }); } await new Promise((r) => setTimeout(r, 250)); } })();
const idle = read();

// Near-limit candidates.
const rfbHeaders = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { ncm: { columnHeaders: string[] } }).ncm.columnHeaders;
const profiles = (h: string) => [...(structuredClone([...DEFAULT_PROFILES]) as { scope: { level: string; source?: string } }[])
  .filter((p) => !(p.scope.level === 'source' && p.scope.source === 'RFB')),
  { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' }, fields: { ncm: { columnHeaders: [...rfbHeaders, h] } } }];
const codes = Array.from({ length: 20_000 }, (_, i) => String(84_000_000 + i * 7).padStart(8, '0'));
const LIMIT = 256 * 1024;
function bigTable(n: number): string {
  let rows = ''; let i = 0;
  const head = '<table><tr><td>Classificacao</td><td>Descricao</td></tr>'; const tail = '</table>';
  for (;;) { const c = codes[i % codes.length]!; const r = `<tr><td>${c.slice(0, 4)}.${c.slice(4, 6)}.${c.slice(6)}</td><td>item ${n}-${i}</td></tr>`;
    if (head.length + rows.length + r.length + tail.length > LIMIT - 16) break; rows += r; i += 1; }
  return head + rows + tail;
}
const examples = Array.from({ length: 20 }, (_, n) => ({ id: `big-${n}`, purpose: `tabela sintética grande ${n}`, polarity: 'positive', source: 'RFB',
  input: { html: bigTable(n) }, expect: [{ kind: 'entity', domain: 'NCM', literal: '8400.00.00' }], catalog: { edition: 'syn', codes: n < 4 ? codes : codes.slice(0, 500) } }));
const small = [{ id: 'col', purpose: 'coluna NCM chamada Posicao', polarity: 'positive', source: 'RFB',
  input: { html: '<table><tr><td>Posicao</td></tr><tr><td>8471.30.12</td></tr></table>' },
  expect: [{ kind: 'entity', domain: 'NCM', literal: '8471.30.12' }], catalog: { edition: 'syn', codes: ['84713012'] } }];
async function candidate(h: string, ex: unknown[]) {
  const d = await call('POST', `${P}/drafts`, { profiles: profiles(h), examples: ex });
  if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const f = await call('POST', `${P}/drafts/${d.body.id}/freeze`, { revision: 1 });
  if (f.status >= 300) throw new Error(`freeze ${f.status} ${JSON.stringify(f.body)}`);
  return f.body.candidateId as string;
}
const inputBytes = Buffer.byteLength(JSON.stringify(examples));
const heavy = await candidate('Classificacao', examples);
const light = await candidate('Posicao', small);
const prepared = read();

// Burst: SIMS concurrent heavy simulations + concurrent API reads.
const tally = (xs: { status: number; body: Record<string, any> }[]) => {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const rows = (x.body?.rows ?? []) as { outcome: string; reason?: string }[];
    const key = x.status === 200 ? `200 ${x.body.status} [${[...new Set(rows.map((r) => `${r.outcome}${r.reason ? `:${r.reason}` : ''}`))].sort().join(',')}]` : `${x.status} ${x.body?.error ?? ''}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};
const burstStart = Date.now();
const sims = Array.from({ length: SIMS }, () => call('POST', `${P}/candidates/${heavy}/simulate`));
const reads: { status: number; ms: number }[] = [];
const reader = (async () => { while (Date.now() - burstStart < 8000) {
  const r = await Promise.all([call('GET', `${P}/drafts`), call('GET', '/api/v1/admin/me'), call('GET', '/health')]);
  reads.push(...r.map((x) => ({ status: x.status, ms: x.ms }))); await new Promise((res) => setTimeout(res, 200)); } })();
const burst = await Promise.all(sims); await reader;
const burstMs = Date.now() - burstStart;

// Light burst: the same queue pressure with short simulations, so queued work drains instead of timing out.
const lightBurst = await Promise.all(Array.from({ length: SIMS }, () => call('POST', `${P}/candidates/${light}/simulate`)));

// Cancellation: abort a heavy simulation from the client after 1 s, then check the capacity came back.
const ac = new AbortController(); const aborted = call('POST', `${P}/candidates/${heavy}/simulate`, undefined, ac.signal);
setTimeout(() => ac.abort(), 1000);
const abortedRes = await aborted;
await new Promise((r) => setTimeout(r, 3000));
const after = await Promise.all([call('POST', `${P}/candidates/${light}/simulate`), call('POST', `${P}/candidates/${light}/simulate`)]);
const health = await call('GET', '/health');
sampling = false; await sampler;
const end = read();
const pid1Start = execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'cut -d" " -f22 /proc/1/stat'], { encoding: 'utf8' }).trim();
const peakCg = Number(execFileSync('docker', ['exec', CONTAINER, 'cat', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'], { encoding: 'utf8' }).trim());
const limit = Number(execFileSync('docker', ['exec', CONTAINER, 'cat', '/sys/fs/cgroup/memory/memory.limit_in_bytes'], { encoding: 'utf8' }).trim());
const oomEvents = execFileSync('docker', ['exec', CONTAINER, 'cat', '/sys/fs/cgroup/memory/memory.oom_control'], { encoding: 'utf8' }).trim().replace(/\n/g, ', ');
const readStatus: Record<string, number> = {}; for (const r of reads) readStatus[r.status] = (readStatus[r.status] ?? 0) + 1;
const ms = reads.map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  containerLimitMiB: MiB(limit), heavyCandidate: { examples: 20, perExampleUtf16: examples[0]!.input.html.length, catalogCodes: '20 000 on 4 examples, 500 on 16', jsonBytes: inputBytes },
  memoryMiB: { idleRss: MiB(idle.rss), idleCgroup: MiB(idle.cg), afterPrepareRss: MiB(prepared.rss),
    maxSampledRss: MiB(Math.max(...samples.map((s) => s.rss))), maxSampledCgroup: MiB(Math.max(...samples.map((s) => s.cg))),
    processHwm: MiB(end.hwm), cgroupPeak: MiB(peakCg), endRss: MiB(end.rss), samples: samples.length },
  burst: { simulations: SIMS, wallMs: burstMs, results: tally(burst) }, lightBurst: tally(lightBurst),
  concurrentReads: { byStatus: readStatus, p50ms: ms[Math.floor(ms.length / 2)], p95ms: ms[Math.floor(ms.length * 0.95)], max: ms.at(-1) },
  cancellation: { clientSide: abortedRes.body?.error ?? abortedRes.status, ms: abortedRes.ms },
  capacityAfter: tally(after), health: health.status, memoryEvents: oomEvents, pid1StartTicks: pid1Start,
}));
