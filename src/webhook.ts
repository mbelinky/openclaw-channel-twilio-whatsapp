import fs from 'fs';
import path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import twilio from 'twilio';
import {
  parseFormBody,
  collectRequestBody,
  toWhatsAppId,
  fromWhatsAppId,
  stableIdHash,
  isRequestBodyTooLargeError,
} from './util.js';
import { downloadTwilioMedia, getExtensionForType } from './media.js';
import { emitTimingEvent, logTiming } from './diagnostics.js';

export interface WebhookConfig {
  accountSid: string;
  authToken: string;
  webhookUrl: string;
  webhookPaths?: string[];
  bodyMaxBytes?: number;
  accounts: WebhookAccountConfig[];
  log?: WebhookLogger;
}

const DEFAULT_WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

export interface WebhookAccountConfig {
  accountId: string;
  fromNumber: string;
  statusCallbackUrl?: string;
  dmPolicy?: 'allowlist' | 'open';
  allowFrom: Set<string>;
  inboundDir: string;
  mediaMaxBytes?: number;
  mediaTimeoutMs?: number;
  typingIndicators?: boolean;
  typingTimeoutMs?: number;
  sendTypingIndicator?: (messageSid: string) => Promise<boolean>;
}

export interface InboundMessage {
  accountId: string;
  senderId: string;
  senderName: string;
  text: string;
  messageSid: string;
  mediaPath?: string;
  mediaPaths?: string[];
  dryRunDelivery?: boolean;
}

export type DispatchFn = (msg: InboundMessage, account: WebhookAccountConfig) => Promise<void> | void;

export interface WebhookLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function requestQuery(req: IncomingMessage): string {
  const url = req.url || '';
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(index) : '';
}

function forwardedUrl(req: IncomingMessage, routePath: string): string | null {
  const proto = firstHeader(req.headers['x-forwarded-proto']).split(',')[0]?.trim();
  const host = (firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host))
    .split(',')[0]
    ?.trim();
  if (!proto || !host) return null;
  return `${proto}://${host}${routePath}${requestQuery(req)}`;
}

function validateTwilioSignature(
  req: IncomingMessage,
  params: Record<string, string>,
  authToken: string,
  webhookUrl: string,
  routePath: string | string[],
  signedUrl?: string | string[],
): boolean {
  const signature = firstHeader(req.headers['x-twilio-signature']);
  const candidates = new Set<string>();
  const routePaths = Array.isArray(routePath) ? routePath : [routePath];
  for (const path of routePaths) {
    candidates.add(`${normalizeBaseUrl(webhookUrl)}${path}${requestQuery(req)}`);
    const forwarded = forwardedUrl(req, path);
    if (forwarded) candidates.add(forwarded);
  }
  for (const url of Array.isArray(signedUrl) ? signedUrl : signedUrl ? [signedUrl] : []) {
    candidates.add(`${url.replace(/\?.*$/, '')}${requestQuery(req)}`);
  }
  for (const candidate of candidates) {
    if (twilio.validateRequest(authToken, signature || '', candidate, params)) {
      return true;
    }
  }
  return false;
}

function isSenderAllowed(config: Pick<WebhookAccountConfig, 'dmPolicy' | 'allowFrom'>, senderPhone: string): boolean {
  if (config.dmPolicy === 'open') return true;
  return config.allowFrom.has(senderPhone);
}

function findAccountByRecipient(
  accounts: WebhookAccountConfig[],
  recipient: string,
): WebhookAccountConfig | undefined {
  const recipientPhone = fromWhatsAppId(recipient).replace(/^\+?/, '+');
  return accounts.find((account) => fromWhatsAppId(account.fromNumber).replace(/^\+?/, '+') === recipientPhone);
}

export function createWebhookHandler(config: WebhookConfig, dispatch: DispatchFn) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    let acked = false;
    logTiming(config.log, 'webhook_received', { route: 'inbound' });
    try {
      const body = await collectRequestBody(req, {
        maxBytes: config.bodyMaxBytes ?? DEFAULT_WEBHOOK_BODY_MAX_BYTES,
      });
      const params = parseFormBody(body);
      const messageSid = params.MessageSid || '';
      const bodyText = params.Body || '';
      const from = params.From || '';
      const to = params.To || '';
      const senderPhone = fromWhatsAppId(from);
      const senderHash = senderPhone ? stableIdHash(senderPhone) : undefined;
      const numMedia = parseInt(params.NumMedia || '0', 10);
      const parseDurationMs = Date.now() - startedAt;
      logTiming(config.log, 'webhook_parsed', {
        messageSid,
        senderHash,
        bytes: body.length,
        mediaCount: Number.isFinite(numMedia) ? numMedia : 0,
        durationMs: parseDurationMs,
      });
      emitTimingEvent({
        type: 'webhook.received',
        channel: 'twilio-whatsapp',
        updateType: 'inbound',
        chatId: senderHash,
      });

      const valid = validateTwilioSignature(
        req,
        params,
        config.authToken,
        config.webhookUrl,
        config.webhookPaths || ['/webhook/twilio-whatsapp'],
      );
      if (!valid) {
        logTiming(config.log, 'webhook_rejected', {
          messageSid,
          senderHash,
          reason: 'invalid_signature',
          durationMs: Date.now() - startedAt,
        });
        emitTimingEvent({
          type: 'webhook.error',
          channel: 'twilio-whatsapp',
          updateType: 'inbound',
          chatId: senderHash,
          error: 'invalid_signature',
        });
        res.writeHead(403);
        res.end('Invalid signature');
        return;
      }

      const account = to ? findAccountByRecipient(config.accounts, to) : undefined;
      if (!from || !to || !account) {
        logTiming(config.log, 'webhook_rejected', {
          messageSid,
          senderHash,
          reason: account ? 'forbidden' : 'unknown_recipient',
          durationMs: Date.now() - startedAt,
        });
        emitTimingEvent({
          type: 'webhook.error',
          channel: 'twilio-whatsapp',
          updateType: 'inbound',
          chatId: senderHash,
          error: account ? 'forbidden' : 'unknown_recipient',
        });
        if (!account && to) {
          config.log?.warn?.(
            `[twilio-whatsapp] inbound rejected unknown To=${stableIdHash(fromWhatsAppId(to))} messageSid=${
              messageSid || 'unknown'
            }`,
          );
        }
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!isSenderAllowed(account, senderPhone)) {
        logTiming(config.log, 'webhook_rejected', {
          messageSid,
          senderHash,
          accountId: account.accountId,
          reason: 'forbidden',
          durationMs: Date.now() - startedAt,
        });
        emitTimingEvent({
          type: 'webhook.error',
          channel: 'twilio-whatsapp',
          updateType: 'inbound',
          chatId: senderHash,
          error: 'forbidden',
        });
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');
      acked = true;
      logTiming(config.log, 'webhook_ack', {
        messageSid,
        senderHash,
        durationMs: Date.now() - startedAt,
      });

      const profileName = params.ProfileName || senderPhone;
      const dryRunDelivery = firstHeader(req.headers['x-openclaw-dry-run-delivery']) === '1';

      if (account.typingIndicators === true && messageSid && account.sendTypingIndicator) {
        const typingStartedAt = Date.now();
        logTiming(config.log, 'typing_start', { messageSid, senderHash, accountId: account.accountId });
        account.sendTypingIndicator(messageSid).then((ok) => {
          logTiming(config.log, ok ? 'typing_done' : 'typing_error', {
            messageSid,
            senderHash,
            accountId: account.accountId,
            durationMs: Date.now() - typingStartedAt,
          });
          if (!ok) {
            config.log?.warn?.(
              `[twilio-whatsapp] typing indicator failed messageSid=${messageSid}`,
            );
          }
        }).catch((error) => {
          logTiming(config.log, 'typing_error', {
            messageSid,
            senderHash,
            accountId: account.accountId,
            durationMs: Date.now() - typingStartedAt,
            error: error instanceof Error ? error.name || 'Error' : 'unknown',
          });
          config.log?.warn?.(
            `[twilio-whatsapp] typing indicator failed messageSid=${messageSid} error=${String(
              error instanceof Error ? error.message : error,
            )}`,
          );
        });
      }

      let content = bodyText;
      const mediaPaths: string[] = [];

      if (numMedia > 0) {
        for (let i = 0; i < numMedia; i++) {
          const mediaUrl = params[`MediaUrl${i}`];
          const contentType = params[`MediaContentType${i}`] || 'application/octet-stream';
          if (mediaUrl) {
            const mediaStartedAt = Date.now();
            logTiming(config.log, 'media_download_start', {
              messageSid,
              senderHash,
              mediaIndex: i,
            });
            try {
              const buffer = await downloadTwilioMedia(mediaUrl, config.accountSid, config.authToken, {
                maxBytes: account.mediaMaxBytes,
                timeoutMs: account.mediaTimeoutMs,
              });
              const ext = getExtensionForType(contentType);
              const filePath = path.join(account.inboundDir, `${messageSid}-${i}${ext}`);
              fs.writeFileSync(filePath, buffer);
              mediaPaths.push(filePath);
              content += `\n[${contentType}: ${filePath}]`;
              logTiming(config.log, 'media_download_done', {
                messageSid,
                senderHash,
                mediaIndex: i,
                bytes: buffer.length,
                durationMs: Date.now() - mediaStartedAt,
              });
            } catch (error) {
              logTiming(config.log, 'media_download_error', {
                messageSid,
                senderHash,
                mediaIndex: i,
                durationMs: Date.now() - mediaStartedAt,
                error: error instanceof Error ? error.name || 'Error' : 'unknown',
              });
              config.log?.warn?.(
                `[twilio-whatsapp] media download failed messageSid=${messageSid || 'unknown'} index=${i} error=${String(
                  error instanceof Error ? error.message : error,
                )}`,
              );
              content += `\n[media: ${contentType} (download failed)]`;
            }
          }
        }
      }

      if (!content.trim()) {
        content = '(empty message)';
      }

      try {
        const dispatchScheduledAt = Date.now();
        logTiming(config.log, 'dispatch_scheduled', { messageSid, senderHash });
        const dispatchResult = dispatch({
          accountId: account.accountId,
          senderId: senderPhone,
          senderName: profileName,
          text: content.trim(),
          messageSid,
          mediaPath: mediaPaths[0],
          mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
          dryRunDelivery,
        }, account);
        if (dispatchResult && typeof dispatchResult.then === 'function') {
          dispatchResult.then(
            () => {
              logTiming(config.log, 'dispatch_settled', {
                messageSid,
                senderHash,
                durationMs: Date.now() - dispatchScheduledAt,
              });
            },
            (error) => {
              logTiming(config.log, 'dispatch_settled_error', {
                messageSid,
                senderHash,
                durationMs: Date.now() - dispatchScheduledAt,
                error: error instanceof Error ? error.name || 'Error' : 'unknown',
              });
              config.log?.error?.(
                `[twilio-whatsapp] dispatch failed messageSid=${messageSid || 'unknown'} error=${String(
                  error instanceof Error ? error.message : error,
                )}`,
              );
            },
          );
        }
        const durationMs = Date.now() - startedAt;
        logTiming(config.log, 'webhook_processed', {
          messageSid,
          senderHash,
          durationMs,
        });
        emitTimingEvent({
          type: 'webhook.processed',
          channel: 'twilio-whatsapp',
          updateType: 'inbound',
          chatId: senderHash,
          durationMs,
        });
      } catch (error) {
        logTiming(config.log, 'dispatch_schedule_error', {
          messageSid,
          senderHash,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.name || 'Error' : 'unknown',
        });
        config.log?.error?.(
          `[twilio-whatsapp] dispatch failed messageSid=${messageSid || 'unknown'} error=${String(
            error instanceof Error ? error.message : error,
          )}`,
        );
      }
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        logTiming(config.log, 'webhook_rejected', {
          reason: 'body_too_large',
          durationMs: Date.now() - startedAt,
        });
        if (!acked) {
          res.writeHead(413);
          res.end('Request Entity Too Large');
        }
        return;
      }
      if (acked) {
        logTiming(config.log, 'webhook_post_ack_error', {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.name || 'Error' : 'unknown',
        });
        config.log?.error?.(
          `[twilio-whatsapp] post-ack webhook failure error=${String(
            error instanceof Error ? error.message : error,
          )}`,
        );
        return;
      }
      logTiming(config.log, 'webhook_error', {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.name || 'Error' : 'unknown',
      });
      emitTimingEvent({
        type: 'webhook.error',
        channel: 'twilio-whatsapp',
        updateType: 'inbound',
        error: error instanceof Error ? error.name || 'Error' : 'unknown',
      });
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  };
}

export function createStatusCallbackHandler(
  config: Pick<WebhookConfig, 'authToken' | 'webhookUrl' | 'bodyMaxBytes' | 'accounts' | 'log'>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await collectRequestBody(req, {
        maxBytes: config.bodyMaxBytes ?? DEFAULT_WEBHOOK_BODY_MAX_BYTES,
      });
      const params = parseFormBody(body);
      const valid = validateTwilioSignature(
        req,
        params,
        config.authToken,
        config.webhookUrl,
        '/webhook/twilio-whatsapp/status',
        config.accounts.map((account) => account.statusCallbackUrl).filter(Boolean) as string[],
      );
      if (!valid) {
        res.writeHead(403);
        res.end('Invalid signature');
        return;
      }
      const messageSid = params.MessageSid || 'unknown';
      const status = params.MessageStatus || params.SmsStatus || 'unknown';
      const errorCode = params.ErrorCode;
      const errorMessage = params.ErrorMessage;
      const query = new URLSearchParams(requestQuery(req).replace(/^\?/, ''));
      const accountIdFromQuery = query.get('accountId') || undefined;
      const account =
        (accountIdFromQuery
          ? config.accounts.find((entry) => entry.accountId === accountIdFromQuery)
          : undefined) || findAccountByRecipient(config.accounts, params.From || '');
      const accountField = account ? ` accountId=${account.accountId}` : ' accountId=unknown';
      const line = `[twilio-whatsapp] status${accountField} messageSid=${messageSid} status=${status}${
        errorCode ? ` errorCode=${errorCode}` : ''
      }${errorMessage ? ` error=${errorMessage}` : ''}`;
      if (status === 'failed' || status === 'undelivered') {
        config.log?.error?.(line);
      } else {
        config.log?.info?.(line);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        res.writeHead(413);
        res.end('Request Entity Too Large');
        return;
      }
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  };
}

export function createHealthHandler() {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', channel: 'twilio-whatsapp' }));
  };
}
