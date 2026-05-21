import fs from 'fs';
import path from 'path';
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import {
  createChannelMessageAdapterFromOutbound,
  createMessageReceiptFromOutboundResults,
} from 'openclaw/plugin-sdk/channel-message';
import { createRestrictSendersChannelSecurity } from 'openclaw/plugin-sdk/channel-policy';
import { createAttachedChannelResultAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import { chunkText } from 'openclaw/plugin-sdk/reply-chunking';
import { registerPluginHttpRoute } from 'openclaw/plugin-sdk/webhook-ingress';
import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound';
import { shouldComputeCommandAuthorized } from 'openclaw/plugin-sdk/command-auth';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { getTwilioWhatsAppRuntime } from './runtime.js';
import { toWhatsAppId, fromWhatsAppId, stableIdHash } from './util.js';
import { stageMedia, createMediaServeHandler } from './media.js';
import {
  createWebhookHandler,
  createStatusCallbackHandler,
  createHealthHandler,
  type InboundMessage,
} from './webhook.js';
import { sendTwilioWhatsAppMessages } from './send.js';
import { sendTwilioTypingIndicator } from './feedback.js';
import { scheduleProcessingAck } from './processing-ack.js';
import { emitTimingEvent, logTiming, type TimingLogger } from './diagnostics.js';

const TWILIO_MAX_MESSAGE_LEN = 1600;
const INBOUND_WEBHOOK_PATHS = ['/webhook/twilio-whatsapp', '/webhook/twilio'];

function isPublicHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

interface TwilioWhatsAppConfig {
  enabled: boolean;
  dmPolicy?: 'allowlist' | 'open';
  allowFrom?: string[];
  groupPolicy?: 'disabled' | 'allowlist' | 'open';
  groupAllowFrom?: string[];
  groups?: Record<string, unknown>;
  fromNumber: string;
  webhookUrl: string;
  statusCallbackUrl?: string;
  sendTimeoutMs?: number;
  sendRetries?: number;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  typingIndicators?: boolean;
  typingTimeoutMs?: number;
  processingAckText?: string;
  processingAckDelayMs?: number;
  dmHistoryLimit?: number;
}

interface ResolvedTwilioAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  config: TwilioWhatsAppConfig;
  accountSid: string;
  authToken: string;
}

function resolveDmPolicy(config: Pick<TwilioWhatsAppConfig, 'dmPolicy'> | undefined): 'allowlist' | 'open' {
  return config?.dmPolicy === 'open' ? 'open' : 'allowlist';
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
    config: { ...channelCfg, dmPolicy: resolveDmPolicy(channelCfg) },
    accountSid,
    authToken,
  };
}

const twilioWhatsAppSecurity = createRestrictSendersChannelSecurity<ResolvedTwilioAccount>({
  channelKey: 'twilio-whatsapp',
  resolveDmPolicy: (account) => resolveDmPolicy(account.config),
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  surface: 'Twilio WhatsApp',
  openScope: 'anyone with the bot number',
  policyPathSuffix: 'dmPolicy',
  mentionGated: false,
  approveHint: 'Add the phone number to channels.twilio-whatsapp.allowFrom',
  normalizeDmEntry: (raw) => raw.replace(/^whatsapp:/i, '').replace(/^\+?/, '+'),
});

function statusCallbackUrl(config: TwilioWhatsAppConfig): string | undefined {
  return config.statusCallbackUrl || `${config.webhookUrl.replace(/\/+$/, '')}/webhook/twilio-whatsapp/status`;
}

function logWarn(log: TimingLogger | undefined, message: string) {
  (log?.warn ?? log?.info)?.(message);
}

function hasGroupCompatibilityConfig(config: TwilioWhatsAppConfig): boolean {
  return (
    config.groupPolicy !== undefined ||
    Array.isArray(config.groupAllowFrom) ||
    Boolean(config.groups && Object.keys(config.groups).length > 0)
  );
}

type TwilioSendTimingContext = {
  log?: TimingLogger;
  kind: 'final_reply' | 'processing_ack' | 'outbound_text' | 'outbound_media';
  sessionKey?: string;
  messageSid?: string;
};

async function sendWithConfig(params: {
  config: TwilioWhatsAppConfig;
  accountSid: string;
  authToken: string;
  to: string;
  text: string;
  mediaUrls?: string[];
  timing?: TwilioSendTimingContext;
}) {
  const startedAt = Date.now();
  const deliveryKind = params.mediaUrls?.length ? 'media' : 'text';
  const timingFields = {
    kind: params.timing?.kind,
    sessionKey: params.timing?.sessionKey,
    messageSid: params.timing?.messageSid,
    toHash: stableIdHash(params.to),
    mediaCount: params.mediaUrls?.length ?? 0,
  };
  logTiming(params.timing?.log, 'twilio_send_start', timingFields);
  emitTimingEvent({
    type: 'message.delivery.started',
    channel: 'twilio-whatsapp',
    sessionKey: params.timing?.sessionKey,
    deliveryKind,
  });
  try {
    const result = await sendTwilioWhatsAppMessages({
      accountSid: params.accountSid,
      authToken: params.authToken,
      fromNumber: params.config.fromNumber,
      toNumber: params.to,
      text: params.text,
      mediaUrls: params.mediaUrls,
      statusCallbackUrl: statusCallbackUrl(params.config),
      timeoutMs: params.config.sendTimeoutMs,
      maxRetries: params.config.sendRetries,
      chunkLimit: params.config.textChunkLimit || TWILIO_MAX_MESSAGE_LEN,
    });
    const durationMs = Date.now() - startedAt;
    logTiming(params.timing?.log, 'twilio_send_done', {
      ...timingFields,
      durationMs,
      messageCount: result.messageIds.length,
      payloadCount: result.payloadCount,
    });
    emitTimingEvent({
      type: 'message.delivery.completed',
      channel: 'twilio-whatsapp',
      sessionKey: params.timing?.sessionKey,
      deliveryKind,
      durationMs,
      resultCount: result.messageIds.length,
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logTiming(params.timing?.log, 'twilio_send_error', {
      ...timingFields,
      durationMs,
      error: error instanceof Error ? error.name || 'Error' : 'unknown',
    });
    emitTimingEvent({
      type: 'message.delivery.error',
      channel: 'twilio-whatsapp',
      sessionKey: params.timing?.sessionKey,
      deliveryKind,
      durationMs,
      errorCategory: error instanceof Error ? error.name || 'Error' : 'unknown',
    });
    throw error;
  }
}

const twilioWhatsAppOutbound = {
  deliveryMode: 'gateway' as const,
  textChunkLimit: TWILIO_MAX_MESSAGE_LEN,
  chunker: chunkText,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
    },
  },
  ...createAttachedChannelResultAdapter({
    channel: 'twilio-whatsapp',
    sendText: async ({ cfg, to, text }) => {
      const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
      if (!channelCfg) throw new Error('Twilio WhatsApp channel not configured');

      const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
      const authToken = process.env.TWILIO_AUTH_TOKEN || '';
      if (!accountSid || !authToken) throw new Error('Twilio credentials not set');

      const result = await sendWithConfig({
        config: channelCfg,
        accountSid,
        authToken,
        to,
        text,
        timing: {
          log: undefined,
          kind: 'outbound_text',
        },
      });
      return {
        messageId: result.messageIds[0] || '',
        receipt: createMessageReceiptFromOutboundResults({
          results: result.messageIds.map((messageId) => ({ channel: 'twilio-whatsapp', messageId })),
          kind: 'text',
        }),
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }) => {
      const channelCfg = cfg?.channels?.['twilio-whatsapp'] as TwilioWhatsAppConfig | undefined;
      if (!channelCfg) throw new Error('Twilio WhatsApp channel not configured');

      const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
      const authToken = process.env.TWILIO_AUTH_TOKEN || '';
      if (!accountSid || !authToken) throw new Error('Twilio credentials not set');

      let stagedUrl: string | null = null;
      if (mediaUrl) {
        const trimmedMediaUrl = mediaUrl.trim();
        if (isPublicHttpsUrl(trimmedMediaUrl)) {
          stagedUrl = trimmedMediaUrl;
        } else {
          const outboundDir = path.join(resolveStateDir(), 'media', 'twilio-whatsapp', 'outbound');
          stagedUrl = stageMedia(trimmedMediaUrl, outboundDir, channelCfg.webhookUrl);
        }
        if (!stagedUrl) {
          throw new Error(`Twilio WhatsApp media not found or not readable: ${mediaUrl}`);
        }
      }

      const result = await sendWithConfig({
        config: channelCfg,
        accountSid,
        authToken,
        to,
        text: text || '',
        mediaUrls: stagedUrl ? [stagedUrl] : undefined,
        timing: {
          log: undefined,
          kind: 'outbound_media',
        },
      });
      return {
        messageId: result.messageIds[0] || '',
        receipt: createMessageReceiptFromOutboundResults({
          results: result.messageIds.map((messageId) => ({ channel: 'twilio-whatsapp', messageId })),
          kind: 'media',
        }),
      };
    },
  }),
  resolveTarget: ({ to }: { to?: string }) => {
    const normalized = to?.trim();
    if (!normalized) return { ok: false as const, error: new Error('No target specified') };
    return { ok: true as const, to: fromWhatsAppId(normalized) };
  },
};

export const twilioWhatsAppPlugin = createChatChannelPlugin<ResolvedTwilioAccount>({
  base: {
    id: 'twilio-whatsapp',
    message: createChannelMessageAdapterFromOutbound({
      id: 'twilio-whatsapp',
      outbound: twilioWhatsAppOutbound,
    }),
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
        if (resolveDmPolicy(channelCfg) === 'allowlist' && !(channelCfg.allowFrom || []).length) {
          return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.allowFrom or change dmPolicy to open' };
        }
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
        const { fromNumber, webhookUrl, allowFrom: allowFromList, mediaMaxMb } = account.config;

        if (hasGroupCompatibilityConfig(account.config)) {
          logWarn(
            ctx.log,
            '[twilio-whatsapp] group config keys are present but Twilio WhatsApp Business API is DM-only; groupPolicy, groupAllowFrom, and groups are ignored. DM access is still controlled by dmPolicy and allowFrom.',
          );
        }

        // Use the SDK's resolveStateDir() — it honors OPENCLAW_STATE_DIR and
        // falls back to ~/.openclaw. os.homedir() is wrong in containers where
        // $HOME doesn't match the workspace owner (EACCES on mkdir), and the
        // channel's ctx.runtime is only a logging runtime (no .agent helpers).
        const mediaBase = path.join(resolveStateDir(), 'media', 'twilio-whatsapp');
        const inboundDir = path.join(mediaBase, 'inbound');
        const outboundDir = path.join(mediaBase, 'outbound');
        fs.mkdirSync(inboundDir, { recursive: true });
        fs.mkdirSync(outboundDir, { recursive: true });

        const allowFrom = new Set((allowFromList || []).map((p: string) => fromWhatsAppId(p).replace(/^\+?/, '+')));

        const dispatch = async (msg: InboundMessage) => {
          let currentSessionKey: string | undefined;
          const sendTwilioReply = async (text: string, kind: TwilioSendTimingContext['kind'] = 'final_reply') => {
            if (msg.dryRunDelivery === true) {
              logTiming(ctx.log, 'twilio_send_dry_run', {
                kind,
                sessionKey: currentSessionKey,
                messageSid: msg.messageSid,
                toHash: stableIdHash(msg.senderId),
              });
              return {
                messageId: `dry-run:${msg.messageSid || Date.now()}`,
                receipt: createMessageReceiptFromOutboundResults({
                  results: [{ channel: 'twilio-whatsapp', messageId: `dry-run:${msg.messageSid || Date.now()}` }],
                  kind: 'text',
                }),
              };
            }
            const result = await sendWithConfig({
              config: account.config,
              accountSid,
              authToken,
              to: msg.senderId,
              text,
              timing: {
                log: ctx.log,
                kind,
                sessionKey: currentSessionKey,
                messageSid: msg.messageSid,
              },
            });
            return {
              messageId: result.messageIds[0] || '',
              receipt: createMessageReceiptFromOutboundResults({
                results: result.messageIds.map((messageId) => ({ channel: 'twilio-whatsapp', messageId })),
                kind: 'text',
              }),
            };
          };

          // The webhook layer (webhook.ts) and createRestrictSendersChannelSecurity
          // have already authorized this sender. shouldComputeCommandAuthorized
          // detects /cmd, !cmd, and inline command tokens; when true we mark the
          // sender as authorized so the host's auto-reply pipeline runs the command.
          const isCommand = shouldComputeCommandAuthorized(msg.text, ctx.cfg);
          ctx.log?.debug?.(
            `[twilio-whatsapp] inbound sender=${stableIdHash(msg.senderId)} ` +
              `len=${msg.text.length} isCommand=${isCommand} ` +
              `messageSid=${msg.messageSid}`,
          );

          const processingAck = scheduleProcessingAck({
            text: account.config.processingAckText,
            delayMs: account.config.processingAckDelayMs,
            send: (text) => sendTwilioReply(text, 'processing_ack'),
            onError: (error) => {
              logWarn(
                ctx.log,
                `[twilio-whatsapp] processing ack failed messageSid=${msg.messageSid || 'unknown'} error=${String(
                  error instanceof Error ? error.message : error,
                )}`,
              );
            },
          });
          if (processingAck) {
            logTiming(ctx.log, 'processing_ack_scheduled', {
              messageSid: msg.messageSid,
              delayMs: account.config.processingAckDelayMs ?? 12000,
            });
          }

          const dispatchStartedAt = Date.now();
          logTiming(ctx.log, 'dispatch_start', {
            messageSid: msg.messageSid,
            senderHash: stableIdHash(msg.senderId),
          });
          try {
            const result = await dispatchInboundDirectDmWithRuntime({
              cfg: ctx.cfg,
              channel: 'twilio-whatsapp',
              accountId: account.accountId,
              peer: { kind: 'direct', id: msg.senderId },
              runtime: getTwilioWhatsAppRuntime(),
              channelLabel: 'Twilio WhatsApp',
              conversationLabel: msg.senderName || stableIdHash(msg.senderId),
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
                  return sendTwilioReply(payload.text, 'final_reply');
                }
                return {};
              },
            });
            currentSessionKey = result?.route?.sessionKey;

            ctx.log?.debug?.(
              `[twilio-whatsapp] dispatched messageSid=${msg.messageSid} ` +
                `route.agentId=${result?.route?.agentId} ` +
                `route.sessionKey=${result?.route?.sessionKey}`,
            );
            const durationMs = Date.now() - dispatchStartedAt;
            logTiming(ctx.log, 'dispatch_done', {
              messageSid: msg.messageSid,
              routeAgentId: result?.route?.agentId,
              sessionKey: result?.route?.sessionKey,
              durationMs,
            });
            emitTimingEvent({
              type: 'message.processed',
              channel: 'twilio-whatsapp',
              messageId: msg.messageSid,
              chatId: stableIdHash(msg.senderId),
              sessionKey: result?.route?.sessionKey,
              durationMs,
              outcome: 'completed',
            });
          } catch (error) {
            const durationMs = Date.now() - dispatchStartedAt;
            logTiming(ctx.log, 'dispatch_error', {
              messageSid: msg.messageSid,
              durationMs,
              error: error instanceof Error ? error.name || 'Error' : 'unknown',
            });
            emitTimingEvent({
              type: 'message.processed',
              channel: 'twilio-whatsapp',
              messageId: msg.messageSid,
              chatId: stableIdHash(msg.senderId),
              sessionKey: currentSessionKey,
              durationMs,
              outcome: 'error',
              error: error instanceof Error ? error.name || 'Error' : 'unknown',
            });
            throw error;
          } finally {
            processingAck?.complete();
          }
        };

        const webhookHandler = createWebhookHandler(
          {
            accountSid,
            authToken,
            fromNumber: toWhatsAppId(fromNumber),
            webhookUrl,
            webhookPaths: INBOUND_WEBHOOK_PATHS,
            statusCallbackUrl: statusCallbackUrl(account.config),
            dmPolicy: resolveDmPolicy(account.config),
            allowFrom,
            inboundDir,
            mediaMaxBytes: Math.max(1, mediaMaxMb || 25) * 1024 * 1024,
            typingIndicators: account.config.typingIndicators === true,
            typingTimeoutMs: account.config.typingTimeoutMs,
            sendTypingIndicator: (messageSid) =>
              sendTwilioTypingIndicator({
                accountSid,
                authToken,
                messageSid,
                timeoutMs: account.config.typingTimeoutMs,
              }),
            log: {
              info: (message) => ctx.log?.info?.(message),
              warn: (message) => logWarn(ctx.log, message),
              error: (message) => ctx.log?.error?.(message),
            },
          },
          dispatch,
        );

        const unregisterWebhooks = INBOUND_WEBHOOK_PATHS.map((path) =>
          registerPluginHttpRoute({
            path,
            auth: 'plugin',
            replaceExisting: true,
            pluginId: 'twilio-whatsapp',
            accountId: account.accountId,
            handler: webhookHandler,
          }),
        );

        const unregisterStatus = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/status',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: 'twilio-whatsapp',
          accountId: account.accountId,
          handler: createStatusCallbackHandler({
            authToken,
            webhookUrl,
            statusCallbackUrl: statusCallbackUrl(account.config),
            log: {
              info: (message) => ctx.log?.info?.(message),
              warn: (message) => logWarn(ctx.log, message),
              error: (message) => ctx.log?.error?.(message),
            },
          }),
        });

        const unregisterMedia = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/media',
          auth: 'plugin',
          match: 'prefix',
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

        ctx.log?.info(`[${account.accountId}] Twilio WhatsApp channel started (from=${stableIdHash(fromNumber)})`);

        if (ctx.abortSignal && !ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal!.addEventListener('abort', () => resolve(), { once: true });
          });
        }

        unregisterWebhooks.forEach((unregisterWebhook) => unregisterWebhook());
        unregisterStatus();
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
  outbound: twilioWhatsAppOutbound,
});
