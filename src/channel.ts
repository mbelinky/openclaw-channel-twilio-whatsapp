import fs from 'fs';
import os from 'os';
import path from 'path';
import twilio from 'twilio';
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { createRestrictSendersChannelSecurity } from 'openclaw/plugin-sdk/channel-policy';
import { createAttachedChannelResultAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import { chunkText } from 'openclaw/plugin-sdk/reply-chunking';
import { registerPluginHttpRoute } from 'openclaw/plugin-sdk/webhook-ingress';
import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound';
import { shouldComputeCommandAuthorized } from 'openclaw/plugin-sdk/command-auth';
import { getTwilioWhatsAppRuntime } from './runtime.js';
import { toWhatsAppId, fromWhatsAppId } from './util.js';
import { stageMedia, createMediaServeHandler } from './media.js';
import { createWebhookHandler, createHealthHandler, type InboundMessage } from './webhook.js';

const TWILIO_MAX_MESSAGE_LEN = 1600;

interface TwilioWhatsAppConfig {
  enabled: boolean;
  dmPolicy: 'allowlist' | 'open';
  allowFrom?: string[];
  fromNumber: string;
  webhookUrl: string;
}

interface ResolvedTwilioAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  config: TwilioWhatsAppConfig;
  accountSid: string;
  authToken: string;
}

function resolveAccount(cfg: any, accountId?: string): ResolvedTwilioAccount | null {
  const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
  if (!channelCfg?.enabled) return null;

  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  if (!accountSid || !authToken) return null;

  return {
    accountId: accountId || 'default',
    name: 'Twilio WhatsApp',
    enabled: channelCfg.enabled,
    config: channelCfg,
    accountSid,
    authToken,
  };
}

const twilioWhatsAppSecurity = createRestrictSendersChannelSecurity<ResolvedTwilioAccount>({
  channelKey: 'twilio-whatsapp',
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  surface: 'Twilio WhatsApp',
  openScope: 'anyone with the bot number',
  policyPathSuffix: 'dmPolicy',
  mentionGated: false,
  approveHint: 'Add the phone number to channels.twilio-whatsapp.allowFrom',
  normalizeDmEntry: (raw) => raw.replace(/^whatsapp:/i, '').replace(/^\+?/, '+'),
});

export const twilioWhatsAppPlugin = createChatChannelPlugin<ResolvedTwilioAccount>({
  base: {
    id: 'twilio-whatsapp',
    config: {
      listAccountIds: () => ['default'],
      resolveAccount: (cfg: any, accountId?: string) => resolveAccount(cfg, accountId),
      defaultAccountId: () => 'default',
      setAccountEnabled: ({ cfg }: { cfg: any; accountId: string; enabled: boolean }) => cfg,
      deleteAccount: ({ cfg }: { cfg: any; accountId: string }) => cfg,
    },
    resolveAccount: ({ cfg, accountId }) => resolveAccount(cfg, accountId),
    security: twilioWhatsAppSecurity,
    messaging: {
      normalizeTarget: (target) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        return fromWhatsAppId(trimmed);
      },
      targetResolver: {
        looksLikeId: (id) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          return /^\+?\d{7,15}$/.test(trimmed) || /^whatsapp:\+?\d+$/.test(trimmed);
        },
        hint: '<phone number in E.164 format>',
      },
    },
    setup: {
      resolveChannelSetupStatus: ({ cfg }) => {
        const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';

        if (!channelCfg?.enabled) return { status: 'not-configured' };
        if (!accountSid || !authToken) return { status: 'not-configured', hint: 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN' };
        if (!channelCfg.fromNumber) return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.fromNumber' };
        if (!channelCfg.webhookUrl) return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.webhookUrl' };
        return { status: 'configured' };
      },
    },
    status: {
      resolveAccountStatus: async ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        extra: {
          dmPolicy: account.config.dmPolicy,
          allowFrom: account.config.allowFrom,
        },
      }),
      resolveAccountState: ({ configured }) => configured ? 'ready' : 'not configured',
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const { accountSid, authToken } = account;
        const { fromNumber, webhookUrl, allowFrom: allowFromList } = account.config;

        const mediaBase = path.join(os.homedir(), '.openclaw', 'media', 'twilio-whatsapp');
        const inboundDir = path.join(mediaBase, 'inbound');
        const outboundDir = path.join(mediaBase, 'outbound');
        fs.mkdirSync(inboundDir, { recursive: true });
        fs.mkdirSync(outboundDir, { recursive: true });

        const allowFrom = new Set((allowFromList || []).map((p: string) => p.replace(/^\+?/, '+')));

        const dispatch = async (msg: InboundMessage) => {
          const sendTwilioReply = async (text: string) => {
            const client = twilio(accountSid, authToken);
            const result = await client.messages.create({
              from: toWhatsAppId(fromNumber),
              to: toWhatsAppId(msg.senderId),
              body: text,
            });
            return { messageId: result.sid };
          };

          // The webhook layer (webhook.ts) and createRestrictSendersChannelSecurity
          // have already authorized this sender. shouldComputeCommandAuthorized
          // detects /cmd, !cmd, and inline command tokens; when true we mark the
          // sender as authorized so the host's auto-reply pipeline runs the command.
          const isCommand = shouldComputeCommandAuthorized(msg.text, ctx.cfg);
          ctx.log?.debug?.(
            `[twilio-whatsapp] inbound from=${msg.senderId} ` +
              `len=${msg.text.length} isCommand=${isCommand} ` +
              `messageSid=${msg.messageSid}`,
          );

          const result = await dispatchInboundDirectDmWithRuntime({
            cfg: ctx.cfg,
            channel: 'twilio-whatsapp',
            accountId: account.accountId,
            peer: { kind: 'direct', id: msg.senderId },
            runtime: getTwilioWhatsAppRuntime(),
            channelLabel: 'Twilio WhatsApp',
            conversationLabel: msg.senderName || msg.senderId,
            rawBody: msg.text,
            commandAuthorized: isCommand ? true : undefined,
            senderAddress: msg.senderId,
            recipientAddress: toWhatsAppId(fromNumber),
            originatingTo: toWhatsAppId(msg.senderId),
            senderId: msg.senderId,
            messageId: msg.messageSid,
            provider: 'twilio-whatsapp',
            surface: 'twilio-whatsapp',
            deliver: async (payload) => {
              if (payload.text) {
                return sendTwilioReply(payload.text);
              }
              return {};
            },
          });

          ctx.log?.debug?.(
            `[twilio-whatsapp] dispatched messageSid=${msg.messageSid} ` +
              `route.agentId=${result?.route?.agentId} ` +
              `route.sessionKey=${result?.route?.sessionKey}`,
          );
        };

        const unregisterWebhook = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: 'twilio-whatsapp',
          accountId: account.accountId,
          handler: createWebhookHandler(
            { accountSid, authToken, fromNumber: toWhatsAppId(fromNumber), webhookUrl, allowFrom, inboundDir },
            dispatch,
          ),
        });

        const unregisterMedia = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/media',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: 'twilio-whatsapp',
          accountId: account.accountId,
          handler: createMediaServeHandler(outboundDir),
        });

        const unregisterHealth = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/health',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: 'twilio-whatsapp',
          accountId: account.accountId,
          handler: createHealthHandler(),
        });

        ctx.log?.info(`[${account.accountId}] Twilio WhatsApp channel started (from: ${fromNumber})`);

        if (ctx.abortSignal && !ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal!.addEventListener('abort', () => resolve(), { once: true });
          });
        }

        unregisterWebhook();
        unregisterMedia();
        unregisterHealth();
        ctx.log?.info(`[${account.accountId}] Twilio WhatsApp channel stopped`);
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        '',
        'The user is on WhatsApp. Use WhatsApp formatting only: *bold*, _italic_, ~strikethrough~, ```monospace```.',
        'No markdown headers, links, or HTML. Use • for bullet points.',
        'Keep responses concise — messages over 1600 characters are split.',
      ],
    },
  },
  outbound: {
    deliveryMode: 'gateway',
    textChunkLimit: TWILIO_MAX_MESSAGE_LEN,
    chunker: chunkText,
    ...createAttachedChannelResultAdapter({
      channel: 'twilio-whatsapp',
      sendText: async ({ cfg, to, text }) => {
        const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
        if (!channelCfg) throw new Error('Twilio WhatsApp channel not configured');

        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';
        if (!accountSid || !authToken) throw new Error('Twilio credentials not set');

        const client = twilio(accountSid, authToken);
        const result = await client.messages.create({
          from: toWhatsAppId(channelCfg.fromNumber),
          to: toWhatsAppId(to),
          body: text || '',
        });
        return { messageId: result.sid };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl }) => {
        const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
        if (!channelCfg) throw new Error('Twilio WhatsApp channel not configured');

        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';
        if (!accountSid || !authToken) throw new Error('Twilio credentials not set');

        const client = twilio(accountSid, authToken);
        const from = toWhatsAppId(channelCfg.fromNumber);
        const toWa = toWhatsAppId(to);

        let stagedUrl: string | null = null;
        if (mediaUrl) {
          const outboundDir = path.join(os.homedir(), '.openclaw', 'media', 'twilio-whatsapp', 'outbound');
          stagedUrl = stageMedia(mediaUrl, outboundDir, channelCfg.webhookUrl);
        }

        const result = await client.messages.create({
          from,
          to: toWa,
          body: text || '',
          ...(stagedUrl ? { mediaUrl: [stagedUrl] } : {}),
        });
        return { messageId: result.sid };
      },
    }),
    resolveTarget: ({ to }: { to?: string }) => {
      const normalized = to?.trim();
      if (!normalized) return { ok: false, error: new Error('No target specified') };
      return { ok: true, to: fromWhatsAppId(normalized) };
    },
  },
});
