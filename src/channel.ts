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
const CHANNEL_KEY = 'twilio-whatsapp';
const INBOUND_WEBHOOK_PATHS = ['/webhook/twilio-whatsapp', '/webhook/twilio'];
const LEGACY_TOP_LEVEL_ACCOUNT_KEYS = [
  'fromNumber',
  'dmPolicy',
  'allowFrom',
  'groupPolicy',
  'groupAllowFrom',
  'groups',
] as const;

function isPublicHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

interface TwilioWhatsAppAccountConfig {
  name?: string;
  enabled?: boolean;
  dmPolicy?: 'allowlist' | 'open';
  allowFrom?: string[];
  groupPolicy?: 'disabled' | 'allowlist' | 'open';
  groupAllowFrom?: string[];
  groups?: Record<string, unknown>;
  fromNumber: string;
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

interface TwilioWhatsAppChannelConfig {
  enabled: boolean;
  webhookUrl: string;
  defaultAccount?: string;
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
  accounts: Record<string, TwilioWhatsAppAccountConfig>;
}

type ResolvedTwilioAccountConfig = TwilioWhatsAppAccountConfig & {
  webhookUrl: string;
};

interface ResolvedTwilioAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  config: ResolvedTwilioAccountConfig;
  accountSid: string;
  authToken: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeAccountId(value: string | null | undefined): string {
  const normalized = (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '');
  return normalized || 'default';
}

function formatMigrationError(keys: string[]): string {
  return (
    `Twilio WhatsApp v3.0.0 requires account-scoped senders. ` +
    `Move ${keys.map((key) => `channels.twilio-whatsapp.${key}`).join(', ')} under ` +
    `channels.twilio-whatsapp.accounts.<accountId>. Example: ` +
    `channels.twilio-whatsapp.accounts.vinalia.fromNumber.`
  );
}

function readChannelConfig(cfg: any): TwilioWhatsAppChannelConfig | undefined {
  const channelCfg = cfg?.channels?.[CHANNEL_KEY];
  if (!channelCfg) return undefined;
  if (!isObjectRecord(channelCfg)) {
    throw new Error(`channels.${CHANNEL_KEY} must be an object`);
  }
  const legacyKeys = LEGACY_TOP_LEVEL_ACCOUNT_KEYS.filter((key) => key in channelCfg);
  if (legacyKeys.length > 0) {
    throw new Error(formatMigrationError(legacyKeys));
  }
  return channelCfg as unknown as TwilioWhatsAppChannelConfig;
}

function resolveDmPolicy(config: Pick<TwilioWhatsAppAccountConfig, 'dmPolicy'> | undefined): 'allowlist' | 'open' {
  return config?.dmPolicy === 'open' ? 'open' : 'allowlist';
}

function listTwilioAccountIds(cfg: any): string[] {
  const channelCfg = readChannelConfig(cfg);
  const accounts = isObjectRecord(channelCfg?.accounts) ? channelCfg.accounts : {};
  return Object.keys(accounts)
    .map((key) => normalizeAccountId(key))
    .filter((key, index, ids) => key && ids.indexOf(key) === index);
}

function resolveDefaultTwilioAccountId(cfg: any): string {
  const channelCfg = readChannelConfig(cfg);
  const accountIds = listTwilioAccountIds(cfg);
  const configuredDefault = normalizeAccountId(channelCfg?.defaultAccount);
  if (channelCfg?.defaultAccount && accountIds.includes(configuredDefault)) {
    return configuredDefault;
  }
  return accountIds[0] || 'default';
}

function resolveAccountEntry(
  channelCfg: TwilioWhatsAppChannelConfig,
  accountId: string,
): TwilioWhatsAppAccountConfig | undefined {
  if (!isObjectRecord(channelCfg.accounts)) return undefined;
  const normalized = normalizeAccountId(accountId);
  for (const [key, value] of Object.entries(channelCfg.accounts)) {
    if (normalizeAccountId(key) === normalized && isObjectRecord(value)) {
      return value as TwilioWhatsAppAccountConfig;
    }
  }
  return undefined;
}

function resolveMergedAccountConfig(
  channelCfg: TwilioWhatsAppChannelConfig,
  accountId: string,
): ResolvedTwilioAccountConfig | null {
  const accountCfg = resolveAccountEntry(channelCfg, accountId);
  if (!accountCfg) return null;
  return {
    statusCallbackUrl: channelCfg.statusCallbackUrl,
    sendTimeoutMs: channelCfg.sendTimeoutMs,
    sendRetries: channelCfg.sendRetries,
    textChunkLimit: channelCfg.textChunkLimit,
    mediaMaxMb: channelCfg.mediaMaxMb,
    typingIndicators: channelCfg.typingIndicators,
    typingTimeoutMs: channelCfg.typingTimeoutMs,
    processingAckText: channelCfg.processingAckText,
    processingAckDelayMs: channelCfg.processingAckDelayMs,
    dmHistoryLimit: channelCfg.dmHistoryLimit,
    ...accountCfg,
    webhookUrl: channelCfg.webhookUrl,
    dmPolicy: resolveDmPolicy(accountCfg),
  };
}

export function resolveTwilioWhatsAppAccount(cfg: any, accountId?: string | null): ResolvedTwilioAccount | null {
  const channelCfg = readChannelConfig(cfg);
  if (!channelCfg?.enabled) return null;

  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  if (!accountSid || !authToken) return null;
  const resolvedAccountId = normalizeAccountId(accountId || resolveDefaultTwilioAccountId(cfg));
  const accountCfg = resolveMergedAccountConfig(channelCfg, resolvedAccountId);
  if (!accountCfg || accountCfg.enabled === false) return null;

  return {
    accountId: resolvedAccountId,
    name: accountCfg.name || `Twilio WhatsApp (${resolvedAccountId})`,
    enabled: channelCfg.enabled,
    config: accountCfg,
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
  approveHint: 'Add the phone number to channels.twilio-whatsapp.accounts.<accountId>.allowFrom',
  normalizeDmEntry: (raw) => raw.replace(/^whatsapp:/i, '').replace(/^\+?/, '+'),
});

function addAccountIdQuery(url: string, accountId: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('accountId', accountId);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}accountId=${encodeURIComponent(accountId)}`;
  }
}

function statusCallbackUrl(config: ResolvedTwilioAccountConfig, accountId: string): string | undefined {
  const base = config.statusCallbackUrl || `${config.webhookUrl.replace(/\/+$/, '')}/webhook/twilio-whatsapp/status`;
  return addAccountIdQuery(base, accountId);
}

function logWarn(log: TimingLogger | undefined, message: string) {
  (log?.warn ?? log?.info)?.(message);
}

function hasGroupCompatibilityConfig(config: ResolvedTwilioAccountConfig): boolean {
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

type StartedTwilioAccount = {
  account: ResolvedTwilioAccount;
  ctx: any;
};

const startedTwilioAccounts = new Map<string, StartedTwilioAccount>();

function normalizedAllowFrom(values: string[] | undefined): Set<string> {
  return new Set((values || []).map((p: string) => fromWhatsAppId(p).replace(/^\+?/, '+')));
}

function resolveWebhookAccounts(params: {
  cfg: any;
  inboundBaseDir: string;
  accountSid: string;
  authToken: string;
}) {
  return listTwilioAccountIds(params.cfg)
    .map((accountId) => resolveTwilioWhatsAppAccount(params.cfg, accountId))
    .filter((account): account is ResolvedTwilioAccount => Boolean(account))
    .map((account) => {
      const inboundDir = path.join(params.inboundBaseDir, account.accountId);
      fs.mkdirSync(inboundDir, { recursive: true });
      return {
        accountId: account.accountId,
        fromNumber: toWhatsAppId(account.config.fromNumber),
        statusCallbackUrl: statusCallbackUrl(account.config, account.accountId),
        dmPolicy: resolveDmPolicy(account.config),
        allowFrom: normalizedAllowFrom(account.config.allowFrom),
        inboundDir,
        mediaMaxBytes: Math.max(1, account.config.mediaMaxMb || 25) * 1024 * 1024,
        typingIndicators: account.config.typingIndicators === true,
        typingTimeoutMs: account.config.typingTimeoutMs,
        sendTypingIndicator: (messageSid: string) =>
          sendTwilioTypingIndicator({
            accountSid: params.accountSid,
            authToken: params.authToken,
            messageSid,
            timeoutMs: account.config.typingTimeoutMs,
          }),
      };
    });
}

async function sendWithConfig(params: {
  config: ResolvedTwilioAccountConfig;
  accountId: string;
  accountSid: string;
  authToken: string;
  to: string;
  text: string;
  mediaUrls?: string[];
  createClient?: any;
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
      statusCallbackUrl: statusCallbackUrl(params.config, params.accountId),
      timeoutMs: params.config.sendTimeoutMs,
      maxRetries: params.config.sendRetries,
      chunkLimit: params.config.textChunkLimit || TWILIO_MAX_MESSAGE_LEN,
      createClient: params.createClient,
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
    channel: CHANNEL_KEY,
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const account = resolveTwilioWhatsAppAccount(cfg, accountId);
      if (!account) {
        throw new Error(
          `Twilio WhatsApp account "${normalizeAccountId(accountId || resolveDefaultTwilioAccountId(cfg))}" is not configured`,
        );
      }

      const result = await sendWithConfig({
        config: account.config,
        accountId: account.accountId,
        accountSid: account.accountSid,
        authToken: account.authToken,
        to,
        text,
        createClient: deps?.createTwilioClient,
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
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
      const account = resolveTwilioWhatsAppAccount(cfg, accountId);
      if (!account) {
        throw new Error(
          `Twilio WhatsApp account "${normalizeAccountId(accountId || resolveDefaultTwilioAccountId(cfg))}" is not configured`,
        );
      }

      let stagedUrl: string | null = null;
      if (mediaUrl) {
        const trimmedMediaUrl = mediaUrl.trim();
        if (isPublicHttpsUrl(trimmedMediaUrl)) {
          stagedUrl = trimmedMediaUrl;
        } else {
          const outboundDir = path.join(resolveStateDir(), 'media', CHANNEL_KEY, 'outbound');
          stagedUrl = stageMedia(trimmedMediaUrl, outboundDir, account.config.webhookUrl);
        }
        if (!stagedUrl) {
          throw new Error(`Twilio WhatsApp media not found or not readable: ${mediaUrl}`);
        }
      }

      const result = await sendWithConfig({
        config: account.config,
        accountId: account.accountId,
        accountSid: account.accountSid,
        authToken: account.authToken,
        to,
        text: text || '',
        mediaUrls: stagedUrl ? [stagedUrl] : undefined,
        createClient: deps?.createTwilioClient,
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
    id: CHANNEL_KEY,
    message: createChannelMessageAdapterFromOutbound({
      id: CHANNEL_KEY,
      outbound: twilioWhatsAppOutbound,
    }),
    config: {
      listAccountIds: (cfg: any) => listTwilioAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string) => resolveTwilioWhatsAppAccount(cfg, accountId),
      defaultAccountId: (cfg: any) => resolveDefaultTwilioAccountId(cfg),
      setAccountEnabled: ({ cfg }: { cfg: any; accountId: string; enabled: boolean }) => cfg,
      deleteAccount: ({ cfg }: { cfg: any; accountId: string }) => cfg,
    },
    resolveAccount: ({ cfg, accountId }) => resolveTwilioWhatsAppAccount(cfg, accountId),
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
        const channelCfg = readChannelConfig(cfg);
        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';

        if (!channelCfg?.enabled) return { status: 'not-configured' };
        if (!accountSid || !authToken) return { status: 'not-configured', hint: 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN' };
        if (!channelCfg.webhookUrl) return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.webhookUrl' };
        const accountIds = listTwilioAccountIds(cfg);
        if (accountIds.length === 0) {
          return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.accounts.<accountId>.fromNumber' };
        }
        for (const accountId of accountIds) {
          const accountCfg = resolveMergedAccountConfig(channelCfg, accountId);
          if (!accountCfg?.fromNumber) {
            return { status: 'not-configured', hint: `Set channels.twilio-whatsapp.accounts.${accountId}.fromNumber` };
          }
          if (resolveDmPolicy(accountCfg) === 'allowlist' && !(accountCfg.allowFrom || []).length) {
            return {
              status: 'not-configured',
              hint: `Set channels.twilio-whatsapp.accounts.${accountId}.allowFrom or change dmPolicy to open`,
            };
          }
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
        const { fromNumber, webhookUrl } = account.config;

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
        const mediaBase = path.join(resolveStateDir(), 'media', CHANNEL_KEY);
        const inboundDir = path.join(mediaBase, 'inbound');
        const outboundDir = path.join(mediaBase, 'outbound');
        fs.mkdirSync(inboundDir, { recursive: true });
        fs.mkdirSync(outboundDir, { recursive: true });

        startedTwilioAccounts.set(account.accountId, { account, ctx });

        const dispatch = async (msg: InboundMessage) => {
          const active = startedTwilioAccounts.get(msg.accountId);
          if (!active) {
            throw new Error(`Twilio WhatsApp account "${msg.accountId}" is not running`);
          }
          const { account, ctx } = active;
          const { accountSid, authToken } = account;
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
              accountId: account.accountId,
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
              recipientAddress: toWhatsAppId(account.config.fromNumber),
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
            webhookUrl,
            webhookPaths: INBOUND_WEBHOOK_PATHS,
            accounts: resolveWebhookAccounts({ cfg: ctx.cfg, inboundBaseDir: inboundDir, accountSid, authToken }),
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
            pluginId: CHANNEL_KEY,
            accountId: account.accountId,
            handler: webhookHandler,
          }),
        );

        const unregisterStatus = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/status',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: CHANNEL_KEY,
          accountId: account.accountId,
          handler: createStatusCallbackHandler({
            authToken,
            webhookUrl,
            accounts: resolveWebhookAccounts({ cfg: ctx.cfg, inboundBaseDir: inboundDir, accountSid, authToken }),
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
          pluginId: CHANNEL_KEY,
          accountId: account.accountId,
          handler: createMediaServeHandler(outboundDir),
        });

        const unregisterHealth = registerPluginHttpRoute({
          path: '/webhook/twilio-whatsapp/health',
          auth: 'plugin',
          replaceExisting: true,
          pluginId: CHANNEL_KEY,
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
        startedTwilioAccounts.delete(account.accountId);
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
