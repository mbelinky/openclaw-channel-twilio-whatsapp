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
import { emitTwilioWhatsAppMessageSentHook } from './sent-hook.js';
import { normalizeWhatsAppText } from './text.js';
import {
  credentialConfigurationHint,
  resolveTwilioCredentials,
  type TwilioCredentialInput,
} from './credentials.js';
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from './secret-contract.js';
import {
  createSharedTwilioRouteLifecycle,
  INBOUND_WEBHOOK_PATHS,
} from './shared-routes.js';

const TWILIO_MAX_MESSAGE_LEN = 1600;
const CHANNEL_KEY = 'twilio-whatsapp';
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
  accountSid?: TwilioCredentialInput;
  authToken?: TwilioCredentialInput;
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
  credentialSource: 'account' | 'global';
}

interface TwilioReplyPayload {
  text: string;
  mediaUrls: string[];
}

export function buildTwilioInboundExtraContext(
  message: Pick<InboundMessage, 'senderId' | 'senderName'>,
): Record<string, string> {
  return {
    ...(message.senderName.trim() ? { SenderName: message.senderName.trim() } : {}),
    SenderE164: message.senderId,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeTwilioReplyPayload(payload: unknown): TwilioReplyPayload | null {
  if (!isObjectRecord(payload)) return null;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const rawMediaUrls = [
    typeof payload.mediaUrl === 'string' ? payload.mediaUrl : '',
    ...(Array.isArray(payload.mediaUrls)
      ? payload.mediaUrls.filter((entry): entry is string => typeof entry === 'string')
      : []),
  ];
  const mediaUrls = rawMediaUrls
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
  return text || mediaUrls.length > 0 ? { text, mediaUrls } : null;
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

  const resolvedAccountId = normalizeAccountId(accountId || resolveDefaultTwilioAccountId(cfg));
  const accountCfg = resolveMergedAccountConfig(channelCfg, resolvedAccountId);
  if (!accountCfg || accountCfg.enabled === false) return null;
  const credentials = resolveTwilioCredentials(resolvedAccountId, accountCfg);
  if (!credentials) return null;

  return {
    accountId: resolvedAccountId,
    name: accountCfg.name || `Twilio WhatsApp (${resolvedAccountId})`,
    enabled: channelCfg.enabled,
    config: accountCfg,
    accountSid: credentials.accountSid,
    authToken: credentials.authToken,
    credentialSource: credentials.source,
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
  normalizeDmEntry: (raw) =>
    raw === '*' ? raw : raw.replace(/^whatsapp:/i, '').replace(/^\+?/, '+'),
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
  webhookAccount: import('./webhook.js').WebhookAccountConfig;
};

const startedTwilioAccounts = new Map<string, StartedTwilioAccount>();
const sharedRouteLifecycle = createSharedTwilioRouteLifecycle((registration) =>
  registerPluginHttpRoute(registration),
);

function normalizedAllowFrom(values: string[] | undefined): Set<string> {
  return new Set(
    (values || []).map((value: string) =>
      value === '*' ? value : fromWhatsAppId(value).replace(/^\+?/, '+'),
    ),
  );
}

export function createWebhookAccountConfig(
  account: ResolvedTwilioAccount,
  inboundBaseDir: string,
  deps: { sendTypingIndicator?: typeof sendTwilioTypingIndicator } = {},
): import('./webhook.js').WebhookAccountConfig {
  const inboundDir = path.join(inboundBaseDir, account.accountId);
  fs.mkdirSync(inboundDir, { recursive: true });
  return {
    accountId: account.accountId,
    accountSid: account.accountSid,
    authToken: account.authToken,
    webhookUrl: account.config.webhookUrl,
    fromNumber: toWhatsAppId(account.config.fromNumber),
    statusCallbackUrl: statusCallbackUrl(account.config, account.accountId),
    dmPolicy: resolveDmPolicy(account.config),
    allowFrom: normalizedAllowFrom(account.config.allowFrom),
    inboundDir,
    mediaMaxBytes: Math.max(1, account.config.mediaMaxMb || 25) * 1024 * 1024,
    typingIndicators: account.config.typingIndicators === true,
    typingTimeoutMs: account.config.typingTimeoutMs,
    sendTypingIndicator: (messageSid: string) =>
      (deps.sendTypingIndicator || sendTwilioTypingIndicator)({
        accountSid: account.accountSid,
        authToken: account.authToken,
        messageSid,
        timeoutMs: account.config.typingTimeoutMs,
      }),
  };
}

function activeWebhookAccounts(): import('./webhook.js').WebhookAccountConfig[] {
  return Array.from(startedTwilioAccounts.values(), (started) => started.webhookAccount);
}

function sharedWebhookLogger() {
  const currentLog = () => Array.from(startedTwilioAccounts.values())[0]?.ctx.log;
  return {
    info: (message: string) => currentLog()?.info?.(message),
    warn: (message: string) => logWarn(currentLog(), message),
    error: (message: string) => currentLog()?.error?.(message),
  };
}

export async function sendWithConfig(params: {
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
  const outboundDir = path.join(resolveStateDir(), 'media', CHANNEL_KEY, 'outbound');
  const mediaUrls = (params.mediaUrls || []).map((mediaUrl) => {
    const trimmedMediaUrl = mediaUrl.trim();
    if (isPublicHttpsUrl(trimmedMediaUrl)) return trimmedMediaUrl;
    const stagedUrl = stageMedia(trimmedMediaUrl, outboundDir, params.config.webhookUrl);
    if (!stagedUrl) {
      throw new Error(`Twilio WhatsApp media not found or not readable: ${mediaUrl}`);
    }
    return stagedUrl;
  });
  const startedAt = Date.now();
  const deliveryKind = mediaUrls.length > 0 ? 'media' : 'text';
  const timingFields = {
    kind: params.timing?.kind,
    sessionKey: params.timing?.sessionKey,
    messageSid: params.timing?.messageSid,
    toHash: stableIdHash(params.to),
    mediaCount: mediaUrls.length,
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
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
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

      const result = await sendWithConfig({
        config: account.config,
        accountId: account.accountId,
        accountSid: account.accountSid,
        authToken: account.authToken,
        to,
        text: text || '',
        mediaUrls: mediaUrl ? [mediaUrl] : undefined,
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

        if (!channelCfg?.enabled) return { status: 'not-configured' };
        if (!channelCfg.webhookUrl) return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.webhookUrl' };
        const accountIds = listTwilioAccountIds(cfg);
        if (accountIds.length === 0) {
          return { status: 'not-configured', hint: 'Set channels.twilio-whatsapp.accounts.<accountId>.fromNumber' };
        }
        for (const accountId of accountIds) {
          const accountCfg = resolveMergedAccountConfig(channelCfg, accountId);
          if (accountCfg?.enabled === false) continue;
          if (!accountCfg?.fromNumber) {
            return { status: 'not-configured', hint: `Set channels.twilio-whatsapp.accounts.${accountId}.fromNumber` };
          }
          const credentialHint = credentialConfigurationHint(accountId, accountCfg);
          if (credentialHint) {
            return { status: 'not-configured', hint: credentialHint };
          }
          const dmPolicy = resolveDmPolicy(accountCfg);
          const allowFrom = accountCfg.allowFrom || [];
          if (
            (dmPolicy === 'allowlist' && allowFrom.length === 0) ||
            (dmPolicy === 'open' && !allowFrom.includes('*'))
          ) {
            return {
              status: 'not-configured',
              hint:
                dmPolicy === 'open'
                  ? `Set channels.twilio-whatsapp.accounts.${accountId}.allowFrom to ["*"]`
                  : `Set channels.twilio-whatsapp.accounts.${accountId}.allowFrom`,
            };
          }
        }
        return { status: 'configured' };
      },
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
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
        const { fromNumber } = account.config;

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

        const started: StartedTwilioAccount = {
          account,
          ctx,
          webhookAccount: createWebhookAccountConfig(account, inboundDir),
        };
        startedTwilioAccounts.set(account.accountId, started);

        const dispatch = async (msg: InboundMessage) => {
          const active = startedTwilioAccounts.get(msg.accountId);
          if (!active) {
            throw new Error(`Twilio WhatsApp account "${msg.accountId}" is not running`);
          }
          const { account, ctx } = active;
          const { accountSid, authToken } = account;
          const runtime = getTwilioWhatsAppRuntime();
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: CHANNEL_KEY,
            accountId: account.accountId,
            peer: { kind: 'direct', id: msg.senderId },
          });
          const currentSessionKey = route.sessionKey;
          const sendTwilioReply = async (
            payload: TwilioReplyPayload,
            kind: TwilioSendTimingContext['kind'] = 'final_reply',
          ) => {
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
            const content = normalizeWhatsAppText(payload.text);
            try {
              const result = await sendWithConfig({
                config: account.config,
                accountId: account.accountId,
                accountSid,
                authToken,
                to: msg.senderId,
                text: content,
                mediaUrls: payload.mediaUrls,
                timing: {
                  log: ctx.log,
                  kind,
                  sessionKey: currentSessionKey,
                  messageSid: msg.messageSid,
                },
              });
              const messageId = result.messageIds[0] || '';
              if (kind === 'final_reply') {
                emitTwilioWhatsAppMessageSentHook({
                  to: msg.senderId,
                  content,
                  success: true,
                  accountId: account.accountId,
                  messageId,
                  sessionKey: currentSessionKey,
                });
              }
              return {
                messageId,
                receipt: createMessageReceiptFromOutboundResults({
                  results: result.messageIds.map((sentMessageId) => ({
                    channel: 'twilio-whatsapp',
                    messageId: sentMessageId,
                  })),
                  kind: payload.mediaUrls.length > 0 ? 'media' : 'text',
                }),
              };
            } catch (error) {
              if (kind === 'final_reply') {
                emitTwilioWhatsAppMessageSentHook({
                  to: msg.senderId,
                  content,
                  success: false,
                  error: String(error),
                  accountId: account.accountId,
                  sessionKey: currentSessionKey,
                });
              }
              throw error;
            }
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
            send: (text) => sendTwilioReply({ text, mediaUrls: [] }, 'processing_ack'),
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
              runtime,
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
              extraContext: buildTwilioInboundExtraContext(msg),
              deliver: async (payload) => {
                const reply = normalizeTwilioReplyPayload(payload);
                return reply ? sendTwilioReply(reply, 'final_reply') : {};
              },
            });

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

        const logger = sharedWebhookLogger();
        let releaseSharedRoutes: () => void;
        try {
          releaseSharedRoutes = sharedRouteLifecycle.acquire({
            inbound: createWebhookHandler(
              {
                webhookPaths: [...INBOUND_WEBHOOK_PATHS],
                accounts: activeWebhookAccounts,
                log: logger,
              },
              dispatch,
            ),
            status: createStatusCallbackHandler({
              accounts: activeWebhookAccounts,
              log: logger,
            }),
            media: createMediaServeHandler(outboundDir),
            health: createHealthHandler(),
          });
        } catch (error) {
          if (startedTwilioAccounts.get(account.accountId) === started) {
            startedTwilioAccounts.delete(account.accountId);
          }
          throw error;
        }

        ctx.log?.info(`[${account.accountId}] Twilio WhatsApp channel started (from=${stableIdHash(fromNumber)})`);

        if (ctx.abortSignal && !ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal!.addEventListener('abort', () => resolve(), { once: true });
          });
        }

        if (startedTwilioAccounts.get(account.accountId) === started) {
          startedTwilioAccounts.delete(account.accountId);
        }
        releaseSharedRoutes();
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
