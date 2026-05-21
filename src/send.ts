import twilio from 'twilio';
import { toWhatsAppId } from './util.js';
import { normalizeWhatsAppText, splitWhatsAppText } from './text.js';

export type TwilioMessageClient = ReturnType<typeof twilio>;

export interface TwilioSendOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  text: string;
  mediaUrls?: string[];
  statusCallbackUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  chunkLimit?: number;
  createClient?: (accountSid: string, authToken: string) => TwilioMessageClient;
  sleep?: (ms: number) => Promise<void>;
}

export interface TwilioSendReceipt {
  messageIds: string[];
  payloadCount: number;
}

type TwilioSendPayload = {
  body: string;
  mediaUrl?: string[];
};

class TwilioSendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Twilio send timed out after ${timeoutMs}ms`);
    this.name = 'TwilioSendTimeoutError';
  }
}

function isRetryableSendError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const status = Number(
      (error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { status?: unknown; statusCode?: unknown }).statusCode,
    );
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }
  return false;
}

function assertMessageAccepted(message: { sid?: string; status?: string; errorCode?: string | number | null }) {
  if (message.status === 'failed' || message.status === 'undelivered') {
    throw new Error(
      `Twilio message ${message.sid || 'unknown'} ${message.status}${
        message.errorCode ? ` (code ${message.errorCode})` : ''
      }`,
    );
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new TwilioSendTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function sendTwilioWhatsAppMessages(options: TwilioSendOptions): Promise<TwilioSendReceipt> {
  const client = (options.createClient || twilio)(options.accountSid, options.authToken);
  const normalizedText = normalizeWhatsAppText(options.text);
  const chunks = splitWhatsAppText(normalizedText, options.chunkLimit);
  const hasMedia = Boolean(options.mediaUrls?.length);
  const payloads: TwilioSendPayload[] = hasMedia
    ? [
        ...(normalizedText.trim() ? chunks.map((chunk) => ({ body: chunk })) : []),
        { body: '', mediaUrl: options.mediaUrls },
      ]
    : chunks.map((chunk) => ({ body: chunk }));
  const messageIds: string[] = [];
  const attempts = Math.max(1, Math.floor(options.maxRetries ?? 3));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (const item of payloads) {
    const payload = {
      from: toWhatsAppId(options.fromNumber),
      to: toWhatsAppId(options.toNumber),
      body: item.body,
      ...(options.statusCallbackUrl ? { statusCallback: options.statusCallbackUrl } : {}),
      ...(item.mediaUrl?.length ? { mediaUrl: item.mediaUrl } : {}),
    };

    let sent = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const message = await withTimeout(client.messages.create(payload), timeoutMs);
        assertMessageAccepted(message);
        if (message?.sid) messageIds.push(message.sid);
        sent = true;
        break;
      } catch (error) {
        if (!isRetryableSendError(error) || attempt === attempts - 1) {
          throw error;
        }
        await sleep(2 ** (attempt + 1) * 1000);
      }
    }
    if (!sent) {
      throw new Error('Twilio send failed without a terminal error');
    }
  }

  return { messageIds, payloadCount: payloads.length };
}
