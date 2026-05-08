import os from 'os';
import path from 'path';
import twilio from 'twilio';
import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
} from 'openclaw/plugin-sdk/channel-message';
import { toWhatsAppId } from './util.js';
import { stageMedia } from './media.js';

interface TwilioWhatsAppConfig {
  enabled: boolean;
  fromNumber: string;
  webhookUrl: string;
}

function readChannelCfg(cfg: any): TwilioWhatsAppConfig {
  const c = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
  if (!c) throw new Error('Twilio WhatsApp channel not configured');
  return c;
}

function readCreds(): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not set (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
  }
  return { accountSid, authToken };
}

function outboundDir(): string {
  return path.join(os.homedir(), '.openclaw', 'media', 'twilio-whatsapp', 'outbound');
}

export const twilioWhatsAppMessageAdapter = defineChannelMessageAdapter({
  id: 'twilio-whatsapp',
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: false,
      thread: false,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, signal }) => {
      signal?.throwIfAborted?.();
      const c = readChannelCfg(cfg);
      const { accountSid, authToken } = readCreds();
      const client = twilio(accountSid, authToken);
      const result = await client.messages.create({
        from: toWhatsAppId(c.fromNumber),
        to: toWhatsAppId(to),
        body: text || '',
      });
      return createMessageReceiptFromOutboundResults([{ messageId: result.sid, raw: result }]);
    },
    media: async ({ cfg, to, text, mediaUrl, signal }) => {
      signal?.throwIfAborted?.();
      const c = readChannelCfg(cfg);
      const { accountSid, authToken } = readCreds();
      const client = twilio(accountSid, authToken);
      const stagedUrl = mediaUrl ? stageMedia(mediaUrl, outboundDir(), c.webhookUrl) : null;
      const result = await client.messages.create({
        from: toWhatsAppId(c.fromNumber),
        to: toWhatsAppId(to),
        body: text || '',
        ...(stagedUrl ? { mediaUrl: [stagedUrl] } : {}),
      });
      return createMessageReceiptFromOutboundResults([{ messageId: result.sid, raw: result }]);
    },
  },
});
