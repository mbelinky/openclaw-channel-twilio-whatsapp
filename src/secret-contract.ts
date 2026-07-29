import {
  collectSecretInputAssignment,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';

const CHANNEL_KEY = 'twilio-whatsapp';

export const secretTargetRegistryEntries = [
  {
    id: 'channels.twilio-whatsapp.accounts.*.accountSid',
    targetType: 'channels.twilio-whatsapp.accounts.*.accountSid',
    configFile: 'openclaw.json',
    pathPattern: 'channels.twilio-whatsapp.accounts.*.accountSid',
    secretShape: 'secret_input',
    expectedResolvedValue: 'string',
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: 'channels.twilio-whatsapp.accounts.*.authToken',
    targetType: 'channels.twilio-whatsapp.accounts.*.authToken',
    configFile: 'openclaw.json',
    pathPattern: 'channels.twilio-whatsapp.accounts.*.authToken',
    secretShape: 'secret_input',
    expectedResolvedValue: 'string',
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, CHANNEL_KEY);
  if (!resolved?.surface.hasExplicitAccounts) return;

  for (const { accountId, account, enabled } of resolved.surface.accounts) {
    for (const field of ['accountSid', 'authToken'] as const) {
      if (!hasOwnProperty(account, field)) continue;
      collectSecretInputAssignment({
        value: account[field],
        path: `channels.${CHANNEL_KEY}.accounts.${accountId}.${field}`,
        expected: 'string',
        defaults: params.defaults,
        context: params.context,
        active: resolved.surface.channelEnabled && enabled,
        inactiveReason: 'Twilio WhatsApp channel or account is disabled.',
        apply: (value) => {
          account[field] = value;
        },
      });
    }
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
