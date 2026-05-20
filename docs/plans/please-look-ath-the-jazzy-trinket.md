# Plan: Chunk long outbound WhatsApp replies + surface delivery failures

## Context

Bug report: [docs/BUG-chunk-long-replies.md](../BUG-chunk-long-replies.md).

Any agent reply longer than Twilio's **1600-char** WhatsApp limit is sent as a single
oversized body. Twilio rejects it with **error 21617** and the reply is **silently lost**
— the user sees nothing and the gateway logs only `dispatched` with no error.

Two defects:
1. **No chunking.** Long bodies are passed whole to `client.messages.create`.
2. **Silent failure.** The Twilio API error is not surfaced/logged.

The plugin's programmatic `outbound.textChunkLimit` / `outbound.chunker` settings are **not**
honored by the gateway for the result-adapter / inbound-deliver paths (the gateway reads
the chunk limit from *resolved channel config*, exposed via the manifest schema — which the
twilio-whatsapp channel does not declare). So the fix self-chunks at the actual send sites.

**Key finding beyond the bug report:** there are **three** un-chunked `client.messages.create`
call sites in [src/channel.ts](../../src/channel.ts), and the one that actually handled the
reported scenario (an agent reply to an inbound WhatsApp DM) is the inbound `deliver` path
(`sendTwilioReply`), not the outbound adapter the report focused on.

**Chosen approach (confirmed with user): B + C + A**, shipped as version **2.1.4**.

## Send sites to fix (all in `src/channel.ts`)

1. `sendTwilioReply` — inbound DM auto-reply, used by the `deliver` callback ([channel.ts:138-146](../../src/channel.ts#L138-L146)).
2. `outbound.sendText` — result-adapter handler ([channel.ts:250-265](../../src/channel.ts#L250-L265)).
3. `outbound.sendMedia` — result-adapter handler, sends body as caption + optional media ([channel.ts:266-291](../../src/channel.ts#L266-L291)).

## Changes

### 1. Shared helper in `src/channel.ts`

Add a top-level helper (all three callers live in this file; no new module needed). Reuse the
already-imported `chunkText` ([channel.ts:7](../../src/channel.ts#L7)) and the existing
`TWILIO_MAX_MESSAGE_LEN = 1600` constant ([channel.ts:17](../../src/channel.ts#L17)).

```ts
type TwilioClient = ReturnType<typeof twilio>;

function resolveLogger() {
  // getTwilioWhatsAppRuntime() throws if uninitialized — wrap it.
  try {
    return getTwilioWhatsAppRuntime()?.logging?.getChildLogger?.({ plugin: 'twilio-whatsapp' });
  } catch {
    return undefined; // fall back to console
  }
}

async function sendChunkedWhatsApp(args: {
  client: TwilioClient;
  from: string;        // already toWhatsAppId()-normalized
  to: string;          // already toWhatsAppId()-normalized
  text?: string;
  mediaUrl?: string;   // attaches to exactly ONE message (the first)
}): Promise<{ messageId?: string }> {
  const { client, from, to, text, mediaUrl } = args;
  const log = resolveLogger();
  const chunks = chunkText((text ?? '').trim(), TWILIO_MAX_MESSAGE_LEN).filter((c) => c.length > 0);

  if (chunks.length === 0 && !mediaUrl) return {};       // nothing to send
  if (chunks.length === 0 && mediaUrl) chunks.push('');  // media-only message

  let firstSid: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const attachMedia = mediaUrl && i === 0;
    try {
      const result = await client.messages.create({
        from, to, body: chunks[i],
        ...(attachMedia ? { mediaUrl: [mediaUrl] } : {}),
      });
      if (i === 0) firstSid = result.sid;
      if (result.status === 'failed' || result.status === 'undelivered') {
        (log ?? console).error(
          `[twilio-whatsapp] chunk ${i + 1}/${chunks.length} status=${result.status} ` +
          `code=${result.errorCode} sid=${result.sid}`);
        throw new Error(`Twilio message ${result.sid} ${result.status} (code ${result.errorCode})`);
      }
    } catch (err) {
      (log ?? console).error(
        `[twilio-whatsapp] failed sending chunk ${i + 1}/${chunks.length} ` +
        `to=${to} len=${chunks[i].length}: ${(err as Error).message}`);
      throw err; // rethrow → gateway sees the failure (fixes silent loss)
    }
  }
  return { messageId: firstSid };
}
```

Decisions:
- **Empty/whitespace text → send nothing.** Media-only still sends one message (body `''`).
- **Return the first chunk's sid** (head of the reply; for media it's the media-bearing message).
- Short text → `chunkText` returns one element → single `create`, identical to today.
- **Error handling covers both forms** of bug-report open-question #2: a thrown 400 (try/catch)
  and an async `failed`/`undelivered` status (the `status` check).

### 2. Refactor the three call sites to use the helper

- **Site 1** `sendTwilioReply`: keep `twilio(accountSid, authToken)`, then
  `return sendChunkedWhatsApp({ client, from: toWhatsAppId(fromNumber), to: toWhatsAppId(msg.senderId), text });`
- **Site 2** `outbound.sendText`: keep config/credential guards; replace the `create` block with
  `return sendChunkedWhatsApp({ client, from: toWhatsAppId(channelCfg.fromNumber), to: toWhatsAppId(to), text });`
- **Site 3** `outbound.sendMedia`: keep the `stageMedia` staging block; replace the `create` block with
  `return sendChunkedWhatsApp({ client, from, to: toWa, text, mediaUrl: stagedUrl ?? undefined });`

**Media + long-caption ordering:** media on the **first** message, remaining caption chunks as
plain text after it. Chunk[0] is already ≤1600, so the media message's caption is in-limit; the
image/file appears first and overflow reads top-to-bottom.

### 3. Manifest schema (approach A) — `openclaw.plugin.json`

Add to `channelConfigs.twilio-whatsapp.schema.properties` (aligns with the telegram pattern so the
gateway's native chunker also splits before `sendText` — composes safely with self-chunking, no
double-send because each pre-chunked piece is already ≤ limit):

```jsonc
"textChunkLimit": { "type": "number", "default": 1600,
  "description": "Max characters per outbound WhatsApp message before splitting." },
"chunkMode": { "type": "string", "enum": ["length", "newline"], "default": "length",
  "description": "Split long replies on length, or prefer paragraph boundaries." }
```

### 4. Version bump → **2.1.4** (sync both files; they are currently drifted)

- [package.json](../../package.json): `2.1.3` → `2.1.4`
- [openclaw.plugin.json](../../openclaw.plugin.json): manifest version `2.1.1` → `2.1.4`

## Files modified

- `src/channel.ts` — add `sendChunkedWhatsApp` + `resolveLogger`; refactor 3 send sites.
- `openclaw.plugin.json` — add `textChunkLimit`/`chunkMode` to schema; bump version to `2.1.4`.
- `package.json` — bump version to `2.1.4`.

## Verification

No test framework exists (`package.json` scripts = only `build: tsc`).

1. **`npm run build`** — primary gate: confirms the helper signature, `ReturnType<typeof twilio>`
   client type, and the three refactors compile.
2. **Logic check with a fake client** (standalone `node` script against `dist`, or as a follow-up
   adding a real test runner): stub `messages.create` to record calls / return `{ sid, status }`
   and assert: (a) short text → 1 call; (b) >1600 text → N calls each ≤1600, order preserved;
   (c) empty + no media → 0 calls, returns `{}`; (d) media + long text → media on call #0 only;
   (e) `create` rejects → helper logs and rethrows.
3. **Optional Twilio sandbox smoke** (needs sandbox creds): send a prompt that yields a >1600-char
   reply; confirm it arrives as multiple `delivered` messages and 21617 is gone.

Per global rules: work on the current `bugfix/chunk-long-replies` branch and commit when done.
