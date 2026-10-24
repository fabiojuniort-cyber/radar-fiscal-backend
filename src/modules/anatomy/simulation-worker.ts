import { parentPort } from 'node:worker_threads';
import { ANATOMY_ENGINE_BUILD_HASH } from './build-identity.js';
import { analyzeAnatomy } from './engine.js';
import { parseExample, requestFor, SimulationError } from './rules-simulation.js';

/**
 * ANAT-ADMIN-01 P3-C (issue #116): the ONLY code an isolated simulation worker runs. It is a versioned, trusted module;
 * profiles and examples are DATA (validated here again), never code. One worker analyses exactly one (example, profile
 * set) pair and exits. Its import graph is restricted to the pure anatomy modules (checked by a static test).
 * Protocol: worker → { type: 'ready', engineHash, envKeys, execArgv }; parent → { type: 'analyze', seq, example, profiles };
 * worker → { type: 'result', seq, engineHash, json } | { type: 'error', seq, code }.
 */
const port = parentPort;
if (!port) throw new Error('simulation-worker must run as a worker thread');
port.postMessage({ type: 'ready', engineHash: ANATOMY_ENGINE_BUILD_HASH, envKeys: Object.keys(process.env).length, execArgv: process.execArgv });
port.once('message', (message: unknown) => {
  const m = message as { type?: unknown; seq?: unknown; example?: unknown; profiles?: unknown };
  const seq = typeof m?.seq === 'number' ? m.seq : -1;
  try {
    if (m?.type !== 'analyze' || seq < 0 || !Array.isArray(m.profiles)) throw new Error('invalid_message');
    const example = parseExample(m.example);
    const result = analyzeAnatomy(requestFor(example, m.profiles));
    port.postMessage({ type: 'result', seq, engineHash: ANATOMY_ENGINE_BUILD_HASH, json: JSON.stringify(result) });
  } catch (error) {
    // Sanitised: a code only, never the message (it could echo example text).
    const code = error instanceof SimulationError ? error.code : error instanceof Error && error.message === 'invalid_message' ? 'invalid_message'
      : (error as { name?: string })?.name === 'ProfileValidationError' ? 'invalid_profile' : 'analysis_failed';
    port.postMessage({ type: 'error', seq, code });
  }
});
