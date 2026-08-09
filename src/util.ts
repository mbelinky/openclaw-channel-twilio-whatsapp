import { IncomingMessage } from 'http';
import crypto from 'crypto';

export class RequestBodyTooLargeError extends Error {
  statusCode = 413;

  constructor(maxBytes: number) {
    super(`Request body exceeds maximum size (${maxBytes} bytes)`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export function toWhatsAppId(e164: string): string {
  const trimmed = e164.trim();
  return trimmed.toLowerCase().startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`;
}

export function fromWhatsAppId(waId: string): string {
  return waId.trim().replace(/^whatsapp:/i, '');
}

export function parseFormBody(body: Buffer): Record<string, string> {
  const params = new URLSearchParams(body.toString('utf-8'));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

export function isRequestBodyTooLargeError(error: unknown): error is RequestBodyTooLargeError {
  return error instanceof RequestBodyTooLargeError;
}

export function collectRequestBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const maxBytes = options.maxBytes;
    let received = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (maxBytes !== undefined && received > maxBytes) {
        const error = new RequestBodyTooLargeError(maxBytes);
        req.pause();
        req.destroy(error);
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

export function stableIdHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}
