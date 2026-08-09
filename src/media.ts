import fs from 'fs';
import https from 'https';
import path from 'path';
import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import mime from 'mime-types';

export function downloadTwilioMedia(
  url: string,
  accountSid: string,
  authToken: string,
  options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const initialUrl = new URL(url);
    const auth = `${accountSid}:${authToken}`;
    const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxRedirects = options.maxRedirects ?? 5;

    const get = (targetUrl: string, redirects = 0) => {
      const parsedUrl = new URL(targetUrl, initialUrl);
      if (parsedUrl.protocol !== 'https:') {
        reject(new Error(`Unsupported media redirect protocol: ${parsedUrl.protocol}`));
        return;
      }
      const request = https.get(parsedUrl, { ...(parsedUrl.host === initialUrl.host ? { auth } : {}) }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= maxRedirects) {
            reject(new Error(`Too many redirects downloading media`));
            return;
          }
          get(new URL(res.headers.location, parsedUrl).toString(), redirects + 1);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading media`));
          return;
        }
        const contentLength = Number(res.headers['content-length'] || 0);
        if (contentLength > maxBytes) {
          res.resume();
          reject(new Error(`Media exceeds maximum size (${contentLength} > ${maxBytes})`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy(new Error(`Media exceeds maximum size (${received} > ${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`Timed out downloading media after ${timeoutMs}ms`)));
      request.on('error', reject);
    };
    get(url, 0);
  });
}

export function stageMedia(
  localPath: string,
  outboundDir: string,
  webhookUrl: string,
): string | null {
  const srcPath = path.resolve(localPath);
  const publicBaseUrl = webhookUrl.replace(/\/+$/, '');
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    return null;
  }
  if (path.dirname(srcPath) === path.resolve(outboundDir)) {
    return `${publicBaseUrl}/webhook/twilio-whatsapp/media/${path.basename(srcPath)}`;
  }
  const ext = path.extname(srcPath);
  const filename = `${crypto.randomUUID().replace(/-/g, '')}${ext}`;
  const destPath = path.join(outboundDir, filename);
  fs.copyFileSync(srcPath, destPath);
  return `${publicBaseUrl}/webhook/twilio-whatsapp/media/${filename}`;
}

export function createMediaServeHandler(outboundDir: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    if (!filename) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const filePath = path.resolve(outboundDir, filename);
    if (path.dirname(filePath) !== path.resolve(outboundDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentType = mime.lookup(filePath) || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  };
}

export function getExtensionForType(contentType: string): string {
  const ext = mime.extension(contentType);
  return ext ? `.${ext}` : '.bin';
}
