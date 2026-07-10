import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTwilioWhatsAppAccount, twilioWhatsAppPlugin } from '../dist/channel.js';

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
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              vinalia: {
                dmPolicy: 'allowlist',
                fromNumber: '+14155550000',
              },
            },
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
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              mkps: {
                dmPolicy: 'open',
                fromNumber: '+447427807929',
              },
            },
          },
        },
      },
    }),
  );

  assert.equal(status.status, 'configured');
});

test('runtime config parsing rejects legacy top-level sender shape with migration error', () => {
  assert.throws(
    () =>
      withTwilioEnv(() =>
        resolveTwilioWhatsAppAccount({
          channels: {
            'twilio-whatsapp': {
              enabled: true,
              dmPolicy: 'allowlist',
              allowFrom: ['+14155551234'],
              fromNumber: '+14155550000',
              webhookUrl: 'https://twilio.example.test',
            },
          },
        }),
      ),
    /v3\.0\.0 requires account-scoped senders.*accounts\.<accountId>/,
  );
});

test('outbound adapter selects the fromNumber for the requested accountId', async () => {
  const calls = [];
  const cfg = {
    channels: {
      'twilio-whatsapp': {
        enabled: true,
        webhookUrl: 'https://twilio.example.test',
        accounts: {
          vinalia: {
            dmPolicy: 'allowlist',
            allowFrom: ['+14155551234'],
            fromNumber: '+14845645168',
          },
          mkps: {
            dmPolicy: 'open',
            fromNumber: '+447427807929',
          },
        },
      },
    },
  };

  await withTwilioEnv(() =>
    twilioWhatsAppPlugin.outbound.sendText({
      cfg,
      accountId: 'mkps',
      to: '+447700900123',
      text: 'hola',
      deps: {
        createTwilioClient: () => ({
          messages: {
            create: async (payload) => {
              calls.push(payload);
              return { sid: 'SMmkps' };
            },
          },
        }),
      },
    }),
  );

  assert.equal(calls[0].from, 'whatsapp:+447427807929');
  assert.equal(calls[0].to, 'whatsapp:+447700900123');
});
