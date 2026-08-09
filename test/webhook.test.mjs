import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    accountId: 'sales',
    accountSid: 'AC-sales',
    authToken: 'token',
    webhookUrl: 'https://twilio.example.test',
    fromNumber: 'whatsapp:+14155550100',
    allowFrom: new Set(['+14155550123']),
    inboundDir: '/tmp',
    ...overrides,
  };
}

function webhookConfig(overrides = {}, accountOverrides = {}) {
  return {
    accounts: [accountConfig(accountOverrides)],
    ...overrides,
  };
}

test('inbound webhook accepts forwarded public URL signatures and dispatches after empty TwiML ack', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
      { log: { info: (message) => infos.push(message) } },
      {
        webhookUrl: 'https://configured.example.com',
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
  assert.equal(dispatched[0].accountId, 'sales');
  assert.equal(dispatched[0].senderId, '+14155550123');
  assert.equal(dispatched[0].senderName, 'Operator');
  assert.equal(dispatched[0].text, 'Inventory check');
  assert.ok(infos.some((line) => line.includes('event=webhook_received')));
  assert.ok(infos.some((line) => line.includes('event=webhook_processed')));
  assert.ok(infos.some((line) => line.includes('event=typing_done')));
  assert.ok(!infos.some((line) => line.includes('+14155550123')));
});

test('inbound webhook does not mislabel a phone number as a profile name', async () => {
  const params = {
    MessageSid: 'SMinNoProfile',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
  assert.equal(dispatched[0].senderId, '+14155550123');
});

test('inbound webhook keeps the request lifecycle open until async dispatch settles', async () => {
  const params = {
    MessageSid: 'SMinAsync',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
    MessageSid: 'SMsupport',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550101',
    Body: 'classes?',
    NumMedia: '0',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const dispatched = [];
  const handler = createWebhookHandler(
    webhookConfig({
      accounts: [
        accountConfig({
          accountId: 'sales',
          fromNumber: '+14155550100',
          allowFrom: new Set(['+14155550123']),
        }),
        accountConfig({
          accountId: 'support',
          accountSid: 'AC-support',
          authToken: 'support-token',
          fromNumber: 'whatsapp:+14155550101',
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

  await handler(
    request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params, 'support-token') }),
    res,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(dispatched[0].accountId, 'support');
  assert.equal(dispatched[0].senderId, '+14155550123');
});

test('inbound signature is validated only with the recipient account token', async () => {
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const accounts = [
    accountConfig({
      accountId: 'account-a',
      accountSid: 'AC-a',
      authToken: 'token-a',
      fromNumber: 'whatsapp:+14155550101',
    }),
    accountConfig({
      accountId: 'account-b',
      accountSid: 'AC-b',
      authToken: 'token-b',
      fromNumber: 'whatsapp:+14155550102',
    }),
  ];
  const handler = createWebhookHandler(webhookConfig({ accounts }), () => {});
  const baseParams = {
    MessageSid: 'SMaccount',
    From: 'whatsapp:+14155550123',
    Body: 'hello',
    NumMedia: '0',
  };

  const accountAResponse = response();
  const accountAParams = { ...baseParams, To: accounts[0].fromNumber };
  await handler(
    request({ url: '/webhook/twilio-whatsapp', params: accountAParams, headers: signedHeaders(url, accountAParams, 'token-a') }),
    accountAResponse,
  );
  assert.equal(accountAResponse.statusCode, 200);

  const wrongAccountResponse = response();
  const accountBParams = { ...baseParams, To: accounts[1].fromNumber };
  await handler(
    request({ url: '/webhook/twilio-whatsapp', params: accountBParams, headers: signedHeaders(url, accountBParams, 'token-a') }),
    wrongAccountResponse,
  );
  assert.equal(wrongAccountResponse.statusCode, 403);
  assert.equal(wrongAccountResponse.body, 'Invalid signature');

  const accountBResponse = response();
  await handler(
    request({ url: '/webhook/twilio-whatsapp', params: accountBParams, headers: signedHeaders(url, accountBParams, 'token-b') }),
    accountBResponse,
  );
  assert.equal(accountBResponse.statusCode, 200);
});

test('one shared inbound handler reflects account starts and stops dynamically', async () => {
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const accountA = accountConfig({
    accountId: 'account-a',
    authToken: 'token-a',
    fromNumber: 'whatsapp:+14155550101',
  });
  const accountB = accountConfig({
    accountId: 'account-b',
    authToken: 'token-b',
    fromNumber: 'whatsapp:+14155550102',
  });
  let activeAccounts = [accountA];
  const handler = createWebhookHandler(
    webhookConfig({ accounts: () => activeAccounts }),
    () => {},
  );
  const requestFor = async (account, token) => {
    const params = {
      MessageSid: `SM-${account.accountId}`,
      From: 'whatsapp:+14155550123',
      To: account.fromNumber,
      Body: 'hello',
      NumMedia: '0',
    };
    const res = response();
    await handler(
      request({
        url: '/webhook/twilio-whatsapp',
        params,
        headers: signedHeaders(url, params, token),
      }),
      res,
    );
    return res;
  };

  assert.equal((await requestFor(accountA, 'token-a')).statusCode, 200);
  activeAccounts = [accountA, accountB];
  assert.equal((await requestFor(accountB, 'token-b')).statusCode, 200);
  activeAccounts = [accountB];
  assert.equal((await requestFor(accountA, 'token-a')).statusCode, 403);
  assert.equal((await requestFor(accountB, 'token-b')).statusCode, 200);
});

test('inbound media uses the recipient account credentials', async (t) => {
  const inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilio-media-account-'));
  t.after(() => fs.rmSync(inboundDir, { recursive: true, force: true }));
  const downloads = [];
  const params = {
    MessageSid: 'SMmedia',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550102',
    Body: 'voice',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.test/media/1',
    MediaContentType0: 'audio/ogg',
  };
  const url = 'https://twilio.example.test/webhook/twilio-whatsapp';
  const handler = createWebhookHandler(
    webhookConfig({
      accounts: [
        accountConfig({
          accountId: 'account-b',
          accountSid: 'AC-b',
          authToken: 'token-b',
          fromNumber: params.To,
          inboundDir,
        }),
      ],
      downloadMedia: async (mediaUrl, accountSid, authToken) => {
        downloads.push({ mediaUrl, accountSid, authToken });
        return Buffer.from('voice');
      },
    }),
    () => {},
  );
  const res = response();

  await handler(
    request({ url: '/webhook/twilio-whatsapp', params, headers: signedHeaders(url, params, 'token-b') }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(downloads, [
    {
      mediaUrl: 'https://api.twilio.test/media/1',
      accountSid: 'AC-b',
      authToken: 'token-b',
    },
  ]);
});

test('inbound webhook does not send typing indicators unless explicitly enabled', async () => {
  const params = {
    MessageSid: 'SMin',
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
    From: 'whatsapp:+14155550125',
    To: 'whatsapp:+14155550100',
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
    From: 'whatsapp:+14155550125',
    To: 'whatsapp:+14155550100',
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
    From: 'whatsapp:+14155550125',
    To: 'whatsapp:+14155550100',
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
  assert.equal(dispatched[0].senderId, '+14155550125');
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
    accounts: [accountConfig({ statusCallbackUrl: 'https://twilio.example.test/webhook/twilio-whatsapp/status?accountId=sales' })],
    log: { error: (message) => errors.push(message) },
  });
  const res = response();

  await handler(request({ url: '/webhook/twilio-whatsapp/status?accountId=sales', params, headers: signedHeaders(`${url}?accountId=sales`, params) }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  assert.match(errors[0], /status=failed/);
  assert.match(errors[0], /errorCode=63016/);
});

test('status callback marker selects only the matching account token', async () => {
  const params = {
    MessageSid: 'SMstatus-b',
    MessageStatus: 'delivered',
    From: 'whatsapp:+14155550102',
  };
  const callbackUrl =
    'https://twilio.example.test/webhook/twilio-whatsapp/status?accountId=account-b';
  const accounts = [
    accountConfig({
      accountId: 'account-a',
      authToken: 'token-a',
      fromNumber: 'whatsapp:+14155550101',
      statusCallbackUrl:
        'https://twilio.example.test/webhook/twilio-whatsapp/status?accountId=account-a',
    }),
    accountConfig({
      accountId: 'account-b',
      authToken: 'token-b',
      fromNumber: 'whatsapp:+14155550102',
      statusCallbackUrl: callbackUrl,
    }),
  ];
  const handler = createStatusCallbackHandler({ accounts });

  const accepted = response();
  await handler(
    request({
      url: '/webhook/twilio-whatsapp/status?accountId=account-b',
      params,
      headers: signedHeaders(callbackUrl, params, 'token-b'),
    }),
    accepted,
  );
  assert.equal(accepted.statusCode, 200);

  const rejected = response();
  await handler(
    request({
      url: '/webhook/twilio-whatsapp/status?accountId=account-b',
      params,
      headers: signedHeaders(callbackUrl, params, 'token-a'),
    }),
    rejected,
  );
  assert.equal(rejected.statusCode, 403);
});

test('status callback falls back to the Twilio sender when the account marker is absent', async () => {
  const params = {
    MessageSid: 'SMstatus-fallback',
    MessageStatus: 'sent',
    From: 'whatsapp:+14155550102',
  };
  const callbackUrl = 'https://twilio.example.test/webhook/twilio-whatsapp/status';
  const handler = createStatusCallbackHandler({
    accounts: [
      accountConfig({
        accountId: 'account-b',
        authToken: 'token-b',
        fromNumber: params.From,
        statusCallbackUrl: callbackUrl,
      }),
    ],
  });
  const res = response();

  await handler(
    request({
      url: '/webhook/twilio-whatsapp/status',
      params,
      headers: signedHeaders(callbackUrl, params, 'token-b'),
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
});

test('status callback rejects oversized bodies before signature validation', async () => {
  const handler = createStatusCallbackHandler({
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
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550199',
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
    From: 'whatsapp:+14155550123',
    To: 'whatsapp:+14155550100',
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
