import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import test from 'node:test';
import { actorViolations } from '../ops/onb02/audit-actor-inventory.mjs';

const registry=JSON.parse(await readFile('docs/audit-actors-r73.json','utf8'));
async function files(dir='.') {
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    if(['node_modules','dist','.git','coverage','test'].includes(entry.name))continue;
    const path=(dir==='.'?'':dir+'/')+entry.name;
    if(entry.isDirectory())result.push(...await files(path));
    else if(/\.(?:[cm]?js|ts|json|md|ya?ml|sh|sql)$/.test(path)&&!path.endsWith('package-lock.json'))result.push(path);
  }
  return result.sort();
}
test('R7.3 every operational script, job, package command and document uses registered actors',async()=>{
  const failures=[];let scanned=0,historical=0;
  assert.equal(new Set(registry.systemActors).size,registry.systemActors.length);
  for(const actor of registry.systemActors)assert.match(actor,/^system:[a-z0-9][a-z0-9.-]*$/);
  const policy=await readFile('migrations/074_audit_allowlist_and_backfill.sql','utf8');
  const clause=policy.match(/WHEN p_value IN \(([\s\S]*?)\)\s+THEN p_value/)[1];
  const sqlActors=[...clause.matchAll(/'([^']+)'/g)].map(value=>value[1]).sort();
  assert.deepEqual(sqlActors,[...registry.systemActors].sort(),'registry and actual DB guard must agree exactly');
  for(const path of await files()) {
    if(path==='docs/audit-actors-r73.json')continue; // inventory contains previous labels, not executable instructions.
    const text=await readFile(path,'utf8');
    if(registry.historicalMigrationBlobs[path]) {
      const blob=createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
      assert.equal(blob,registry.historicalMigrationBlobs[path],'historical migration changed: '+path);
      historical++;continue;
    }
    scanned++;failures.push(...actorViolations(path,text,registry));
  }
  for(const writer of registry.writers) {
    assert.ok(writer.sources.length>0||['system:worker','system:scheduler'].includes(writer.id));
    for(const path of writer.sources)assert.ok((await readFile(path,'utf8')).includes("'"+writer.id+"'"),
      'registered writer no longer uses its canonical identity: '+path);
  }
  assert.deepEqual(failures,[],'unknown actor declarations; diagnostics intentionally omit actor contents');
  console.log('ONB02_R73_ACTOR_INVENTORY '+JSON.stringify({
    scanned,historical_immutable:historical,system_actors:registry.systemActors.length,unknown:failures.length}));
});
test('R7.3 inventory guard catches a newly added CLI/doc/SQL writer and the exact pre-fix TAX-10 command actor',()=>{
  const cases=[
    ["src/fallback.ts","const x={actor:options.actor ?? 'unregistered-command'}"],
    ["src/binding.ts","const commandActor='unregistered-command'; const x={actor:commandActor}"],
    ["src/infrastructure/database/new-cli.ts","const x={actor:'unregistered-command'}"],
    ["src/infrastructure/database/new-f2.ts","const x={userId:'ops:unregistered'}"],
    ["ops/taxonomy/new.md","node publish.js --actor=unregistered-command"],
    [".github/workflows/new.yml","ACTOR_ID: 'unregistered-command'"],
    ["scripts/new.sh","AUDIT_ACTOR_ID=unregistered-command"],
    ["docs/new.md","Autor: `system:unregistered`"],
    ["src/infrastructure/database/new.ts","query(\"INSERT INTO audit_log(actor_type,actor_id,action,entity_type) VALUES('SYSTEM','unregistered-command','COMPANY_UPDATED','company')\")"],
    ["src/infrastructure/database/baseline.ts","const query=[\"INSERT INTO audit_log(actor_type,actor_id,action,entity_type) VALUES(\",\"'SYSTEM',\",\"'unregistered-command',\",\"'COMPANY_UPDATED','company')\"].join('\\n')"],
    ["src/infrastructure/database/taxonomy-v1-1-publish.ts","const x={actor:'taxonomy-v1.1-publish-command'}"],
  ];
  for(const [path,text] of cases)assert.ok(actorViolations(path,text,registry).length>0,
    'inventory failed to catch the negative scenario in '+path);
  assert.equal(actorViolations('docs/valid.md','node publish --actor=<UUID>',registry).length,0);
  assert.equal(actorViolations('src/new.ts',"const x={actor:'system:taxonomy-v1.1-publisher'}",registry).length,0);
});
