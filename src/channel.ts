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
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { getTwilioWhatsAppRuntime } from './runtime.js';
import { toWhatsAppId, fromWhatsAppId } from './util.js';
import { stageMedia, createMediaServeHandler } from './media.js';
import { createWebhookHandler, createHealthHandler, type InboundMessage } from './webhook.js';
import { diagFlagEnabled, diagLog, DIAG_BOOT, DIAG_SEND } from './diag.js';

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

type TwilioClient = ReturnType<typeof twilio>;

function resolveLogger() {
  // getTwilioWhatsAppRuntime() throws if the runtime isn't initialized yet — wrap it.
  try {
    return getTwilioWhatsAppRuntime()?.logging?.getChildLogger?.({ plugin: 'twilio-whatsapp' });
  } catch {
    return undefined; // fall back to console
  }
}

// Twilio rejects WhatsApp bodies over TWILIO_MAX_MESSAGE_LEN with error 21617 and the
// reply is silently lost. The gateway does not honor the programmatic outbound.chunker
// for the result-adapter / inbound-deliver paths, so we split here at the send site and
// surface any Twilio failure (thrown 400 or async failed/undelivered status) instead of
// swallowing it. Short text passes through as a single message.
async function sendChunkedWhatsApp(args: {
  client: TwilioClient;
  from: string; // already toWhatsAppId()-normalized
  to: string; // already toWhatsAppId()-normalized
  text?: string;
  mediaUrl?: string; // attaches to exactly ONE message (the first)
}): Promise<{ messageId?: string }> {
  const { client, from, to, text, mediaUrl } = args;
  const log = resolveLogger();
  const chunks = chunkText((text ?? '').trim(), TWILIO_MAX_MESSAGE_LEN).filter((c) => c.length > 0);

  if (chunks.length === 0 && !mediaUrl) return {}; // nothing to send
  if (chunks.length === 0 && mediaUrl) chunks.push(''); // media-only message

  let firstSid: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const attachMedia = mediaUrl && i === 0;
    try {
      const result = await client.messages.create({
        from,
        to,
        body: chunks[i],
        ...(attachMedia ? { mediaUrl: [mediaUrl] } : {}),
      });
      if (i === 0) firstSid = result.sid;
      if (result.status === 'failed' || result.status === 'undelivered') {
        (log ?? console).error(
          `[twilio-whatsapp] chunk ${i + 1}/${chunks.length} status=${result.status} ` +
            `code=${result.errorCode} sid=${result.sid}`,
        );
        throw new Error(
          `Twilio message ${result.sid} ${result.status} (code ${result.errorCode})`,
        );
      }
    } catch (err) {
      (log ?? console).error(
        `[twilio-whatsapp] failed sending chunk ${i + 1}/${chunks.length} ` +
          `to=${to} len=${chunks[i].length}: ${(err as Error).message}`,
      );
      throw err; // rethrow → gateway sees the failure (fixes silent loss)
    }
  }
  return { messageId: firstSid };
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

        // Use the SDK's resolveStateDir() — it honors OPENCLAW_STATE_DIR and
        // falls back to ~/.openclaw. os.homedir() is wrong in containers where
        // $HOME doesn't match the workspace owner (EACCES on mkdir), and the
        // channel's ctx.runtime is only a logging runtime (no .agent helpers).
        const resolvedStateDir = resolveStateDir();
        const mediaBase = path.join(resolvedStateDir, 'media', 'twilio-whatsapp');
        const inboundDir = path.join(mediaBase, 'inbound');
        const outboundDir = path.join(mediaBase, 'outbound');

        if (diagFlagEnabled(DIAG_BOOT)) {
          let homedir: string | null = null;
          try { homedir = os.homedir(); } catch { /* ignore */ }
          diagLog(ctx, '[twilio-whatsapp][startAccount] pre-mkdir', {
            resolvedStateDir,
            HOME: process.env.HOME ?? null,
            OPENCLAW_HOME: process.env.OPENCLAW_HOME ?? null,
            OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? null,
            USER: process.env.USER ?? null,
            USERPROFILE: process.env.USERPROFILE ?? null,
            uid: process.getuid?.() ?? null,
            _diag_homedir: homedir,
            inboundDir,
            outboundDir,
            accountId: account.accountId,
          });
        }

        try {
          fs.mkdirSync(inboundDir, { recursive: true });
          if (diagFlagEnabled(DIAG_BOOT)) {
            diagLog(ctx, '[twilio-whatsapp][startAccount] mkdir ok', { path: inboundDir });
          }
        } catch (err) {
          if (diagFlagEnabled(DIAG_BOOT)) {
            const e = err as NodeJS.ErrnoException;
            diagLog(ctx, '[twilio-whatsapp][startAccount] mkdir failed', {
              path: inboundDir,
              code: e.code ?? null,
              errno: e.errno ?? null,
              syscall: e.syscall ?? null,
              message: e.message,
            });
          }
          throw err;
        }
        try {
          fs.mkdirSync(outboundDir, { recursive: true });
          if (diagFlagEnabled(DIAG_BOOT)) {
            diagLog(ctx, '[twilio-whatsapp][startAccount] mkdir ok', { path: outboundDir });
          }
        } catch (err) {
          if (diagFlagEnabled(DIAG_BOOT)) {
            const e = err as NodeJS.ErrnoException;
            diagLog(ctx, '[twilio-whatsapp][startAccount] mkdir failed', {
              path: outboundDir,
              code: e.code ?? null,
              errno: e.errno ?? null,
              syscall: e.syscall ?? null,
              message: e.message,
            });
          }
          throw err;
        }

        const allowFrom = new Set((allowFromList || []).map((p: string) => p.replace(/^\+?/, '+')));

        const dispatch = async (msg: InboundMessage) => {
          const sendTwilioReply = async (text: string) => {
            const client = twilio(accountSid, authToken);
            return sendChunkedWhatsApp({
              client,
              from: toWhatsAppId(fromNumber),
              to: toWhatsAppId(msg.senderId),
              text,
            });
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
          match: 'prefix',
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
        const { messageId } = await sendChunkedWhatsApp({
          client,
          from: toWhatsAppId(channelCfg.fromNumber),
          to: toWhatsAppId(to),
          text,
        });
        return { messageId: messageId ?? '' };
      },
      sendMedia: async (ctx) => {
        if (diagFlagEnabled(DIAG_SEND)) {
          const anyCtx = ctx as any;
          diagLog(ctx, '[twilio-whatsapp][sendMedia] called', {
            to: anyCtx.to ?? null,
            accountId: anyCtx.accountId ?? null,
            threadId: anyCtx.threadId ?? null,
            replyToId: anyCtx.replyToId ?? null,
            mediaUrl: anyCtx.mediaUrl ?? null,
            mediaAccess: {
              hasReadFile: typeof anyCtx.mediaAccess?.readFile === 'function',
              localRoots: anyCtx.mediaAccess?.localRoots ?? null,
            },
            mediaLocalRoots: anyCtx.mediaLocalRoots ?? null,
            hasMediaReadFile: typeof anyCtx.mediaReadFile === 'function',
            forceDocument: anyCtx.forceDocument ?? null,
            silent: anyCtx.silent ?? null,
            gifPlayback: anyCtx.gifPlayback ?? null,
            cfgChannelsTwilioWhatsAppKeys: Object.keys(anyCtx.cfg?.channels?.['twilio-whatsapp'] ?? {}),
          });
          try {
            const resolvedStateDirDiag = resolveStateDir();
            const outboundDirDiag = path.join(resolvedStateDirDiag, 'media', 'twilio-whatsapp', 'outbound');
            diagLog(ctx, '[twilio-whatsapp][sendMedia] resolved', {
              resolvedStateDir: resolvedStateDirDiag,
              outboundDir: outboundDirDiag,
              outboundDirExists: fs.existsSync(outboundDirDiag),
              HOME: process.env.HOME ?? null,
              OPENCLAW_HOME: process.env.OPENCLAW_HOME ?? null,
              OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? null,
            });
          } catch (err) {
            diagLog(ctx, '[twilio-whatsapp][sendMedia] resolved-failed', {
              message: (err as Error).message,
            });
          }
        }

        const { cfg, to, text, mediaUrl } = ctx;
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
          const outboundDir = path.join(resolveStateDir(), 'media', 'twilio-whatsapp', 'outbound');
          stagedUrl = stageMedia(mediaUrl, outboundDir, channelCfg.webhookUrl);
        }

        const { messageId } = await sendChunkedWhatsApp({
          client,
          from,
          to: toWa,
          text,
          mediaUrl: stagedUrl ?? undefined,
        });
        return { messageId: messageId ?? '' };
      },
    }),
    resolveTarget: ({ to }: { to?: string }) => {
      const normalized = to?.trim();
      if (!normalized) return { ok: false, error: new Error('No target specified') };
      return { ok: true, to: fromWhatsAppId(normalized) };
    },
  },
});
