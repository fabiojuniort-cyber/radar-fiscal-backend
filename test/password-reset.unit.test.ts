import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { passwordResetQueueWarningCodes } from '../src/modules/auth/password-reset.worker.js';

import {
  passwordResetLink,
  encryptResetToken,
  decryptResetToken,
  encryptResetRecipient,
  decryptResetRecipient,
  passwordResetRecipientDigest,
  passwordResetKeyFingerprint,
  sendZohoPasswordResetMail,
} from '../src/modules/auth/password-reset.service.js';

test('AUTH-RESET: link is HTTPS and token stays in fragment, not URL query', () => {
  const link = passwordResetLink('https://trifaros.com.br/nova-senha', 'abcdef');
  const url = new URL(link);
  assert.equal(url.origin, 'https://trifaros.com.br');
  assert.equal(url.pathname, '/nova-senha');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#token=abcdef');
  assert.throws(
    () => passwordResetLink('http://trifaros.com.br/nova-senha', 'abcdef'),
    /invalid_password_reset_public_url/,
  );
});

test('AUTH-RESET: Zoho CPaaS request is fully simulated with no outbound network', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      message: 'OK',
      data: [{ code: 'EM_104', message: 'OK' }],
      request_id: 'simulated-request',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const link = 'https://trifaros.com.br/nova-senha#token=synthetic-only';
  await sendZohoPasswordResetMail(
    { to: 'recipient@example.test', link },
    {
      apiKey: 'fake-unit-test-key-never-used-outside-mock',
      fromAddress: 'sender@trifaros.com.br',
      fetchImpl: fakeFetch,
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://cpaas.zoho.com/v1.1/email');
  assert.equal(calls[0]?.init.method, 'POST');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Zoho-enczapikey fake-unit-test-key-never-used-outside-mock');
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    from: { address: string };
    to: Array<{ email_address: { address: string } }>;
    htmlbody: string;
    textbody: string;
    track_clicks: boolean;
    track_opens: boolean;
  };
  assert.equal(body.from.address, 'sender@trifaros.com.br');
  assert.equal(body.to[0]?.email_address.address, 'recipient@example.test');
  assert.match(body.htmlbody, /#token=synthetic-only/);
  assert.match(body.textbody, /30 minutos/);
  assert.equal(body.track_clicks, false);
  assert.equal(body.track_opens, false);
});

test('AUTH-RESET: Zoho rejection and malformed success cannot be accepted', async () => {
  const message = {
    to: 'recipient@example.test',
    link: 'https://trifaros.com.br/nova-senha#token=synthetic-only',
  };
  const options = {
    apiKey: 'fake-key',
    fromAddress: 'sender@trifaros.com.br',
  };
  const rejectedFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'error' }), { status: 403 });
  await assert.rejects(
    sendZohoPasswordResetMail(message, { ...options, fetchImpl: rejectedFetch }),
    /zoho_password_reset_delivery_failed/,
  );
  const unconfirmedFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'OK', data: [] }), { status: 200 });
  await assert.rejects(
    sendZohoPasswordResetMail(message, { ...options, fetchImpl: unconfirmedFetch }),
    /zoho_password_reset_delivery_unconfirmed/,
  );
});

test('AUTH-RESET-02: AES-GCM never stores token in plaintext and rejects corruption', () => {
  const token='A'.repeat(43);
  const digest=createHash('sha256').update(token).digest('hex');
  const key='1'.repeat(64);
  const encrypted=encryptResetToken(token,digest,key);
  assert.ok(!encrypted.ciphertext.includes(token));
  assert.equal(decryptResetToken(encrypted,digest,key),token);
  assert.throws(()=>decryptResetToken({
    ...encrypted,authTag:Buffer.from('0'.repeat(16)).toString('base64'),
  },digest,key));
  assert.throws(()=>decryptResetToken(encrypted,digest,'2'.repeat(64)));
});

test('E-2: email HTML escapes untrusted URL and disables tracking', async()=>{
  let body='';
  const fakeFetch:typeof fetch=async (_input,init)=>{
    body=String(init?.body);
    return new Response(JSON.stringify({
      message:'OK',data:[{code:'EM_104',message:'OK'}],
    }),{status:200});
  };
  const malicious='https://trifaros.com.br/nova-senha?x=" onmouseover="evil&y=<tag>#token=synthetic';
  await sendZohoPasswordResetMail({to:'recipient@example.test',link:malicious},{
    apiKey:'MOCK_ONLY',fromAddress:'sender@trifaros.com.br',fetchImpl:fakeFetch,
  });
  const sent=JSON.parse(body) as {
    htmlbody:string;track_clicks:boolean;track_opens:boolean;
  };
  assert.ok(sent.htmlbody.includes('&quot;'));
  assert.ok(sent.htmlbody.includes('&amp;'));
  assert.ok(sent.htmlbody.includes('&lt;tag&gt;'));
  assert.ok(!sent.htmlbody.includes('onmouseover="evil'));
  assert.equal(sent.track_clicks,false);
  assert.equal(sent.track_opens,false);
});

test('AUTH-RESET-03: encrypted recipient stays opaque and authenticated by request',()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const key='e'.repeat(64);
  const email='alice@example.test';
  const encrypted=encryptResetRecipient(email,id,key);
  assert.ok(!encrypted.ciphertext.includes('alice'));
  assert.equal(decryptResetRecipient(encrypted,id,key),email);
  assert.notEqual(passwordResetRecipientDigest(email,key),email);
  assert.notEqual(passwordResetKeyFingerprint(key),passwordResetKeyFingerprint('f'.repeat(64)));
  assert.throws(()=>decryptResetRecipient(encrypted,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',key));
  assert.throws(()=>decryptResetRecipient(encrypted,id,'f'.repeat(64)));
});

test('R4 CRY: legacy R3 token ciphertext decrypts with strict 16-byte tag', () => {
  const key='9'.repeat(64),root=Buffer.from(key,'hex');
  const token='z'.repeat(43),digest=createHash('sha256').update(token).digest('hex');
  // Intentionally use the exact R3 algorithm with no authTagLength option.
  const nonce=Buffer.alloc(12,0x42);
  const oldCipher=createCipheriv('aes-256-gcm',root,nonce);
  oldCipher.setAAD(Buffer.from(digest,'ascii'));
  const cipher=Buffer.concat([oldCipher.update(token,'utf8'),oldCipher.final()]);
  const legacy={ciphertext:cipher.toString('base64'),
    nonce:nonce.toString('base64'),authTag:oldCipher.getAuthTag().toString('base64')};
  assert.equal(decryptResetToken(legacy,digest,key),token);
  assert.equal(Buffer.from(legacy.authTag,'base64').length,16);

  // And a new ciphertext remains readable by the legacy R3 decoder.
  const fresh=encryptResetToken(token,digest,key);
  const oldDec=createDecipheriv('aes-256-gcm',root,Buffer.from(fresh.nonce,'base64'));
  oldDec.setAAD(Buffer.from(digest,'ascii'));
  oldDec.setAuthTag(Buffer.from(fresh.authTag,'base64'));
  assert.equal(Buffer.concat([
    oldDec.update(Buffer.from(fresh.ciphertext,'base64')),
    oldDec.final(),
  ]).toString('utf8'),token);
  assert.throws(()=>decryptResetToken({...legacy,
    authTag:Buffer.from(legacy.authTag,'base64').subarray(0,15).toString('base64'),
  },digest,key),/password_reset_invalid_gcm_tag/);
});

test('R4 CRY: legacy R3 recipient HMAC/ciphertext remain byte-compatible',()=>{
  const key='7'.repeat(64),root=Buffer.from(key,'hex');
  const id='9ddac18b-46b8-4cb1-a24f-7c1d7adb50f8';
  const email='legacy.recipient@example.test';
  const hmac=createHmac('sha256',root)
    .update('tri-auth-reset-email:v1:'+email).digest('hex');
  assert.equal(passwordResetRecipientDigest(email,key),hmac);
  const nonce=Buffer.alloc(12,0x31);
  const oldCipher=createCipheriv('aes-256-gcm',root,nonce);
  oldCipher.setAAD(Buffer.from('tri-auth-reset-request:v1:'+id,'utf8'));
  const raw=Buffer.concat([oldCipher.update(email,'utf8'),oldCipher.final()]);
  const old={ciphertext:raw.toString('base64'),
    nonce:nonce.toString('base64'),authTag:oldCipher.getAuthTag().toString('base64')};
  assert.equal(decryptResetRecipient(old,id,key),email);
  const fresh=encryptResetRecipient(email,id,key);
  assert.equal(Buffer.from(fresh.authTag,'base64').length,16);

  // HKDF subkeys are distinct and would CHANGE the current HMAC identity.
  // Do not switch derivation without explicit format/version and key rollout.
  const proposed=Buffer.from(hkdfSync('sha256',root,
    Buffer.alloc(0),'trifaros/reset-hmac/v2',32));
  assert.notDeepEqual(proposed,root);
  const candidate=createHmac('sha256',proposed)
    .update('tri-auth-reset-email:v1:'+email).digest('hex');
  assert.notEqual(candidate,hmac);
});

test('R4 W4: stage-specific local warnings never contain PII',()=>{
  const health={
    neutral:{pending:3,claimed:1,failed:1,oldestPendingSeconds:600},
    delivery:{pending:0,claimed:0,failed:0,oldestPendingSeconds:0},
  };
  const codes=passwordResetQueueWarningCodes(health,2,0);
  assert.deepEqual(codes,['NEUTRAL_FAILED','NEUTRAL_PENDING_AGED','NEUTRAL_CLAIM_PERSISTENT']);
  const delivery=passwordResetQueueWarningCodes({
    neutral:{pending:0,claimed:0,failed:0,oldestPendingSeconds:0},
    delivery:{pending:2,claimed:1,failed:1,oldestPendingSeconds:150},
  },0,2);
  assert.deepEqual(delivery,[
    'DELIVERY_FAILED','DELIVERY_PENDING_AGED','DELIVERY_CLAIM_PERSISTENT',
  ]);
  assert.equal(passwordResetQueueWarningCodes({
    neutral:{pending:0,claimed:0,failed:0,oldestPendingSeconds:0},
    delivery:{pending:0,claimed:0,failed:0,oldestPendingSeconds:0},
  },0,0).length,0);
});
