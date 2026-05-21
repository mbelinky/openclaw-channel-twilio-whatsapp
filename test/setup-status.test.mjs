import assert from 'node:assert/strict';
import test from 'node:test';
import { twilioWhatsAppPlugin } from '../dist/channel.js';

function withTwilioEnv(fn) {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_ACCOUNT_SID = 'AC123';
  process.env.TWILIO_AUTH_TOKEN = 'token';
  try {
    return fn();
  } finally {
    if (oldSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = oldSid;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = oldToken;
  }
}

test('setup status requires allowFrom when dmPolicy is allowlist', () => {
  const status = withTwilioEnv(() =>
    twilioWhatsAppPlugin.setup.resolveChannelSetupStatus({
      cfg: {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            dmPolicy: 'allowlist',
            fromNumber: '+14155550000',
            webhookUrl: 'https://twilio.example.test',
          },
        },
      },
    }),
  );

  assert.equal(status.status, 'not-configured');
  assert.match(status.hint, /allowFrom/);
});

test('setup status allows empty allowFrom only when dmPolicy is open', () => {
  const status = withTwilioEnv(() =>
    twilioWhatsAppPlugin.setup.resolveChannelSetupStatus({
      cfg: {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            dmPolicy: 'open',
            fromNumber: '+14155550000',
            webhookUrl: 'https://twilio.example.test',
          },
        },
      },
    }),
  );

  assert.equal(status.status, 'configured');
});
