import { parentPort } from 'node:worker_threads';
// TEST ONLY (ANAT-ADMIN-01 P3-C): announces an engine other than the parent's.
parentPort!.postMessage({ type: 'ready', engineHash: 'f'.repeat(64), envKeys: 0, execArgv: [] });
