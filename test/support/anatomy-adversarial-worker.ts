import { parentPort } from 'node:worker_threads';
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { parseExample, requestFor } from '../../src/modules/anatomy/rules-simulation.js';

/**
 * TEST ONLY (ANAT-ADMIN-01 P3-C): a misbehaving worker speaking the executor protocol, selected through the executor's
 * test seam. The behaviour is chosen by the synthetic example id prefix. Never reachable from the API.
 */
const port = parentPort!;
const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* CPU-bound, ignores messages */ } };
port.once('message', (m: { seq: number; example: { id: string }; profiles: unknown[] }) => {
  const id = m.example.id; const [kind, arg] = id.split('-');
  const real = () => JSON.stringify(analyzeAnatomy(requestFor(parseExample(m.example), m.profiles)));
  const send = (json: string, engineHash = ANATOMY_ENGINE_BUILD_HASH, seq = m.seq) => port.postMessage({ type: 'result', seq, engineHash, json });
  switch (kind) {
    case 'slow': busy(Number(arg)); send(real()); break;
    case 'late': port.postMessage({ type: 'result', seq: m.seq + 1000, engineHash: ANATOMY_ENGINE_BUILD_HASH, json: '{}' }); send(real()); break;
    case 'huge': send(JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) })); break;
    case 'tampered': { const r = JSON.parse(real()); r.parts[0].label = 'forged'; send(JSON.stringify(r)); break; }
    case 'engine': send(real(), 'f'.repeat(64)); break;
    case 'oom': { const keep: unknown[] = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }
    case 'crash': process.exit(3);
    case 'throw': throw new Error('boom');
    default: send(real());
  }
});
port.postMessage({ type: 'ready', engineHash: ANATOMY_ENGINE_BUILD_HASH, envKeys: Object.keys(process.env).length, execArgv: process.execArgv });
