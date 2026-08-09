import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from 'openclaw/plugin-sdk/secret-ref-runtime';
import { resolveTwilioWhatsAppAccount, twilioWhatsAppPlugin } from '../dist/channel.js';
import setupEntry from '../dist/setup-entry.js';

test('publishes the runtime secret contract sidecar expected by OpenClaw', async () => {
  const contract = await import('../dist/secret-contract-api.js');

  assert.equal(typeof contract.collectRuntimeConfigAssignments, 'function');
  assert.ok(Array.isArray(contract.secretTargetRegistryEntries));
  assert.equal(contract.secretTargetRegistryEntries.length, 2);
});

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
    setupEntry.plugin.config.inspectAccount(
      {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              sales: {
                dmPolicy: 'allowlist',
                fromNumber: '+14155550100',
              },
            },
          },
        },
      },
      'sales',
    ),
  );

  assert.equal(status.configured, false);
  assert.match(status.hint, /allowFrom/);
});

test('setup status requires a wildcard allowFrom when dmPolicy is open', () => {
  const missingWildcard = withTwilioEnv(() =>
    setupEntry.plugin.config.inspectAccount(
      {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              support: {
                dmPolicy: 'open',
                fromNumber: '+14155550101',
              },
            },
          },
        },
      },
      'support',
    ),
  );
  assert.equal(missingWildcard.configured, false);
  assert.match(missingWildcard.hint, /allowFrom.*\["\*"\]/);

  const status = withTwilioEnv(() =>
    setupEntry.plugin.config.inspectAccount(
      {
        channels: {
          'twilio-whatsapp': {
            enabled: true,
            webhookUrl: 'https://twilio.example.test',
            accounts: {
              support: {
                dmPolicy: 'open',
                allowFrom: ['*'],
                fromNumber: '+14155550101',
              },
            },
          },
        },
      },
      'support',
    ),
  );

  assert.equal(status.configured, true);
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
              allowFrom: ['+14155550123'],
              fromNumber: '+14155550100',
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
          sales: {
            accountSid: 'AC-sales',
            authToken: 'token-sales',
            dmPolicy: 'allowlist',
            allowFrom: ['+14155550123'],
            fromNumber: '+14155550100',
          },
          support: {
            accountSid: 'AC-support',
            authToken: 'token-support',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550101',
          },
        },
      },
    },
  };

  await withoutTwilioEnv(() =>
    twilioWhatsAppPlugin.outbound.sendText({
      cfg,
      accountId: 'support',
      to: '+14155550123',
      text: 'hola',
      deps: {
        createTwilioClient: (accountSid, authToken) => ({
          messages: {
            create: async (payload) => {
              clients.push({ accountSid, authToken });
              calls.push(payload);
              return { sid: 'SMsupport' };
            },
          },
        }),
      },
    }),
  );

  assert.deepEqual(clients, [{ accountSid: 'AC-support', authToken: 'token-support' }]);
  assert.equal(calls[0].from, 'whatsapp:+14155550101');
  assert.equal(calls[0].to, 'whatsapp:+14155550123');
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
            fromNumber: '+14155550101',
          },
          b: {
            accountSid: 'AC-b',
            authToken: 'token-b',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550102',
          },
        },
      },
    },
  };

  await withoutTwilioEnv(() =>
    twilioWhatsAppPlugin.outbound.sendMedia({
      cfg,
      accountId: 'b',
      to: '+14155550123',
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
          support: {
            accountSid: 'AC-partial',
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550102',
          },
        },
      },
    },
  };

  assert.throws(
    () => withTwilioEnv(() => resolveTwilioWhatsAppAccount(cfg, 'support')),
    (error) => {
      assert.match(error.message, /Account "support".*set both.*accountSid.*authToken/);
      assert.doesNotMatch(error.message, /AC-partial/);
      return true;
    },
  );
  const status = withTwilioEnv(() =>
    setupEntry.plugin.config.inspectAccount(cfg, 'support'),
  );
  assert.equal(status.configured, false);
  assert.match(status.hint, /Account "support"/);
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
                fromNumber: '+14155550103',
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
    setupEntry.plugin.config.inspectAccount(
      {
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
                fromNumber: '+14155550101',
              },
              disabled: {
                enabled: false,
                accountSid: 'AC-incomplete',
              },
            },
          },
        },
      },
      'active',
    ),
  );

  assert.equal(status.configured, true);
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
              support: {
                authToken: { source: 'env', provider: 'default', id: 'TWILIO_SUPPORT_AUTH_TOKEN' },
                dmPolicy: 'open',
                allowFrom: ['*'],
                fromNumber: '+14155550102',
              },
            },
          },
        },
      },
      'support',
    ),
  );

  assert.equal(inspected.configured, false);
  assert.match(inspected.hint, /Account "support".*accountSid.*authToken/);
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
          support: {
            accountSid: {
              source: 'env',
              provider: 'default',
              id: 'TWILIO_SUPPORT_ACCOUNT_SID',
            },
            authToken: {
              source: 'env',
              provider: 'default',
              id: 'TWILIO_SUPPORT_AUTH_TOKEN',
            },
            dmPolicy: 'open',
            allowFrom: ['*'],
            fromNumber: '+14155550102',
          },
        },
      },
    },
  };
  const resolvedConfig = structuredClone(sourceConfig);
  const context = createResolverContext({
    sourceConfig,
    env: {
      TWILIO_SUPPORT_ACCOUNT_SID: 'AC-resolved-support',
      TWILIO_SUPPORT_AUTH_TOKEN: 'resolved-support-token',
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
    resolveTwilioWhatsAppAccount(resolvedConfig, 'support'),
  );
  assert.equal(account.credentialSource, 'account');
  assert.equal(account.accountSid, 'AC-resolved-support');
  assert.equal(account.authToken, 'resolved-support-token');
  assert.deepEqual(context.warnings, []);
});
