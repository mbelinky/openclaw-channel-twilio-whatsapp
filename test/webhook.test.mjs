import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import twilio from 'twilio';
import { createStatusCallbackHandler, createWebhookHandler } from '../dist/webhook.js';

function formBody(params) {
  return new URLSearchParams(params).toString();
}

function signedHeaders(url, params, token = 'token') {
  return {
    'x-twilio-signature': twilio.getExpectedTwilioSignature(token, url, params),
  };
}

function request({ url, params, headers = {} }) {
  const req = Readable.from([Buffer.from(formBody(params))]);
  req.url = url;
  req.headers = headers;
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body += body;
    },
  };
}

test('inbound webhook accepts forwarded public URL signatures and dispatches after empty TwiML ack', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    ProfileName: 'Operator',
    Body: 'Inventory check',
    NumMedia: '0',
  };
  const publicUrl = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const dispatched = [];
  const typing = [];
  const infos = [];
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://configured.example.com',
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
      typingIndicators: true,
      sendTypingIndicator: async (messageSid) => {
        typing.push(messageSid);
        return true;
      },
      log: { info: (message) => infos.push(message) },
    },
    (message) => {
      dispatched.push(message);
    },
  );
  const req = request({
    url: '/webhook/twilio-whatsapp',
    params,
    headers: {
      ...signedHeaders(publicUrl, params),
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'twilio.example.test',
    },
  });
  const res = response();

  await handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.equal(typing[0], 'SMin');
  assert.equal(dispatched[0].senderId, '+14155551234');
  assert.equal(dispatched[0].text, 'Inventory check');
  assert.ok(infos.some((line) => line.includes('event=webhook_received')));
  assert.ok(infos.some((line) => line.includes('event=webhook_processed')));
  assert.ok(infos.some((line) => line.includes('event=typing_done')));
  assert.ok(!infos.some((line) => line.includes('+14155551234')));
});

test('inbound webhook accepts configured alternate public paths', async () => {
  const params = {
    MessageSid: 'SMinAlias',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    Body: 'legacy path',
    NumMedia: '0',
  };
  const publicUrl = 'https://twilio.example.test/webhook/twilio';
  const dispatched = [];
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      webhookPaths: ['/webhook/twilio-whatsapp', '/webhook/twilio'],
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
    },
    (message) => {
      dispatched.push(message);
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio', params, headers: signedHeaders(publicUrl, params) }), res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.equal(dispatched[0].text, 'legacy path');
});

test('inbound webhook does not send typing indicators unless explicitly enabled', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  let typingCalls = 0;
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
      sendTypingIndicator: async () => {
        typingCalls += 1;
        return true;
      },
    },
    () => {},
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(typingCalls, 0);
});

test('inbound webhook rejects non-allowlisted senders', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155559888',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
    },
    () => {
      throw new Error('should not dispatch');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');
});

test('inbound webhook rejects oversized bodies before signature validation', async () => {
  const params = {
    Body: 'x'.repeat(128),
  };
  let dispatched = false;
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      bodyMaxBytes: 16,
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
    },
    () => {
      dispatched = true;
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: {} }), res);

  assert.equal(res.statusCode, 413);
  assert.equal(res.body, 'Request Entity Too Large');
  assert.equal(dispatched, false);
});

test('inbound webhook keeps allowlist policy closed when allowFrom is empty', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155559888',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      dmPolicy: 'allowlist',
      allowFrom: new Set(),
      groupAllowFrom: new Set(['+14155559888']),
      inboundDir: '/tmp',
    },
    () => {
      throw new Error('should not dispatch');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');
});

test('inbound webhook allows empty allowFrom only when dmPolicy is open', async () => {
  const params = {
    MessageSid: 'SMinOpen',
    From: 'whatsapp:+14155559888',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const dispatched = [];
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      dmPolicy: 'open',
      allowFrom: new Set(),
      inboundDir: '/tmp',
    },
    (message) => {
      dispatched.push(message);
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(dispatched[0].senderId, '+14155559888');
});

test('status callback validates signature and logs failed delivery', async () => {
  const params = {
    MessageSid: 'SMstatus',
    MessageStatus: 'failed',
    ErrorCode: '63016',
    ErrorMessage: 'Outside allowed window',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp/status';
  const errors = [];
  const handler = createStatusCallbackHandler({
    authToken: 'token',
    webhookUrl: 'https://twilio.example.test',
    log: { error: (message) => errors.push(message) },
  });
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp/status', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  assert.match(errors[0], /status=failed/);
  assert.match(errors[0], /errorCode=63016/);
});

test('status callback rejects oversized bodies before signature validation', async () => {
  const handler = createStatusCallbackHandler({
    authToken: 'token',
    webhookUrl: 'https://twilio.example.test',
    bodyMaxBytes: 16,
  });
  const res = response();

  await handler(
    request({
      url: '/webhook/twilio-whatsapp/status',
      params: { ErrorMessage: 'x'.repeat(128) },
      headers: {},
    }),
    res,
  );

  assert.equal(res.statusCode, 413);
  assert.equal(res.body, 'Request Entity Too Large');
});

test('inbound webhook rejects messages addressed to a different WhatsApp sender', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550999',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
    },
    () => {
      throw new Error('should not dispatch');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');
});

test('inbound webhook keeps the Twilio ack when synchronous dispatch fails', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const errors = [];
  const handler = createWebhookHandler(
    {
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: 'whatsapp:+14155550000',
      webhookUrl: 'https://twilio.example.test',
      allowFrom: new Set(['+14155551234']),
      inboundDir: '/tmp',
      log: { error: (message) => errors.push(message) },
    },
    () => {
      throw new Error('dispatch down');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.match(errors[0], /dispatch failed/);
  assert.match(errors[0], /dispatch down/);
});
