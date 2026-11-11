import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  passwordResetLink,
  encryptResetToken,
  decryptResetToken,
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
