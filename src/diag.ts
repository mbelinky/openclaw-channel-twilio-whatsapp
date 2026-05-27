// OPENCLAW_DIAGNOSTICS flag matcher — case-insensitive, supports `*`, `1`, `all`,
// exact tokens (`twilio-whatsapp.send`), and `.*` suffix wildcards
// (`twilio-whatsapp.*` matches `twilio-whatsapp.send`). `0` or empty disables.
export function diagFlagEnabled(flag: string): boolean {
  const raw = (process.env.OPENCLAW_DIAGNOSTICS ?? '').trim();
  if (!raw || raw === '0') return false;
  const wanted = flag.toLowerCase();
  for (const tok of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (tok === '*' || tok === '1' || tok === 'all') return true;
    if (tok === wanted) return true;
    if (tok.endsWith('.*') && wanted.startsWith(tok.slice(0, -1))) return true;
  }
  return false;
}

export const DIAG_SEND = 'twilio-whatsapp.send';
export const DIAG_STAGE = 'twilio-whatsapp.stage';
export const DIAG_BOOT = 'twilio-whatsapp.boot';

// Best-effort structured log: SDK `ctx.log` accepts a string, so we serialize
// the data object into the message. Falls back to console.error if no logger.
export function diagLog(ctx: unknown, msg: string, data?: unknown): void {
  let payload = msg;
  if (data !== undefined) {
    try {
      payload = `${msg} ${JSON.stringify(data)}`;
    } catch {
      payload = `${msg} [unserializable diagnostic payload]`;
    }
  }
  const log = (ctx as { log?: { info?: (m: string) => void } } | undefined)?.log;
  if (typeof log?.info === 'function') {
    log.info(payload);
  } else {
    console.error(payload);
  }
}
