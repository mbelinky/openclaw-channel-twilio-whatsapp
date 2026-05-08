import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';

interface TwilioWhatsAppConfig {
  enabled?: boolean;
  fromNumber?: string;
  webhookUrl?: string;
}

export default defineSetupPluginEntry({
  id: 'twilio-whatsapp',
  channel: {
    id: 'twilio-whatsapp',
    inspectAccount: ({ cfg }) => {
      const c = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
      const hasCreds = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
      const enabled = !!c?.enabled;
      const configured = !!(c?.fromNumber && c?.webhookUrl) && hasCreds;
      const hint = !hasCreds
        ? 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'
        : !c?.fromNumber
        ? 'Set channels.twilio-whatsapp.fromNumber'
        : !c?.webhookUrl
        ? 'Set channels.twilio-whatsapp.webhookUrl'
        : undefined;
      return { enabled, configured, hint };
    },
  },
});
