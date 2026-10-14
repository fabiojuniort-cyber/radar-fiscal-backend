import fs from 'node:fs';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync(new URL('./ccfaa15.baseline-engine.ts.txt', import.meta.url));
const module = stripTypeScriptTypes(source.toString('utf8'), { mode: 'strip' });
fs.writeFileSync(new URL('./ccfaa15.baseline-engine.mjs', import.meta.url), module);
fs.writeFileSync(new URL('./ccfaa15.baseline-provenance.json', import.meta.url), JSON.stringify({
  repository: 'fabiojuniort-cyber/radar-fiscal-backend', revision: 'ccfaa15cffd322bb364c99f44eb04f759b781d1e',
  tree: 'efef43653685de26636f2bd6e3d568d3b24bbe82',
  path: 'src/modules/collection/collection-filter.engine.ts',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  moduleSha256: crypto.createHash('sha256').update(module).digest('hex'),
  transpiler: 'node:module.stripTypeScriptTypes ' + process.version,
  compilerOptions: {mode:'strip'},
  note: 'Frozen original source extracted before F3 edits. No business logic edits.',
}, null, 2) + '\n');
