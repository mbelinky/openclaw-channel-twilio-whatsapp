# Bug: long replies (>1600 chars) are not chunked → Twilio rejects (21617), reply silently lost

**Repo:** `@srinathh/openclaw-channel-twilio-whatsapp` (observed v2.1.3)
**Severity:** High — any agent reply >1600 chars is silently dropped; the user sees no response, and no error appears in gateway logs.
**Not a forge/model issue.** Diagnosed during the forge-proxy cutover; the model produced a correct reply through `vllm/local-primary`. The failure is purely outbound delivery.

## Summary

Outbound text longer than Twilio's 1600-char WhatsApp limit is sent to Twilio as a **single oversized body**. Twilio rejects it with **error 21617** ("message body exceeds 1600 characters"). The plugin *intends* to delegate chunking to the gateway (`outbound.deliveryMode: 'gateway'` + `textChunkLimit: 1600` + `chunker: chunkText`), but that delegation never takes effect, so no split happens.

## Environment

- Gateway image `2026.5.7` (ARM64).
- Plugin dist v2.1.3; `openclaw.plugin.json` declares manifest version `2.1.1`.
- `openclaw/plugin-sdk/reply-chunking` **is** present and exported in the gateway image (`./plugin-sdk/reply-chunking` → `dist/plugin-sdk/reply-chunking.js`), so `chunkText` resolves correctly. The import is **not** the problem (rules out the v2.1.0-style SDK-missing-module class of bug).

## Evidence

**Twilio Messages API** (authoritative — outbound delivery status):

| Time (UTC) | Body | Status |
|---|---|---|
| 14:36:44 | `/status` reply (short) | **delivered** |
| 14:33:27 | `Here are the skills I have available: …` (**1912 chars**) | **failed, error_code 21617** |
| 14:31:18 | `/status` reply (short) | delivered |
| 14:31:03 | skills reply (retry, 1912 chars) | **failed, 21617** |
| 14:30:27 | `/status` reply (short) | delivered |

Every short message delivered; **only** the 1912-char reply failed, **twice**, both with 21617. The reply text was confirmed at **1912 chars** in the session jsonl.

**Gateway logs:** showed `message processed … outcome=completed` then `dispatched messageSid=<inbound sid>` for the failed reply — **no delivery error surfaced**. So the failure was invisible from the gateway side (secondary bug, see below).

## Root cause (leading hypothesis)

The gateway's outbound chunking is driven by the channel's **resolved config** (`channels.<id>.textChunkLimit` + `chunkMode`), which bundled channels expose via their **manifest `channelConfigs` schema**:

- **telegram (works):** `openclaw.plugin.json` → `channelConfigs.telegram.schema` declares `textChunkLimit`, `chunkMode`, etc. → gateway reads the limit from config and chunks before calling the channel's `sendText`.
- **twilio-whatsapp (broken):** `openclaw.plugin.json` → `channelConfigs.twilio-whatsapp.schema.properties` declares only `enabled, dmPolicy, allowFrom, fromNumber, webhookUrl` — **no `textChunkLimit`/`chunkMode`**. The limit/chunker are set only programmatically on the JS `outbound` object in `src/channel.ts`:

```ts
outbound: {
  deliveryMode: 'gateway',
  textChunkLimit: TWILIO_MAX_MESSAGE_LEN, // 1600
  chunker: chunkText,
  ...createAttachedChannelResultAdapter({ channel: 'twilio-whatsapp', sendText, sendMedia }),
  resolveTarget: …,
}
```

The gateway appears **not** to read `textChunkLimit`/`chunker` from this programmatic `outbound` object for the result-adapter `sendText` delivery path — so with no chunk limit in the resolved config, it passes the full body to `sendText`, which does a single `client.messages.create({ body: text })`.

**Why the plugin still loads and short replies work:** the `chunkText` import resolves fine and the channel registers normally; chunking simply never fires because the limit isn't where the gateway looks.

## Secondary bug: delivery failure is swallowed

For the 21617 failure the gateway logged only `dispatched`, never an error. Either `client.messages.create` threw and the error wasn't propagated/logged by the delivery path, or Twilio returned a `failed`-status message and the plugin returned its SID as success. Long replies therefore fail **silently**. `sendText`/`sendMedia` should surface Twilio API errors (and ideally Twilio status-callback `failed`/`undelivered`).

## Reproduce

1. Configure the twilio-whatsapp channel, DM the agent a prompt that yields a >1600-char reply (e.g. "list all your skills").
2. Reply never arrives; gateway logs show `outcome=completed` + `dispatched`, no error.
3. Twilio Console / Messages API shows that outbound message `status=failed`, `error_code=21617`.

## Suggested fixes (any one resolves the user-facing issue)

- **A — match the bundled channels (preferred for alignment):** add `textChunkLimit` (default 1600) and optional `chunkMode` to `channelConfigs.twilio-whatsapp.schema` in `openclaw.plugin.json`, so the gateway's standard chunker reads it from resolved channel config. Confirm the gateway then splits before `sendText`.
- **B — self-chunk defensively in the adapter:** in `sendText` (and `sendMedia` captions), split `text` into ≤~1500-char parts on paragraph/newline/sentence boundaries (reuse `chunkText`) and loop `client.messages.create` per part. Self-contained; independent of how the gateway resolves chunk config; protects against future regressions.
- **C — surface failures:** make `sendText`/`sendMedia` throw on Twilio API error and log it; optionally honor Twilio status callbacks so `failed`/`undelivered` is visible in gateway logs.

**Recommendation:** **B + C** for robustness (works regardless of gateway internals and makes future failures visible); add **A** if you want to align with the gateway's native chunking path.

## Open questions for the fix

1. Does the gateway's result-adapter delivery path read `outbound.textChunkLimit`/`outbound.chunker` at all, or only `channels.<id>.textChunkLimit` from resolved config? (Grep gateway image `dist/channel-DO2zg1bH.js` for `textChunkLimit`/`chunker` consumption.)
2. Does `client.messages.create` throw on 21617 (synchronous 400) or return a `failed`-status message with a SID? Determines whether C is "catch a throw" or "inspect status".
