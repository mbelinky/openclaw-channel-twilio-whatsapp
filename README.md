# OpenClaw Twilio WhatsApp Channel

> ⚠️ **Install via a coding agent, not via the standard OpenClaw install flow.**
> This plugin is non-trivial to deploy: it requires a Twilio account, a public HTTPS URL, environment-variable secrets, exact webhook-URL matching, and gateway version `>= 2026.6.11`. The ClawHub one-click install will leave you with a half-configured plugin that silently 403s or 404s.
>
> **Preferred path:** point a coding agent (Claude Code, Cursor, etc.) at [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) and have it walk you through setup. The ClawHub listing exists for discoverability, not as a supported install path.

A channel plugin for [OpenClaw](https://openclaw.rocks) that connects your AI agent to WhatsApp via the [Twilio Business API](https://www.twilio.com/docs/whatsapp).

[![npm version](https://img.shields.io/npm/v/@srinathh/openclaw-channel-twilio-whatsapp.svg)](https://www.npmjs.com/package/@srinathh/openclaw-channel-twilio-whatsapp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## What version 3 changes

Version 2 could connect one Twilio WhatsApp sender to one OpenClaw gateway. Version 3 lets the same gateway run several senders without mixing their messages, credentials, access rules, or replies.

- Every sender gets a short account id, such as `sales` or `support`.
- An inbound message is matched to the right account using Twilio's `To` number.
- OpenClaw bindings send that account to the intended agent.
- Replies use the same account, Twilio credentials, and WhatsApp sender that received the message.
- Each account has its own allowlist, or can be explicitly opened with `allowFrom: ["*"]`.

This is a breaking configuration change. Version 3 rejects the old top-level `fromNumber`, `dmPolicy`, and `allowFrom` fields with a migration error instead of guessing where messages belong. The [upgrade example](#upgrade-from-version-2) shows the complete replacement shape.

## Why Twilio over Baileys?

OpenClaw ships with a built-in WhatsApp channel based on [Baileys](https://github.com/WhiskeySockets/Baileys), which reverse-engineers the WhatsApp Web protocol. Baileys is convenient because it needs no business verification or monthly fee, but the trade-offs are real:

| Concern | Baileys | Twilio (this plugin) |
|---|---|---|
| Protocol stability | Breaks when WhatsApp changes their internal protocol | Official, versioned API |
| Account safety | Risk of bans for "automated" behavior | Compliant Business API |
| Delivery receipts | Best-effort | First-class status callbacks |
| Group messaging | Yes | No (1:1 DMs only) |
| Cost | Free | Per-message fees |
| Setup | QR-code pairing | Sender registration + webhook |

Pick this plugin when you need stability and compliance. For personal automations or group chat, the bundled Baileys channel is simpler.

## Features

- **Inbound webhooks** via OpenClaw's gateway (no separate HTTP server)
- **Twilio signature validation** on every inbound request
- **Independent Twilio accounts** with one account-scoped credential pair and WhatsApp sender per OpenClaw account
- **Per-account allowlist enforcement** so each sender controls who can talk to its agent
- **Inbound media download** with redirect-following Basic Auth
- **Outbound media staging:** local files are served back to Twilio via UUID-randomized URLs
- **Message chunking** at Twilio's 1600-char limit
- **WhatsApp formatting hints** injected into the agent prompt (`*bold*`, `_italic_`, etc.)
- **Fast webhook acknowledgement:** Twilio receives an empty TwiML response before the agent starts its longer work

## Installation

See [**`AGENT_INSTRUCTIONS.md`**](AGENT_INSTRUCTIONS.md). Point a coding agent at it and have it walk you through the Twilio sender, public webhook URL, plugin install, `openclaw.json` config, secrets, and verification. The agent collects the required values, writes the correct config for Docker, Compose, Kubernetes, or a host install, and checks the common failure points.

The standard ClawHub one-click install is **not** sufficient for this plugin. The listing exists for discoverability, but the plugin also needs Twilio and gateway configuration that ClawHub does not collect.

## Configuration reference

The agent install will write these for you. This section is for reference only.

### `openclaw.json`: `channels.twilio-whatsapp`

| Field | Required | Description |
|---|---|---|
| `enabled` | yes | Activate the channel |
| `webhookUrl` | yes | Public base URL where Twilio can reach OpenClaw; used for signature validation and media serving |
| `statusCallbackUrl` | no (default `{webhookUrl}/webhook/twilio-whatsapp/status`) | Twilio delivery status callback URL |
| `accounts` | yes | Map of OpenClaw account ids to WhatsApp senders |
| `accounts.<id>.accountSid` | yes for independent Twilio accounts | Twilio Account SID as an OpenClaw SecretRef |
| `accounts.<id>.authToken` | yes for independent Twilio accounts | Twilio Auth Token as an OpenClaw SecretRef |
| `accounts.<id>.fromNumber` | yes | Twilio WhatsApp sender in E.164 |
| `accounts.<id>.dmPolicy` | no (default `"allowlist"`) | `"allowlist"` permits only `allowFrom` numbers; `"open"` permits anyone |
| `accounts.<id>.allowFrom` | yes | Phone numbers in E.164 format for `allowlist`; use `["*"]` with `open` |
| `accounts.<id>.statusCallbackUrl` | no | Account-specific delivery status callback URL |
| `accounts.<id>.groupPolicy` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `accounts.<id>.groupAllowFrom` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `accounts.<id>.groups` | no | Accepted for shared OpenClaw config compatibility only; ignored at runtime |
| `sendTimeoutMs` | no (default 20000) | Per-attempt Twilio send timeout in milliseconds |
| `sendRetries` | no (default 3) | Maximum Twilio send attempts for retryable transport errors |
| `textChunkLimit` | no (default 1600) | Max characters per outbound message before splitting (Twilio rejects > 1600 with error 21617) |
| `mediaMaxMb` | no (default 25) | Maximum inbound media size in megabytes |
| `typingIndicators` | no (default false) | Use Twilio's public beta typing indicator; this also marks the inbound message as read |
| `typingTimeoutMs` | no (default 5000) | Typing indicator request timeout in milliseconds |
| `processingAckText` | no (default empty) | Optional interim WhatsApp message if the agent is still working |
| `processingAckDelayMs` | no (default 12000) | Delay before sending the interim processing message |
| `dmHistoryLimit` | no | Maximum direct-message user turns to keep in agent context; 0 or unset keeps full session |

All phone numbers use **E.164 format without the `whatsapp:` prefix**. The plugin adds the prefix when it calls Twilio.

When accounts use different Twilio credentials, give every enabled account both `accountSid` and `authToken`. The fields accept OpenClaw SecretRefs from `env`, `file`, and `exec` providers. Use refs rather than plaintext so auth-token values stay out of `openclaw.json`.

An account that sets only one account-scoped credential fails closed, even when the global compatibility variables exist. The global pair is used only when that account sets neither field.

`typingIndicators` uses [Twilio's public beta typing-indicator API](https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource). Twilio marks the referenced inbound message as read when the indicator is sent. Twilio also states that this beta feature is not eligible for HIPAA or PCI workflows, so leave it disabled in those environments.

Group config keys are accepted only so shared OpenClaw configs can load cleanly. Twilio's WhatsApp Business API does not expose group chat webhooks, so inbound access control remains DM-only: `accounts.<id>.dmPolicy: "allowlist"` plus `accounts.<id>.allowFrom`.

### Upgrade from version 2

Version 3 does not read the old top-level sender fields. Move each sender under `accounts.<accountId>`, add a matching OpenClaw binding, then remove the old fields. If you have only one sender, it still needs one named account.

Upgrade checklist:

1. Choose a short account id for each Twilio WhatsApp sender.
2. Move that sender's number, access rule, allowlist, and optional credentials under `accounts.<id>`.
3. Add a binding with the same `accountId` so OpenClaw knows which agent should receive its messages.
4. Remove the old top-level sender fields. Version 3 rejects them with a clear error if any remain.
5. Restart the gateway and send one real WhatsApp message to every configured sender. Confirm the intended agent receives it and its reply comes back from the same sender.

```json
{
  "channels": {
    "twilio-whatsapp": {
      "enabled": true,
      "webhookUrl": "https://openclaw.example.com",
      "statusCallbackUrl": "https://openclaw.example.com/webhook/twilio-whatsapp/status",
      "sendTimeoutMs": 20000,
      "sendRetries": 3,
      "textChunkLimit": 1600,
      "mediaMaxMb": 25,
      "typingIndicators": false,
      "typingTimeoutMs": 5000,
      "processingAckText": "",
      "processingAckDelayMs": 12000,
      "dmHistoryLimit": 2,
      "accounts": {
        "sales": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_SALES_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_SALES_AUTH_TOKEN" },
          "fromNumber": "+14155550100",
          "dmPolicy": "allowlist",
          "allowFrom": ["+14155550123"]
        },
        "support": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_AUTH_TOKEN" },
          "fromNumber": "+14155550101",
          "dmPolicy": "open",
          "allowFrom": ["*"]
        }
      }
    }
  },
  "bindings": [
    { "agentId": "sales", "match": { "channel": "twilio-whatsapp", "accountId": "sales" } },
    { "agentId": "support", "match": { "channel": "twilio-whatsapp", "accountId": "support" } }
  ]
}
```

Modern OpenClaw gateways use the manifest id `twilio-whatsapp`, not the npm package name, in `plugins.allow` and `plugins.entries`. The legacy `plugins.load.paths` field is no longer used because installed plugins are discovered automatically. See `AGENT_INSTRUCTIONS.md` for the exact `openclaw.json` shape.

### Credential modes

Account-scoped SecretRefs are the permanent model for gateways serving multiple Twilio accounts. The referenced environment variables can use any valid names:

```json
"accountSid": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_ACCOUNT_SID" },
"authToken": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_AUTH_TOKEN" }
```

The original global variables remain a compatibility mode for a gateway whose enabled accounts all belong to one Twilio account:

| Variable | Required in compatibility mode | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | yes | Shared Twilio account SID |
| `TWILIO_AUTH_TOKEN` | yes | Shared Twilio auth token |

Do not combine one account-scoped field with one global field. Credential pairs are atomic.

## Twilio setup

### 1. Get a WhatsApp sender

For development, use the [Twilio Sandbox for WhatsApp](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn). For production, register a [WhatsApp sender](https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders).

### 2. Configure the inbound webhook

In the Twilio Console for your WhatsApp sender, set:

- **When a message comes in:** `https://<your-host>/webhook/twilio-whatsapp`
- **Method:** `HTTP POST`

The path is fixed by this plugin. The host must match `webhookUrl` in your OpenClaw config exactly because Twilio's signature validation requires the same URL.

### 3. Verify the health endpoint

```bash
curl https://<your-host>/webhook/twilio-whatsapp/health
# {"status":"ok","channel":"twilio-whatsapp"}
```

### 4. Send a test message

WhatsApp the number registered in `accounts.<id>.fromNumber`. The plugin routes inbound messages to the account whose sender matches Twilio's `To` value, then OpenClaw bindings route by `{ channel, accountId }`.

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
| `POST /webhook/twilio-whatsapp/status` | `plugin` (signature-validated) | Delivery status callbacks |
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
2. Plugin matches Twilio `To` against `accounts.<id>.fromNumber`; unknown recipients are rejected
3. Plugin validates `X-Twilio-Signature` using only that account's auth token, then checks `From` against that account's `dmPolicy` / `allowFrom`
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
├── index.ts          # plugin entry point
├── channel.ts        # OpenClaw account, routing, and gateway integration
├── credentials.ts    # per-account credentials and compatibility fallback
├── webhook.ts        # signed inbound and delivery-status webhooks
├── shared-routes.ts  # one route set shared safely by all accounts
├── send.ts           # Twilio sends, retries, chunking, and receipts
├── media.ts          # inbound download and outbound staging
├── text.ts           # WhatsApp text normalization
├── runtime.ts        # OpenClaw runtime access for dispatch
├── setup-entry.ts    # OpenClaw setup and readiness checks
├── diagnostics.ts    # safe, credential-free diagnostics
└── util.ts           # phone formatting and form-body parsing
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

- **OpenClaw gateway**: targets `>= 2026.6.11` for account-scoped channel bindings. Earlier 2026.x gateways can fail to load the plugin or route multi-account inbound messages incorrectly.
- **OpenClaw operator** (k8s): requires v0.30.0+ for the plugin peerDependency symlink
- **Node.js**: 20+

## Known limitations

- **DMs only:** no group chat (Twilio's WhatsApp Business API doesn't support groups). `groupPolicy`, `groupAllowFrom`, and `groups` are accepted as no-op compatibility keys only.
- **No reactions:** WhatsApp reactions are not exposed through this plugin.
- **No threaded replies:** WhatsApp threading is not exposed by Twilio.
- **Typing indicators are a Twilio public beta:** enabling them also marks the inbound message as read and is not suitable for HIPAA or PCI workflows.
- **One credential pair per account:** each enabled account must use both account-scoped credentials, or neither so the global single-Twilio-account compatibility pair applies.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at [github.com/srinathh/openclaw-channel-twilio-whatsapp](https://github.com/srinathh/openclaw-channel-twilio-whatsapp).
