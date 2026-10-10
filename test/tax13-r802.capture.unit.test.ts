import assert from 'node:assert/strict';
import test from 'node:test';
import {
 assertPublicIpv4,validateOfficialConfazUrl,validateOfficialRedirect,
 assertCaptureSize,assertCaptureResponseHeaders,CONFAZ_CAPTURE_MAX_BYTES,
 captureOfficialConfazHttps
} from '../src/modules/taxonomy/legal-scope/confaz-official-capture.js';

const approved='https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91';

test('R802: only canonical, official HTTPS CONFAZ legal URLs',()=>{
 assert.equal(validateOfficialConfazUrl(approved).href,approved);
 for(const bad of [
  'http://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91',
  'https://evil.example/legislacao/convenios/1991/CV052_91',
  'https://www.confaz.fazenda.gov.br.evil.example/legislacao/x',
  'https://www.confaz.fazenda.gov.br@127.0.0.1/legislacao/x',
  'https://user@www.confaz.fazenda.gov.br/legislacao/x',
  'https://www.confaz.fazenda.gov.br:444/legislacao/x',
  'https://www.confaz.fazenda.gov.br:443/legislacao/x',
  'https://www.confaz.fazenda.gov.br/admin',
  'https://www.confaz.fazenda.gov.br/legislacao/x#fragment',
  ' https://www.confaz.fazenda.gov.br/legislacao/x',
  'https://www.confaz.fazenda.gov.br/legislacao/x\nX:malicious',
  'https://www.confaz.fazenda.gov.br\\@evil.example/legislacao/x',
  'https://www.confaz.fazenda.gov.br/legislacao/'+'a'.repeat(3000),
 ])assert.throws(()=>validateOfficialConfazUrl(bad),/TAX13_R802_/,'denied '+JSON.stringify(bad));
});

test('R802: redirect target must stay HTTPS same allowed host and scope',()=>{
 const next='https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91?x=1';
 assert.equal(validateOfficialRedirect('?x=1',approved),next);
 for(const bad of ['http://www.confaz.fazenda.gov.br/legislacao/x',
  'https://127.0.0.1/legislacao/x','https://evil.example/legislacao/x',
  '//www.confaz.fazenda.gov.br.evil.example/legislacao/x',
  '/control-panel', 'https://www.confaz.fazenda.gov.br:8443/legislacao/x',
  '\nhttp://localhost/']) {
  assert.throws(()=>validateOfficialRedirect(bad,approved),/TAX13_R802_/);
 }
});

test('R802: non-public DNS answers never become pinned remote endpoints',()=>{
 for(const ip of ['10.1.1.1','127.0.0.1','192.168.0.1','172.16.1.2',
   '169.254.169.254','100.64.0.1','192.0.2.1','198.51.100.1',
   '203.0.113.3','198.18.0.1','224.0.0.1','0.0.0.0','255.255.255.255',
   '::1','[::1]','localhost']) {
  assert.throws(()=>assertPublicIpv4(ip),/TAX13_R802_/);
 }
 for(const ip of ['1.1.1.1','8.8.8.8','190.2.1.1'])assert.doesNotThrow(()=>assertPublicIpv4(ip));
});

test('R802: size, encoding, HTTP errors, charset checks enforce fail-closed',()=>{
 assertCaptureSize(CONFAZ_CAPTURE_MAX_BYTES);
 for(const bad of [CONFAZ_CAPTURE_MAX_BYTES+1,Number.NaN,-1,Number.POSITIVE_INFINITY]){
  assert.throws(()=>assertCaptureSize(bad),/SIZE_LIMIT/);
 }
 assertCaptureResponseHeaders(200,'text/html; charset=utf-8',undefined,110);
 assertCaptureResponseHeaders(302,'','identity',0);
 for(const args of [
   [200,'text/html','gzip',100],
   [200,'application/json',undefined,100],
   [200,'text/html; charset=iso-8859-1',undefined,100],
   [500,'text/html',undefined,100],
   [200,'text/html',undefined,CONFAZ_CAPTURE_MAX_BYTES+1],
 ] as const)assert.throws(()=>assertCaptureResponseHeaders(...args),/TAX13_R802_/);
});

test('R802: malicious inputs rejected before any live network operation',async()=>{
 await assert.rejects(captureOfficialConfazHttps('https://127.0.0.1/','collector-valid-01'),/TAX13_R802_/);
 await assert.rejects(captureOfficialConfazHttps(approved,'x'),/COLLECTOR_ID_REQUIRED/);
});
