import fs from 'fs';
import https from 'https';
import path from 'path';
import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import mime from 'mime-types';
import { diagFlagEnabled, DIAG_STAGE } from './diag.js';

function diagStage(event: string, data?: unknown): void {
  if (!diagFlagEnabled(DIAG_STAGE)) return;
  if (data === undefined) {
    console.error(`[twilio-whatsapp][stageMedia] ${event}`);
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(data);
    } catch {
      serialized = '[unserializable diagnostic payload]';
    }
    console.error(`[twilio-whatsapp][stageMedia] ${event} ${serialized}`);
  }
}

export function downloadTwilioMedia(
  url: string,
  accountSid: string,
  authToken: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const auth = `${accountSid}:${authToken}`;
    const get = (targetUrl: string) => {
      https.get(targetUrl, { auth }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading media`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
    };
    get(url);
  });
}

export function stageMedia(
  localPath: string,
  outboundDir: string,
  webhookUrl: string,
): string | null {
  diagStage('entry', { localPath, outboundDir, webhookUrl });
  const srcPath = path.resolve(localPath);
  diagStage('resolved', { srcPath });
  const exists = fs.existsSync(srcPath);
  if (diagFlagEnabled(DIAG_STAGE)) {
    let isFile: boolean | null = null;
    if (exists) {
      try { isFile = fs.statSync(srcPath).isFile(); } catch { /* ignore */ }
    }
    diagStage('exists-check', { exists, _diag_isFile: isFile });
  }
  if (!exists || !fs.statSync(srcPath).isFile()) {
    return null;
  }
  if (path.dirname(srcPath) === path.resolve(outboundDir)) {
    diagStage('same-dir-passthrough', { srcPath });
    return `${webhookUrl}/webhook/twilio-whatsapp/media/${path.basename(srcPath)}`;
  }
  const ext = path.extname(srcPath);
  const filename = `${crypto.randomUUID().replace(/-/g, '')}${ext}`;
  const destPath = path.join(outboundDir, filename);
  diagStage('destPath', { destPath });
  diagStage('copying');
  try {
    fs.copyFileSync(srcPath, destPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    diagStage('copy-failed', {
      code: e.code ?? null,
      errno: e.errno ?? null,
      syscall: e.syscall ?? null,
      path: (e as { path?: string }).path ?? null,
      message: e.message,
    });
    throw err;
  }
  diagStage('copied');
  return `${webhookUrl}/webhook/twilio-whatsapp/media/${filename}`;
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
