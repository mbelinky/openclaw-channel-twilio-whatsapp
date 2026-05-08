# Twilio WhatsApp Channel — Full Spec Conformance Plan

## Context

The plugin currently delivers DMs, but **slash commands (`/help`, etc.) are being dropped**. Beyond that symptom, an audit against `https://docs.openclaw.ai/plugins/sdk-channel-plugins#walkthrough` and `https://docs.openclaw.ai/plugins/sdk-channel-message` shows the plugin diverges from the current spec in several places:

- Outbound uses `createAttachedChannelResultAdapter` under `outbound`. The current spec describes `defineChannelMessageAdapter()` (with `durableFinal.capabilities` and a `send` object) returning a `MessageReceipt` — that's the documented shape.
- No `setup-entry.ts` / `defineSetupPluginEntry` — host can't validate config without booting the runtime, which matters in the Docker deployment where setup runs before Twilio creds are loaded.
- `openclaw.plugin.json` is missing `kind: "channel"`; `package.json#openclaw.setupEntry` is absent.

Deployment context (from `docs/plans/imperative-crunching-teapot.md`): OpenClaw runs in Docker / k8s, the plugin is installed declaratively from npm via the operator's plugin array, and configuration (allowlist, env vars, fromNumber, webhookUrl) is delivered via ConfigMap + Secret. **No live/interactive pairing.** Media is already a first-class part of the channel — inbound via `[mime: path]` tags, outbound via UUID-staged files served through `/webhook/twilio-whatsapp/media`.

Outcome: a plugin that conforms to the current spec, drops every deprecated API, fixes slash commands, and preserves media.

---

## Critical files

Modified:
- [package.json](../../package.json) — add `openclaw.setupEntry`.
- [openclaw.plugin.json](../../openclaw.plugin.json) — add `"kind": "channel"`.
- [src/openclaw-sdk.d.ts](../../src/openclaw-sdk.d.ts) — extend stub with new SDK symbols (`defineChannelMessageAdapter`, `createMessageReceiptFromOutboundResults`, `defineSetupPluginEntry`).
- [src/index.ts](../../src/index.ts) — wire the new message adapter alongside the channel plugin.
- [src/channel.ts](../../src/channel.ts) — drop `outbound` block; possibly add command tagging on dispatch (see §1).

New:
- [src/setup-entry.ts](../../src/setup-entry.ts) — lightweight setup entry, no `twilio` import.
- [src/message.ts](../../src/message.ts) — `defineChannelMessageAdapter` for outbound (text + media).

---

## 1. Slash commands — diagnose in-cluster, then apply the minimum fix

**The bug is real (commands dropped) but the cause is not yet documented.** Two facts:

- The docs page `sdk-channel-message` does NOT explicitly describe slash-command dispatch — confirmed by re-fetching. There is no documented "you must set X for commands."
- [src/openclaw-sdk.d.ts:152,160](../../src/openclaw-sdk.d.ts#L152) declares `commandBody?: string` and `commandAuthorized?: boolean` as optional params on `dispatchInboundDirectDmWithRuntime`. They exist for a reason.

The OpenClaw runtime is **not installed on the dev box** — it lives in the k8s `openclaw` namespace. So we cannot introspect `dispatchInboundDirectDmWithRuntime` source locally. Diagnosis happens in-cluster through structured debug logs that the host's existing verbosity controls already gate.

### 1a. Add gateway-aware debug logging (small, permanent)

The gateway context already provides a `log` object with `debug`/`info`/`error` methods that the host wires to its verbosity env var ([src/openclaw-sdk.d.ts:41](../../src/openclaw-sdk.d.ts#L41)). We use that — no new env var of our own. In `gateway.startAccount`'s `dispatch` ([src/channel.ts:132](../../src/channel.ts#L132)), capture and log:

```ts
const trimmed = msg.text.trimStart();
const isCommand = trimmed.startsWith('/');
ctx.log?.debug?.(
  `[twilio-whatsapp] inbound from=${msg.senderId} ` +
  `len=${msg.text.length} isCommand=${isCommand} ` +
  `messageSid=${msg.messageSid}`,
);
```

Add a similar `log.debug` line on the receipt side after `dispatchInboundDirectDmWithRuntime` resolves (log the returned `route` / `storePath` — what the host actually did with the message). Keep these as `debug` so they only show when the cluster operator raises verbosity (e.g. `OPENCLAW_LOG_LEVEL=debug` or whatever the host uses); they're zero-cost at default verbosity.

This logging stays in the codebase. It's the diagnostic surface we'll lean on for any future inbound issue, not just this bug.

### 1b. Apply the command tag (preferred fix)

Pass `commandBody` and `commandAuthorized` when the inbound text starts with `/`:

```ts
await dispatchInboundDirectDmWithRuntime({
  ...existingParams,
  rawBody: msg.text,
  commandBody: isCommand ? trimmed.slice(1) : undefined,
  commandAuthorized: isCommand ? true : undefined, // allowlist already enforced
});
```

Per user decision, command auth reuses the DM allowlist. By the time `dispatch` runs, the sender has already been allowlisted in [src/webhook.ts:49](../../src/webhook.ts#L49) and by `createRestrictSendersChannelSecurity` — so `commandAuthorized: true` is sound.

### 1c. Validate in-cluster

After deploying the change to the openclaw namespace:

1. `kubectl logs -n openclaw <pod> -c gateway` with debug verbosity raised. Send `/help` from an allowlisted number. The log should show `isCommand=true`, and the host should reply with help text.
2. If commands still drop with `commandBody` set, the host's command pipeline is not routing on these fields — read the host logs around the `route` line and adjust. Branch options:
   - Host auto-detects `/` from `rawBody` and the allowlist filters them: fix is in the security adapter, not dispatch.
   - Webhook never receives the command: fix is upstream (Twilio config).
   - Some other host expectation (e.g. `commandName` separate from `commandBody`): adapt to whatever the host log says it wanted.

The plan commits to (1b) as the minimum credible fix because the existence of the optional params in the SDK type strongly implies plugins are expected to populate them. (1c) is the fallback path if that hypothesis is wrong.

---

## 2. Migrate outbound to `defineChannelMessageAdapter` (text + media)

WhatsApp/Twilio supports text and media. The new adapter must declare both.

New file [src/message.ts](../../src/message.ts):

```ts
import twilio from 'twilio';
import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
} from 'openclaw/plugin-sdk/channel-message';
import { toWhatsAppId } from './util.js';
import { stageMedia } from './media.js';

export const twilioWhatsAppMessageAdapter = defineChannelMessageAdapter({
  id: 'twilio-whatsapp',
  durableFinal: {
    capabilities: {
      text: true,
      media: true,                 // confirm exact key name against installed SDK
      replyTo: false,              // Twilio Business has no reply-to primitive
      thread: false,               // WhatsApp has no native thread
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, signal }) => {
      signal?.throwIfAborted?.();
      const result = await twilioClient(cfg).messages.create({
        from: toWhatsAppId(getCfg(cfg).fromNumber),
        to:   toWhatsAppId(to),
        body: text || '',
      });
      return createMessageReceiptFromOutboundResults([{ messageId: result.sid }]);
    },
    // Reuse the existing UUID-staging flow from src/media.ts (clawless-derived,
    // referenced in imperative-crunching-teapot.md). Implementation mirrors the
    // current sendMedia in channel.ts:243-268.
    media: async ({ cfg, to, text, mediaUrl, signal }) => {
      signal?.throwIfAborted?.();
      const c = getCfg(cfg);
      const stagedUrl = mediaUrl
        ? stageMedia(mediaUrl, outboundDir(), c.webhookUrl)
        : undefined;
      const result = await twilioClient(cfg).messages.create({
        from: toWhatsAppId(c.fromNumber),
        to:   toWhatsAppId(to),
        body: text || '',
        ...(stagedUrl ? { mediaUrl: [stagedUrl] } : {}),
      });
      return createMessageReceiptFromOutboundResults([{ messageId: result.sid }]);
    },
  },
});
```

The exact name of the media capability key and the `send.media` parameter shape are **not in the public docs**. At implementation time, inspect `node_modules/openclaw/plugin-sdk/channel-message` for the actual exported types and adjust naming/keys to match. If only `send.text` is supported by the new adapter and `send.media` doesn't exist, fall back to keeping `createAttachedChannelResultAdapter` for `sendMedia` only — and document that gap in the README. This is the one place the plan tolerates partial migration, because losing media would be a regression the user explicitly flagged.

In [src/channel.ts](../../src/channel.ts):
- Delete the `outbound` block (lines 221–275) once the new adapter is wired and (if needed) media fallback is in place.
- Drop the import of `createAttachedChannelResultAdapter`.
- Keep `chunkText` integration — move chunk-at-1600 logic into the new `send.text` if the adapter doesn't chunk for us.

In [src/index.ts](../../src/index.ts), register the message adapter alongside the existing plugin via `defineChannelPluginEntry`. The exact wiring (a `messageAdapter` prop, or passing through `plugin`) needs to be confirmed against the installed SDK.

The in-band `sendTwilioReply` closure inside `gateway.startAccount` (channel.ts:133-141) is a duplicate send path and should be deleted; replace its usage in `deliver` with a call that goes through the new message adapter.

---

## 3. Add `setup-entry.ts`

New file [src/setup-entry.ts](../../src/setup-entry.ts) — must NOT import `twilio`, `./channel.ts`, or `./message.ts`:

```ts
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';

export default defineSetupPluginEntry({
  id: 'twilio-whatsapp',
  channel: {
    id: 'twilio-whatsapp',
    inspectAccount: ({ cfg }) => {
      const c = cfg?.channels?.['twilio-whatsapp'];
      const hasCreds = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
      return {
        enabled: !!c?.enabled,
        configured: !!(c?.fromNumber && c?.webhookUrl) && hasCreds,
        hint: !hasCreds        ? 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'
            : !c?.fromNumber   ? 'Set channels.twilio-whatsapp.fromNumber'
            : !c?.webhookUrl   ? 'Set channels.twilio-whatsapp.webhookUrl'
            : undefined,
      };
    },
  },
});
```

In [package.json](../../package.json):

```json
"openclaw": {
  "extensions": ["./dist/index.js"],
  "setupEntry": "./dist/setup-entry.js",
  ...
}
```

---

## 4. Manifest correctness

In [openclaw.plugin.json](../../openclaw.plugin.json), add at the top level:

```json
"kind": "channel",
```

No other manifest changes — `channelConfigs` is already correct and matches the config-driven install path used by the operator (per imperative-crunching-teapot.md).

---

## 5. Extend local SDK type stubs

[src/openclaw-sdk.d.ts](../../src/openclaw-sdk.d.ts) is a hand-written stub because the `openclaw` package is a peer dep that lives only in the cluster, not on the dev box. It only needs to declare the call sites we actually use.

- Extend `'openclaw/plugin-sdk/channel-core'` with `defineSetupPluginEntry`.
- New module `'openclaw/plugin-sdk/channel-message'` declaring `defineChannelMessageAdapter`, `createMessageReceiptFromOutboundResults`, `MessageReceipt`. Shape derived from the spec page; if the in-cluster SDK rejects the call, adjust the stub to match what the runtime actually expects (the runtime is the source of truth, not the stub).
- Once `createAttachedChannelResultAdapter` is fully removed, delete the `'openclaw/plugin-sdk/channel-send-result'` declaration.

---

## 6a. Deferred: Twilio outbound status callbacks

Twilio can POST `queued`/`sent`/`delivered`/`undelivered`/`failed`/`read` events to a `statusCallback` URL set on `messages.create(...)`. Useful in principle for failure handling, but not adopted in this change because:

- The spec's `MessageReceipt` exposes no delivery-state field; no host-side hook to feed updates into.
- Today's synchronous "queued" → success treatment is acceptable for chat.
- Implementing it well needs: a `/webhook/twilio-whatsapp/status` route, a SID→OpenClaw-message-id map, and a host API to flip state.

Revisit once OpenClaw exposes a delivery-state update API on the runtime, or a concrete use case (e.g., agent retry on `failed`) emerges.

---

## 6. Things to drop / not add

- No `pairing.text` adapter — install is config-driven; user explicitly excluded live pairing.
- No `threading` adapter — Twilio Business WhatsApp has no native thread/reply API.
- No `createChannelTurnReplyPipeline`, `deliverDurableInboundReplyPayload`, `dispatchInboundReplyWithBase`, `recordInboundSessionAndDispatchReply`, or anything from `openclaw/plugin-sdk/channel-reply-pipeline` (spec lists these as deprecated).
- No `createAttachedChannelResultAdapter` after migration (modulo the media fallback noted in §2).
- Keep `dispatchInboundDirectDmWithRuntime` — current spec doesn't deprecate it and it's the documented inbound entry point.
- Keep `originatingTo: toWhatsAppId(msg.senderId)` — verified correct ([channel.ts:154](../../src/channel.ts#L154)) and is what v2.0.10 fixed.

---

## Tests

Skipping for this change. The pieces being added are thin glue (setup-entry, manifest fields, adapter wiring) and the only logic that warrants a unit test is command detection (`startsWith('/')`) — too trivial to be useful. Verification is end-to-end, see below. If during implementation we add a non-trivial helper (e.g. a parser), add a node:test for that helper specifically — no broader test scaffold.

Fix `package.json` `scripts.test`: either remove it or point it at a real path. Currently it references `dist/test/` which doesn't exist.

---

## Verification

End-to-end, in order:

1. `npm run build` — TypeScript compiles cleanly with the extended `.d.ts`.
2. **Docker dry-run**: build a tarball (`npm pack`), feed it via the operator's `plugins:` array per `imperative-crunching-teapot.md`, mount a config JSON declaring `channels.twilio-whatsapp.{enabled,fromNumber,webhookUrl,allowFrom}` and env vars `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`. Boot. Confirm:
   - Setup phase imports `setup-entry.js` only — grep the boot logs for any `require('twilio')` during the setup phase; there should be none.
   - "Twilio WhatsApp channel started (from: …)" appears once gateway runs.
3. **Webhook health**: `curl https://<host>/webhook/twilio-whatsapp/health` → `{"status":"ok"}`.
4. **Live receive (text)**: send `hi` from an allowlisted WhatsApp number → agent reply arrives back to that number (validates `originatingTo` and the new `send.text`).
5. **Live receive (media)**: send a photo → host stores it under `~/.openclaw/media/twilio-whatsapp/inbound/`, agent acknowledges. Send a media reply → confirm the image arrives on WhatsApp (validates `send.media` or the media fallback).
6. **Slash command (the bug)**: send `/help` from an allowlisted number → host runs the command and replies with help text. Try `/status` similarly. With the temporary debug log enabled, confirm `dispatchInboundDirectDmWithRuntime` was called with `commandBody: "help"` and `commandAuthorized: true`. Remove the debug log.
7. **Allowlist denial**: send `/help` from a non-allowlisted number → 403 at webhook (no dispatch). Confirms commands inherit the DM allowlist.
8. **Outbound receipt shape**: trigger a multi-chunk reply (>1600 chars) and confirm the host's stored receipt has `platformMessageIds: [sid1, sid2, ...]` rather than a single `messageId` — proves the new adapter is wired.
9. Bump version to `2.1.0` (breaking outbound shape) and update README to document `kind: channel`, `setupEntry`, and that slash commands inherit `allowFrom`.
