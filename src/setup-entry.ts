import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';

interface TwilioWhatsAppConfig {
  enabled?: boolean;
  webhookUrl?: string;
  accounts?: Record<string, { fromNumber?: string; dmPolicy?: 'allowlist' | 'open'; allowFrom?: string[] }>;
}

export default defineSetupPluginEntry({
  id: 'twilio-whatsapp',
  channel: {
    id: 'twilio-whatsapp',
    inspectAccount: ({ cfg }) => {
      const c = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
      const hasCreds = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
      const enabled = !!c?.enabled;
      const accounts = c?.accounts && typeof c.accounts === 'object' ? Object.entries(c.accounts) : [];
      const firstIncomplete = accounts.find(([, account]) => !account?.fromNumber);
      const firstAllowlistMissing = accounts.find(
        ([, account]) => (account?.dmPolicy ?? 'allowlist') === 'allowlist' && !(account?.allowFrom || []).length,
      );
      const configured = !!(c?.webhookUrl && accounts.length > 0 && !firstIncomplete && !firstAllowlistMissing) && hasCreds;
      const hint = !hasCreds
        ? 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'
        : !c?.webhookUrl
        ? 'Set channels.twilio-whatsapp.webhookUrl'
        : accounts.length === 0
        ? 'Set channels.twilio-whatsapp.accounts.<accountId>.fromNumber'
        : firstIncomplete
        ? `Set channels.twilio-whatsapp.accounts.${firstIncomplete[0]}.fromNumber`
        : firstAllowlistMissing
        ? `Set channels.twilio-whatsapp.accounts.${firstAllowlistMissing[0]}.allowFrom or change dmPolicy to open`
        : undefined;
      return { enabled, configured, hint };
    },
  },
});
