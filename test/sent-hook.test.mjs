import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from 'openclaw/plugin-sdk/hook-runtime';
import { emitTwilioWhatsAppMessageSentHook } from '../dist/sent-hook.js';

afterEach(() => {
  resetGlobalHookRunner();
});

function captureMessageSentHook() {
  const calls = [];
  initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [
      {
        pluginId: 'sent-hook-test',
        hookName: 'message_sent',
        handler: (event, context) => {
          calls.push({ event, context });
        },
        source: 'test',
      },
    ],
    plugins: [{ id: 'sent-hook-test', status: 'loaded' }],
  });
  return calls;
}

async function flushHooks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('sent hook emits the routed session and canonical outbound payload', async () => {
  const calls = captureMessageSentHook();

  emitTwilioWhatsAppMessageSentHook({
    to: '+447700900123',
    content: 'Hello from OpenClaw',
    success: true,
    accountId: 'mkps',
    messageId: 'SMreply',
    sessionKey: 'agent:mkps:twilio-whatsapp:mkps:direct:+447700900123',
  });
  await flushHooks();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].event, {
    to: '+447700900123',
    content: 'Hello from OpenClaw',
    success: true,
    messageId: 'SMreply',
    sessionKey: 'agent:mkps:twilio-whatsapp:mkps:direct:+447700900123',
  });
  assert.deepEqual(calls[0].context, {
    channelId: 'twilio-whatsapp',
    accountId: 'mkps',
    conversationId: '+447700900123',
    sessionKey: 'agent:mkps:twilio-whatsapp:mkps:direct:+447700900123',
    messageId: 'SMreply',
  });
});

test('sent hook emits failed delivery details without a message id', async () => {
  const calls = captureMessageSentHook();

  emitTwilioWhatsAppMessageSentHook({
    to: '+447700900123',
    content: 'Formatted reply',
    success: false,
    error: 'Error: Twilio rejected the send',
    accountId: 'mkps',
    sessionKey: 'agent:mkps:twilio-whatsapp:mkps:direct:+447700900123',
  });
  await flushHooks();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event.success, false);
  assert.equal(calls[0].event.error, 'Error: Twilio rejected the send');
  assert.equal(calls[0].event.content, 'Formatted reply');
  assert.equal(calls[0].event.messageId, undefined);
  assert.equal(
    calls[0].context.sessionKey,
    'agent:mkps:twilio-whatsapp:mkps:direct:+447700900123',
  );
});

test('sent hook is a no-op when no message_sent hook is registered', async () => {
  initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [],
    plugins: [],
  });

  assert.doesNotThrow(() => {
    emitTwilioWhatsAppMessageSentHook({
      to: '+447700900123',
      content: 'Hello',
      success: true,
      accountId: 'mkps',
    });
  });
  await flushHooks();
});
