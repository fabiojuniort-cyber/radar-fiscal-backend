import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConnectorRegistry } from '../src/modules/collection/connector-registry.factory.js';

test('L-07: DOE-SP legacy removed, current DOE-SP and RFB remain registered',()=>{
 const registry=buildConnectorRegistry({includeDou:false});
 assert.equal(registry.has('doe-sp-legacy'),false);
 assert.throws(()=>registry.get('doe-sp-legacy'),/Connector not registered/);
 assert.equal(registry.has('doe-sp'),true);
 assert.equal(registry.has('rfb-normas'),true);
});
