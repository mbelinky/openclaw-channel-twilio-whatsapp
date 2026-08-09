import {
  defineSetupPluginEntry,
  type ChannelPlugin,
} from 'openclaw/plugin-sdk/channel-core';
import {
  credentialConfigurationHint,
  type TwilioCredentialConfig,
} from './credentials.js';
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from './secret-contract.js';

interface TwilioSetupAccountConfig extends TwilioCredentialConfig {
  name?: string;
  enabled?: boolean;
  fromNumber?: string;
  dmPolicy?: 'allowlist' | 'open';
  allowFrom?: string[];
}

interface TwilioWhatsAppConfig {
  enabled?: boolean;
  webhookUrl?: string;
  defaultAccount?: string;
  accounts?: Record<string, TwilioSetupAccountConfig>;
}

interface InspectedTwilioAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  hint?: string;
}

function readSetupConfig(cfg: any): TwilioWhatsAppConfig | undefined {
  const value = cfg?.channels?.['twilio-whatsapp'];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TwilioWhatsAppConfig)
    : undefined;
}

function enabledAccountEntries(cfg: any): Array<[string, TwilioSetupAccountConfig]> {
  const accounts = readSetupConfig(cfg)?.accounts;
  if (!accounts || typeof accounts !== 'object') return [];
  return Object.entries(accounts).filter(([, account]) => account?.enabled !== false);
}

function inspectSetupAccount(cfg: any, requestedAccountId?: string | null): InspectedTwilioAccount {
  const channel = readSetupConfig(cfg);
  const entries = enabledAccountEntries(cfg);
  const accountId = requestedAccountId || channel?.defaultAccount || entries[0]?.[0] || 'default';
  const account = entries.find(([candidateId]) => candidateId === accountId)?.[1];
  const enabled = channel?.enabled === true && Boolean(account);

  let hint: string | undefined;
  if (!channel?.webhookUrl) {
    hint = 'Set channels.twilio-whatsapp.webhookUrl';
  } else if (!account) {
    hint = `Set channels.twilio-whatsapp.accounts.${accountId}.fromNumber`;
  } else if (!account.fromNumber) {
    hint = `Set channels.twilio-whatsapp.accounts.${accountId}.fromNumber`;
  } else {
    hint = credentialConfigurationHint(accountId, account);
    if (!hint) {
      const dmPolicy = account.dmPolicy === 'open' ? 'open' : 'allowlist';
      const allowFrom = account.allowFrom || [];
      if (dmPolicy === 'allowlist' && allowFrom.length === 0) {
        hint = `Set channels.twilio-whatsapp.accounts.${accountId}.allowFrom or change dmPolicy to open`;
      } else if (dmPolicy === 'open' && !allowFrom.includes('*')) {
        hint = `Set channels.twilio-whatsapp.accounts.${accountId}.allowFrom to ["*"]`;
      }
    }
  }

  return {
    accountId,
    name: account?.name || `Twilio WhatsApp (${accountId})`,
    enabled,
    configured: enabled && !hint,
    ...(hint ? { hint } : {}),
  };
}

const twilioWhatsAppSetupPlugin: ChannelPlugin<InspectedTwilioAccount> = {
  id: 'twilio-whatsapp',
  meta: {
    id: 'twilio-whatsapp',
    label: 'Twilio WhatsApp',
    selectionLabel: 'WhatsApp (Twilio Business API)',
    docsPath: '/channels/twilio-whatsapp',
    blurb: 'WhatsApp channel via Twilio Business API.',
  },
  capabilities: {
    chatTypes: ['direct'],
    media: true,
  },
  config: {
    listAccountIds: (cfg: any) => enabledAccountEntries(cfg).map(([accountId]) => accountId),
    defaultAccountId: (cfg: any) => {
      const channel = readSetupConfig(cfg);
      const ids = enabledAccountEntries(cfg).map(([accountId]) => accountId);
      return channel?.defaultAccount && ids.includes(channel.defaultAccount)
        ? channel.defaultAccount
        : ids[0] || 'default';
    },
    resolveAccount: (cfg: any, accountId?: string | null) => inspectSetupAccount(cfg, accountId),
    inspectAccount: (cfg: any, accountId?: string | null) => inspectSetupAccount(cfg, accountId),
    isConfigured: (account: InspectedTwilioAccount) => account.configured,
  },
  status: {
    buildAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      statusState: account.enabled
        ? account.configured
          ? 'configured'
          : 'unconfigured'
        : 'disabled',
      ...(account.hint ? { detail: account.hint } : {}),
    }),
    resolveAccountState: ({ configured }) =>
      configured ? 'configured' : 'not configured',
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
    validateInput: () =>
      'Configure Twilio WhatsApp in openclaw.json. The README includes a complete copy-and-paste example.',
  },
  outbound: {
    deliveryMode: 'gateway',
  },
  secrets: {
    secretTargetRegistryEntries,
    collectRuntimeConfigAssignments,
  },
};

export default defineSetupPluginEntry(twilioWhatsAppSetupPlugin);
