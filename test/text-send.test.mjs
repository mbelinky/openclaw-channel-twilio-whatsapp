import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTwilioTypingIndicatorBody } from '../dist/feedback.js';
import { normalizeTwilioReplyPayload } from '../dist/channel.js';
import { stageMedia } from '../dist/media.js';
import { scheduleProcessingAck } from '../dist/processing-ack.js';
import { normalizeWhatsAppText, splitWhatsAppText } from '../dist/text.js';
import { sendTwilioWhatsAppMessages } from '../dist/send.js';

test('normalizes markdown and unicode punctuation for WhatsApp', () => {
  assert.equal(
    normalizeWhatsAppText(' **Hola**\n\n\n- Uno — `dos`…\n```sh\nnpm test\n```\n~~fin~~ '),
    '*Hola*\nUno -- dos...\nnpm test\n\n~fin~',
  );
});

test('splits long WhatsApp text by blocks and hard line limits', () => {
  assert.deepEqual(splitWhatsAppText(`a\n\n${'b'.repeat(20)}\n\nc`, 10), [
    'a',
    'bbbbbbbbbb',
    'bbbbbbbbbb',
    'c',
  ]);
});

test('splits with default limit when an invalid chunk limit is provided', () => {
  assert.deepEqual(splitWhatsAppText('hello', -1), ['hello']);
  assert.deepEqual(splitWhatsAppText('hello', Number.NaN), ['hello']);
});

test('send helper chunks text, attaches status callback, and sends media separately', async () => {
  const calls = [];
  const receipt = await sendTwilioWhatsAppMessages({
    accountSid: 'AC123',
    authToken: 'token',
    fromNumber: '+10000000000',
    toNumber: '+14155556789',
    text: `a\n\n${'b'.repeat(12)}`,
    mediaUrls: ['https://example.test/file.xlsx'],
    statusCallbackUrl: 'https://example.test/status',
    chunkLimit: 10,
    maxRetries: 1,
    createClient: () => ({
      messages: {
        create: async (payload) => {
          calls.push(payload);
          return { sid: `SM${calls.length}` };
        },
      },
    }),
  });

  assert.deepEqual(receipt.messageIds, ['SM1', 'SM2', 'SM3', 'SM4']);
  assert.equal(calls[0].from, 'whatsapp:+10000000000');
  assert.equal(calls[0].to, 'whatsapp:+14155556789');
  assert.equal(calls[0].statusCallback, 'https://example.test/status');
  assert.equal(calls[0].mediaUrl, undefined);
  assert.equal(calls[1].mediaUrl, undefined);
  assert.deepEqual(calls[3].mediaUrl, ['https://example.test/file.xlsx']);
  assert.equal(calls[3].body, '');
  assert.ok(calls.every((call) => call.body.length <= 10));
});

test('normal inbound replies preserve their PDF attachment for the shared sender', () => {
  assert.deepEqual(
    normalizeTwilioReplyPayload({
      text: 'PDF del albarán A261377.',
      mediaUrl: '/tmp/albaran-A261377.pdf',
      mediaUrls: ['/tmp/albaran-A261377.pdf'],
    }),
    {
      text: 'PDF del albarán A261377.',
      mediaUrls: ['/tmp/albaran-A261377.pdf'],
    },
  );
});

test('normal inbound replies keep media-only payloads instead of dropping them', () => {
  assert.deepEqual(
    normalizeTwilioReplyPayload({
      mediaUrls: ['/tmp/albaran-A261377.pdf'],
    }),
    {
      text: '',
      mediaUrls: ['/tmp/albaran-A261377.pdf'],
    },
  );
});

test('send helper falls back to the default chunk limit for invalid limits', async () => {
  const calls = [];
  const receipt = await sendTwilioWhatsAppMessages({
    accountSid: 'AC123',
    authToken: 'token',
    fromNumber: '+10000000000',
    toNumber: '+14155556789',
    text: 'hola',
    chunkLimit: -1,
    maxRetries: 1,
    createClient: () => ({
      messages: {
        create: async (payload) => {
          calls.push(payload);
          return { sid: 'SMok' };
        },
      },
    }),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(receipt.messageIds, ['SMok']);
});

test('send helper does not retry ambiguous transport errors', async () => {
  let attempts = 0;
  await assert.rejects(
    sendTwilioWhatsAppMessages({
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: '+10000000000',
      toNumber: '+14155556789',
      text: 'hola',
      maxRetries: 2,
      sleep: async () => {},
      createClient: () => ({
        messages: {
          create: async () => {
            attempts += 1;
            throw new Error('temporary network failure');
          },
        },
      }),
    }),
    /temporary network failure/,
  );

  assert.equal(attempts, 1);
});

test('send helper retries Twilio 429 and 5xx responses', async () => {
  let attempts = 0;
  const receipt = await sendTwilioWhatsAppMessages({
    accountSid: 'AC123',
    authToken: 'token',
    fromNumber: '+10000000000',
    toNumber: '+14155556789',
    text: 'hola',
    maxRetries: 2,
    sleep: async () => {},
    createClient: () => ({
      messages: {
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('Too Many Requests');
            error.status = 429;
            throw error;
          }
          return { sid: 'SMok' };
        },
      },
    }),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(receipt.messageIds, ['SMok']);
});

test('send helper fails fast when Twilio returns a terminal message status', async () => {
  await assert.rejects(
    sendTwilioWhatsAppMessages({
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: '+10000000000',
      toNumber: '+14155556789',
      text: 'hola',
      maxRetries: 2,
      sleep: async () => {},
      createClient: () => ({
        messages: {
          create: async () => ({ sid: 'SMbad', status: 'undelivered', errorCode: 63016 }),
        },
      }),
    }),
    /SMbad undelivered/,
  );
});

test('send helper trims and preserves WhatsApp-prefixed addresses', async () => {
  const calls = [];
  await sendTwilioWhatsAppMessages({
    accountSid: 'AC123',
    authToken: 'token',
    fromNumber: ' whatsapp:+10000000000 ',
    toNumber: ' +14155556789 ',
    text: 'hola',
    maxRetries: 1,
    createClient: () => ({
      messages: {
        create: async (payload) => {
          calls.push(payload);
          return { sid: 'SMtrim' };
        },
      },
    }),
  });

  assert.equal(calls[0].from, 'whatsapp:+10000000000');
  assert.equal(calls[0].to, 'whatsapp:+14155556789');
});

test('send helper does not blindly retry after an unknown timeout outcome', async () => {
  let attempts = 0;
  await assert.rejects(
    sendTwilioWhatsAppMessages({
      accountSid: 'AC123',
      authToken: 'token',
      fromNumber: '+10000000000',
      toNumber: '+14155556789',
      text: 'hola',
      timeoutMs: 1,
      maxRetries: 3,
      sleep: async () => {},
      createClient: () => ({
        messages: {
          create: async () => {
            attempts += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { sid: 'SMlate' };
          },
        },
      }),
    }),
    /timed out/,
  );

  assert.equal(attempts, 1);
});

test('media staging normalizes trailing slash webhook URLs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilio-wa-media-'));
  const filePath = path.join(dir, 'invoice.pdf');
  fs.writeFileSync(filePath, 'pdf');

  const staged = stageMedia(filePath, dir, 'https://example.test/');

  assert.equal(staged, 'https://example.test/webhook/twilio-whatsapp/media/invoice.pdf');
});

test('typing indicator body includes Twilio required WhatsApp channel', () => {
  assert.equal(buildTwilioTypingIndicatorBody('SM123'), 'messageId=SM123&channel=whatsapp');
});

test('processing ack sends only when the run remains active past the delay', async () => {
  const sent = [];
  const ack = scheduleProcessingAck({
    text: 'Working',
    delayMs: 0,
    send: async (text) => {
      sent.push(text);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  ack?.complete();

  assert.deepEqual(sent, ['Working']);

  const cancelled = [];
  const cancelledAck = scheduleProcessingAck({
    text: 'Too late',
    delayMs: 20,
    send: async (text) => {
      cancelled.push(text);
    },
  });
  cancelledAck?.complete();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(cancelled, []);
});
