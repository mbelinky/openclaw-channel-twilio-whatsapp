import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from 'openclaw/plugin-sdk/secret-ref-runtime';
import { resolveTwilioWhatsAppAccount, twilioWhatsAppPlugin } from '../dist/channel.js';
import setupEntry from '../dist/setup-entry.js';

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

function withoutTwilioEnv(fn) {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  try {
    return fn();
  } finally {
    if (oldSid !== undefined) process.env.TWILIO_ACCOUNT_SID = oldSid;
    if (oldToken !== undefined) process.env.TWILIO_AUTH_TOKEN = oldToken;
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

test('setup status requires a wildcard allowFrom when dmPolicy is open', () => {
  const missingWildcard = withTwilioEnv(() =>
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
  assert.equal(missingWildcard.status, 'not-configured');
  assert.match(missingWildcard.hint, /allowFrom.*\["\*"\]/);

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
                allowFrom: ['*'],
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

test('outbound text selects the requested account credentials and sender', async () => {
  const calls = [];
  const clients = [];
  const cfg = {
    channels: {
      'twilio-whatsapp': {
        enabled: true,
        webhookUrl: 'https://twilio.example.test',
        accounts: {
          vinalia: {
            accountSid: 'AC-vinalia',
            authToken: 'token-vinalia',
            dmPolicy: 'allowlist',
            allowFrom: ['+14155551234'],
            fromNumber: '+14845645168',
          },
          mkps: {
            accountSid: 'AC-mkps',
            authToken: 'token-mkps',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+447427807929',
          },
        },
      },
    },
  };

  await withoutTwilioEnv(() =>
    twilioWhatsAppPlugin.outbound.sendText({
      cfg,
      accountId: 'mkps',
      to: '+447700900123',
      text: 'hola',
      deps: {
        createTwilioClient: (accountSid, authToken) => ({
          messages: {
            create: async (payload) => {
              clients.push({ accountSid, authToken });
              calls.push(payload);
              return { sid: 'SMmkps' };
            },
          },
        }),
      },
    }),
  );

  assert.deepEqual(clients, [{ accountSid: 'AC-mkps', authToken: 'token-mkps' }]);
  assert.equal(calls[0].from, 'whatsapp:+447427807929');
  assert.equal(calls[0].to, 'whatsapp:+447700900123');
});

test('outbound media selects the requested account credentials', async () => {
  const clients = [];
  const cfg = {
    channels: {
      'twilio-whatsapp': {
        enabled: true,
        webhookUrl: 'https://twilio.example.test',
        accounts: {
          a: {
            accountSid: 'AC-a',
            authToken: 'token-a',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550001',
          },
          b: {
            accountSid: 'AC-b',
            authToken: 'token-b',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550002',
          },
        },
      },
    },
  };

  await withoutTwilioEnv(() =>
    twilioWhatsAppPlugin.outbound.sendMedia({
      cfg,
      accountId: 'b',
      to: '+14155551234',
      text: 'attachment',
      mediaUrl: 'https://media.example.test/file.pdf',
      deps: {
        createTwilioClient: (accountSid, authToken) => ({
          messages: {
            create: async () => {
              clients.push({ accountSid, authToken });
              return { sid: 'SMmedia-b' };
            },
          },
        }),
      },
    }),
  );

  assert.deepEqual(clients, [
    { accountSid: 'AC-b', authToken: 'token-b' },
    { accountSid: 'AC-b', authToken: 'token-b' },
  ]);
});

test('partial account-scoped credentials fail closed without exposing values', () => {
  const cfg = {
    channels: {
      'twilio-whatsapp': {
        enabled: true,
        webhookUrl: 'https://twilio.example.test',
        accounts: {
          mkps: {
            accountSid: 'AC-partial',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550002',
          },
        },
      },
    },
  };

  assert.throws(
    () => withTwilioEnv(() => resolveTwilioWhatsAppAccount(cfg, 'mkps')),
    (error) => {
      assert.match(error.message, /Account "mkps".*set both.*accountSid.*authToken/);
      assert.doesNotMatch(error.message, /AC-partial/);
      return true;
    },
  );
  const status = withTwilioEnv(() =>
    twilioWhatsAppPlugin.setup.resolveChannelSetupStatus({ cfg }),
  );
  assert.equal(status.status, 'not-configured');
  assert.match(status.hint, /Account "mkps"/);
});

test('global-only credentials remain the compatibility fallback', () => {
  const account = withTwilioEnv(() =>
    resolveTwilioWhatsAppAccount(
      {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              legacy: {
                dmPolicy: 'open',
                allowFrom: ['*'],
                fromNumber: '+14155550003',
              },
            },
          },
        },
      },
      'legacy',
    ),
  );

  assert.equal(account.credentialSource, 'global');
  assert.equal(account.accountSid, 'AC123');
  assert.equal(account.authToken, 'token');
});

test('disabled accounts do not make the channel setup status incomplete', () => {
  const status = withoutTwilioEnv(() =>
    twilioWhatsAppPlugin.setup.resolveChannelSetupStatus({
      cfg: {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              active: {
                accountSid: 'AC-active',
                authToken: 'token-active',
                dmPolicy: 'open',
                allowFrom: ['*'],
                fromNumber: '+14155550001',
              },
              disabled: {
                enabled: false,
                accountSid: 'AC-incomplete',
              },
            },
          },
        },
      },
    }),
  );

  assert.equal(status.status, 'configured');
});

test('setup entry reports the incomplete account and exposes SecretRef targets', () => {
  const inspected = withTwilioEnv(() =>
    setupEntry.plugin.config.inspectAccount(
      {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              mkps: {
                authToken: { source: 'env', provider: 'default', id: 'TWILIO_MKPS_AUTH_TOKEN' },
                dmPolicy: 'open',
                allowFrom: ['*'],
                fromNumber: '+14155550002',
              },
            },
          },
        },
      },
      'mkps',
    ),
  );

  assert.equal(inspected.configured, false);
  assert.match(inspected.hint, /Account "mkps".*accountSid.*authToken/);
  assert.deepEqual(
    setupEntry.plugin.secrets.secretTargetRegistryEntries.map((entry) => entry.id),
    [
      'channels.twilio-whatsapp.accounts.*.accountSid',
      'channels.twilio-whatsapp.accounts.*.authToken',
    ],
  );
});

test('account env SecretRefs hydrate before account resolution', async () => {
  const sourceConfig = {
    channels: {
      'twilio-whatsapp': {
        enabled: true,
        webhookUrl: 'https://twilio.example.test',
        accounts: {
          mkps: {
            accountSid: {
              source: 'env',
              provider: 'default',
              id: 'TWILIO_MKPS_ACCOUNT_SID',
            },
            authToken: {
              source: 'env',
              provider: 'default',
              id: 'TWILIO_MKPS_AUTH_TOKEN',
            },
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550002',
          },
        },
      },
    },
  };
  const resolvedConfig = structuredClone(sourceConfig);
  const context = createResolverContext({
    sourceConfig,
    env: {
      TWILIO_MKPS_ACCOUNT_SID: 'AC-resolved-mkps',
      TWILIO_MKPS_AUTH_TOKEN: 'resolved-mkps-token',
    },
  });

  setupEntry.plugin.secrets.collectRuntimeConfigAssignments({
    config: resolvedConfig,
    defaults: undefined,
    context,
  });
  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });

  const account = withoutTwilioEnv(() =>
    resolveTwilioWhatsAppAccount(resolvedConfig, 'mkps'),
  );
  assert.equal(account.credentialSource, 'account');
  assert.equal(account.accountSid, 'AC-resolved-mkps');
  assert.equal(account.authToken, 'resolved-mkps-token');
  assert.deepEqual(context.warnings, []);
});
