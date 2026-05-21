# OpenClaw Twilio WhatsApp Channel

> ⚠️ **Install via a coding agent — not via the standard OpenClaw install flow.**
> This plugin is non-trivial to deploy: it requires a Twilio account, a public HTTPS URL, environment-variable secrets, exact webhook-URL matching, and gateway version `>= 2026.5.26`. The ClawHub one-click install will leave you with a half-configured plugin that silently 403s or 404s.
>
> **Preferred path:** point a coding agent (Claude Code, Cursor, etc.) at [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) and have it walk you through setup. The ClawHub listing exists for discoverability — not as a supported install path.

A channel plugin for [OpenClaw](https://openclaw.rocks) that connects your AI agent to WhatsApp via the [Twilio Business API](https://www.twilio.com/docs/whatsapp).

[![npm version](https://img.shields.io/npm/v/@srinathh/openclaw-channel-twilio-whatsapp.svg)](https://www.npmjs.com/package/@srinathh/openclaw-channel-twilio-whatsapp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## Why Twilio over Baileys?

OpenClaw ships with a built-in WhatsApp channel based on [Baileys](https://github.com/WhiskeySockets/Baileys), which reverse-engineers the WhatsApp Web protocol. Baileys is convenient — no business verification, no monthly fees — but the trade-offs are real:

| Concern | Baileys | Twilio (this plugin) |
|---|---|---|
| Protocol stability | Breaks when WhatsApp changes their internal protocol | Official, versioned API |
| Account safety | Risk of bans for "automated" behavior | Compliant Business API |
| Delivery receipts | Best-effort | First-class status callbacks |
| Group messaging | Yes | No (1:1 DMs only) |
| Cost | Free | Per-message fees |
| Setup | QR-code pairing | Sender registration + webhook |

Pick this plugin when you need stability and compliance — for personal automations or when you need group chat, the bundled Baileys channel is simpler.

## Features

- **Inbound webhooks** via OpenClaw's gateway (no separate HTTP server)
- **Twilio signature validation** on every inbound request
- **Allowlist enforcement** so only approved phone numbers can talk to your agent
- **Inbound media download** with redirect-following Basic Auth
- **Outbound media staging** — local files are served back to Twilio via UUID-randomized URLs
- **Message chunking** at Twilio's 1600-char limit
- **WhatsApp formatting hints** injected into the agent prompt (`*bold*`, `_italic_`, etc.)
- **Fire-and-forget webhook responses** — TwiML returned immediately, processing happens async (avoids Twilio's 15s timeout)

## Installation

See [**`AGENT_INSTRUCTIONS.md`**](AGENT_INSTRUCTIONS.md). Point a coding agent at it and have it walk you through the install — Twilio sender setup, public webhook URL, gateway-side plugin install, `openclaw.json` config, env-var secrets, and verification. The agent will collect the inputs from you, generate the right config for your deployment shape (Docker / Compose / k8s), and avoid the common foot-guns (legacy config shape, wrong container UID, etc.).

The standard ClawHub one-click install is **not** sufficient for this plugin — the listing exists for discoverability. The plugin needs out-of-band configuration that ClawHub doesn't collect.

## Configuration reference

The agent install will write these for you — this section is for reference only.

### `openclaw.json` — `channels.twilio-whatsapp`

| Field | Required | Description |
|---|---|---|
| `enabled` | yes | Activate the channel |
| `dmPolicy` | yes | `"allowlist"` (only `allowFrom` numbers) or `"open"` (anyone) |
| `allowFrom` | when `allowlist` | Phone numbers in E.164 format (e.g. `+14155551234`) |
| `groupPolicy` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `groupAllowFrom` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `groups` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `fromNumber` | yes | Your Twilio WhatsApp sender in E.164 |
| `webhookUrl` | yes | Public base URL where Twilio can reach OpenClaw — used both for signature validation and media serving |
| `statusCallbackUrl` | no (default `{webhookUrl}/webhook/twilio-whatsapp/status`) | Twilio delivery status callback URL |
| `sendTimeoutMs` | no (default 20000) | Per-attempt Twilio send timeout in milliseconds |
| `sendRetries` | no (default 3) | Maximum Twilio send attempts for retryable transport errors |
| `textChunkLimit` | no (default 1600) | Max characters per outbound message before splitting (Twilio rejects > 1600 with error 21617) |
| `mediaMaxMb` | no (default 25) | Maximum inbound media size in megabytes |
| `typingIndicators` | no (default false) | Send a Twilio WhatsApp typing indicator after accepting inbound messages |
| `typingTimeoutMs` | no (default 5000) | Typing indicator request timeout in milliseconds |
| `processingAckText` | no (default empty) | Optional interim WhatsApp message if the agent is still working |
| `processingAckDelayMs` | no (default 12000) | Delay before sending the interim processing message |
| `dmHistoryLimit` | no | Maximum direct-message user turns to keep in agent context; 0 or unset keeps full session |

All phone numbers use **E.164 format without the `whatsapp:` prefix** — the plugin prepends it internally when calling Twilio.

Group config keys are accepted only so shared OpenClaw configs can load cleanly. Twilio's WhatsApp Business API does not expose group chat webhooks, so inbound access control remains DM-only: `dmPolicy: "allowlist"` plus `allowFrom`.

Modern OpenClaw gateways key plugin config by the manifest id `twilio-whatsapp` (not the npm package name) in `plugins.allow` / `plugins.entries`. The legacy `plugins.load.paths` field is no longer used — plugin install paths are auto-discovered. See `AGENT_INSTRUCTIONS.md` for the exact `openclaw.json` shape.

### Environment variables (secrets)

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | yes | Your Twilio account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | yes | Your Twilio auth token |

## Twilio setup

### 1. Get a WhatsApp sender

For development, use the [Twilio Sandbox for WhatsApp](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn). For production, register a [WhatsApp sender](https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders).

### 2. Configure the inbound webhook

In the Twilio Console for your WhatsApp sender, set:

- **When a message comes in:** `https://<your-host>/webhook/twilio-whatsapp`
- **Method:** `HTTP POST`

The path is fixed by this plugin. The host must match `webhookUrl` in your OpenClaw config exactly — Twilio's signature validation requires the URL to match.

### 3. Verify the health endpoint

```bash
curl https://<your-host>/webhook/twilio-whatsapp/health
# {"status":"ok","channel":"twilio-whatsapp"}
```

### 4. Send a test message

WhatsApp the number you registered in `fromNumber` from a phone in your `allowFrom` list. The agent should reply.

## Architecture

```
┌─────────────────┐      POST /webhook/twilio-whatsapp
│  Twilio API     │ ──────────────────────────────────► ┌──────────────────┐
│                 │ ◄────────── 200 TwiML <Response/> ── │ OpenClaw gateway │
└─────────────────┘                                      │  (this plugin)   │
        ▲                                                └────────┬─────────┘
        │  client.messages.create({...})                          │ dispatchInboundDirectDmWithRuntime
        │                                                         ▼
┌───────┴─────────┐                                       ┌──────────────┐
│ Outbound:       │ ◄──────────── deliver(payload) ────── │ Agent runtime│
│ sendText /      │                                       └──────────────┘
│ sendMedia       │
└─────────────────┘
```

### HTTP routes registered

| Path | Auth | Purpose |
|---|---|---|
| `POST /webhook/twilio-whatsapp` | `plugin` (signature-validated) | Inbound from Twilio |
| `GET /webhook/twilio-whatsapp/media/*` | `plugin` | Serves outbound media for Twilio to fetch |
| `GET /webhook/twilio-whatsapp/health` | `plugin` | Liveness check |

### Media handling

Inbound media (Twilio → agent):
- Downloaded with redirect-following Basic Auth
- Saved to `~/.openclaw/media/twilio-whatsapp/inbound/<MessageSid>-<i><ext>`
- Path included in the `MediaPath` / `MediaPaths` envelope fields

Outbound media (agent → Twilio):
- Local files are copied to `~/.openclaw/media/twilio-whatsapp/outbound/<uuid><ext>`
- Served via the media endpoint with parent-directory check (no traversal)
- Twilio fetches the URL and forwards to WhatsApp

### Inbound flow

1. Twilio POSTs `application/x-www-form-urlencoded` body with `Body`, `From`, `MessageSid`, `NumMedia`, etc.
2. Plugin validates `X-Twilio-Signature` against `webhookUrl + path` — rejects with `403` on mismatch
3. Plugin checks `To` against the configured sender and `From` against `dmPolicy` / `allowFrom` (with `whatsapp:` prefix stripped) — rejects with `403` if either check fails
4. Plugin **immediately** responds with empty TwiML (`<Response/>`) so Twilio doesn't time out
5. If enabled, plugin sends a Twilio typing indicator for the inbound message
6. Plugin downloads any inbound media (async, after responding)
7. Plugin calls `dispatchInboundDirectDmWithRuntime` with the message envelope
8. Agent processes the message and sends a reply via `sendText` / `sendMedia`

## Development

```bash
git clone https://github.com/srinathh/openclaw-channel-twilio-whatsapp.git
cd openclaw-channel-twilio-whatsapp
npm install
npm run build
```

### Project layout

```
src/
├── index.ts          # defineChannelPluginEntry — plugin entry point
├── channel.ts        # createChatChannelPlugin — main plugin definition
├── webhook.ts        # Twilio webhook handler (signature validation + dispatch)
├── media.ts          # download / stage / serve media
├── runtime.ts        # createPluginRuntimeStore — runtime accessor for dispatch
├── util.ts           # phone formatting + form body parsing
└── openclaw-sdk.d.ts # ambient type declarations for openclaw/plugin-sdk/*
```

### Testing locally

You'll need an OpenClaw instance running with this plugin installed. The simplest setup:

```bash
# 1. In one terminal: build and link
npm run build
npm link

# 2. In your OpenClaw instance directory
npm link @srinathh/openclaw-channel-twilio-whatsapp

# 3. Add to your openclaw.json plugins config (see Configuration)
# 4. Use a tunnel (cloudflared, ngrok) to expose the gateway
# 5. Point Twilio's webhook at the tunnel URL
```

## Compatibility

- **OpenClaw gateway**: requires `>= 2026.5.26` for the Plugin SDK surfaces used here and for the gateway-side media directory fix. Earlier 2026.x gateways can fail to load the plugin or silently break outbound media.
- **OpenClaw operator** (k8s): requires v0.30.0+ for the plugin peerDependency symlink
- **Node.js**: 20+

## Known limitations

- **DMs only** — no group chat (Twilio's WhatsApp Business API doesn't support groups). `groupPolicy`, `groupAllowFrom`, and `groups` are accepted as no-op compatibility keys only.
- **No reactions** — WhatsApp reactions are not exposed through this plugin
- **No threaded replies** — WhatsApp threading not exposed by Twilio
- **Single account** — multiple Twilio accounts aren't supported in this version

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at [github.com/srinathh/openclaw-channel-twilio-whatsapp](https://github.com/srinathh/openclaw-channel-twilio-whatsapp).
