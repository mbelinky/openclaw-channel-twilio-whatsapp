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

function accountConfig(overrides = {}) {
  return {
    accountId: 'vinalia',
    fromNumber: 'whatsapp:+14155550000',
    allowFrom: new Set(['+14155551234']),
    inboundDir: '/tmp',
    ...overrides,
  };
}

function webhookConfig(overrides = {}, accountOverrides = {}) {
  return {
    accountSid: 'AC123',
    authToken: 'token',
    webhookUrl: 'https://twilio.example.test',
    accounts: [accountConfig(accountOverrides)],
    ...overrides,
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
    webhookConfig(
      { webhookUrl: 'https://configured.example.com', log: { info: (message) => infos.push(message) } },
      {
        typingIndicators: true,
        sendTypingIndicator: async (messageSid) => {
          typing.push(messageSid);
          return true;
        },
      },
    ),
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
  assert.equal(dispatched[0].accountId, 'vinalia');
  assert.equal(dispatched[0].senderId, '+14155551234');
  assert.equal(dispatched[0].senderName, 'Operator');
  assert.equal(dispatched[0].text, 'Inventory check');
  assert.ok(infos.some((line) => line.includes('event=webhook_received')));
  assert.ok(infos.some((line) => line.includes('event=webhook_processed')));
  assert.ok(infos.some((line) => line.includes('event=typing_done')));
  assert.ok(!infos.some((line) => line.includes('+14155551234')));
});

test('inbound webhook does not mislabel a phone number as a profile name', async () => {
  const params = {
    MessageSid: 'SMinNoProfile',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    Body: 'No profile',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const dispatched = [];
  const handler = createWebhookHandler(webhookConfig(), (message) => {
    dispatched.push(message);
  });
  const res = response();

  await handler(request({ url, params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(dispatched[0].senderName, '');
  assert.equal(dispatched[0].senderId, '+14155551234');
});

test('inbound webhook keeps the request lifecycle open until async dispatch settles', async () => {
  const params = {
    MessageSid: 'SMinAsync',
    From: 'whatsapp:+14155551234',
    To: 'whatsapp:+14155550000',
    Body: 'Inventory check',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  let releaseDispatch;
  const dispatchPending = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  const handler = createWebhookHandler(webhookConfig(), () => dispatchPending);
  const res = response();
  let handlerSettled = false;

  const handling = handler(
    request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }),
    res,
  ).then(() => {
    handlerSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.equal(handlerSettled, false);

  releaseDispatch();
  await handling;
  assert.equal(handlerSettled, true);
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
    webhookConfig({ webhookPaths: ['/webhook/twilio-whatsapp', '/webhook/twilio'] }),
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

test('inbound webhook routes by Twilio To number across configured accounts', async () => {
  const params = {
    MessageSid: 'SMmkps',
    From: 'whatsapp:+447700900123',
    To: 'whatsapp:+447427807929',
    Body: 'classes?',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const dispatched = [];
  const handler = createWebhookHandler(
    webhookConfig({
      accounts: [
        accountConfig({
          accountId: 'vinalia',
          fromNumber: '+14845645168',
          allowFrom: new Set(['+14155551234']),
        }),
        accountConfig({
          accountId: 'mkps',
          fromNumber: 'whatsapp:+447427807929',
          dmPolicy: 'open',
          allowFrom: new Set(['*']),
        }),
      ],
    }),
    (message) => {
      dispatched.push(message);
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(dispatched[0].accountId, 'mkps');
  assert.equal(dispatched[0].senderId, '+447700900123');
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
    webhookConfig({}, {
      sendTypingIndicator: async () => {
        typingCalls += 1;
        return true;
      },
    }),
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
    webhookConfig(),
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
    webhookConfig({ bodyMaxBytes: 16 }),
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
    webhookConfig({}, {
      dmPolicy: 'allowlist',
      allowFrom: new Set(),
    }),
    () => {
      throw new Error('should not dispatch');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');
});

test('inbound webhook requires wildcard allowFrom when dmPolicy is open', async () => {
  const params = {
    MessageSid: 'SMinOpen',
    From: 'whatsapp:+14155559888',
    To: 'whatsapp:+14155550000',
    Body: 'hola',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const closedHandler = createWebhookHandler(
    webhookConfig({}, {
      dmPolicy: 'open',
      allowFrom: new Set(),
    }),
    () => {
      throw new Error('should not dispatch');
    },
  );
  const closedResponse = response();
  await closedHandler(
    request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }),
    closedResponse,
  );
  assert.equal(closedResponse.statusCode, 403);

  const dispatched = [];
  const openHandler = createWebhookHandler(
    webhookConfig({}, {
      dmPolicy: 'open',
      allowFrom: new Set(['*']),
    }),
    (message) => {
      dispatched.push(message);
    },
  );
  const res = response();

  await openHandler(
    request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }),
    res,
  );
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
    accounts: [accountConfig({ statusCallbackUrl: 'https://twilio.example.test/webhook/twilio-whatsapp/status?accountId=vinalia' })],
    log: { error: (message) => errors.push(message) },
  });
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp/status?accountId=vinalia', params, headers: signedHeaders(`${url}?accountId=vinalia`, params) }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  assert.match(errors[0], /status=failed/);
  assert.match(errors[0], /errorCode=63016/);
});

test('status callback rejects oversized bodies before signature validation', async () => {
  const handler = createStatusCallbackHandler({
    authToken: 'token',
    webhookUrl: 'https://twilio.example.test',
    accounts: [accountConfig()],
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
  const warnings = [];
  const handler = createWebhookHandler(
    webhookConfig({ log: { warn: (message) => warnings.push(message) } }),
    () => {
      throw new Error('should not dispatch');
    },
  );
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params) }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');
  assert.match(warnings[0], /unknown To=/);
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
    webhookConfig({
      log: { error: (message) => errors.push(message) },
    }),
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
