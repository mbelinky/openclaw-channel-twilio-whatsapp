# Agent Instructions: Installing `@srinathh/openclaw-channel-twilio-whatsapp`

You are an AI agent helping a user install this plugin into their OpenClaw deployment. This document tells you exactly what to do, what to ask, and what NOT to assume. The setup is multi-step (install, OpenClaw config, env secrets, Twilio console setup, public URL) — work through it methodically.

## When to install this plugin (vs. the built-in Baileys WhatsApp channel)

- **Recommend this plugin** when the user needs: official/compliant WhatsApp Business API, stable protocol, delivery receipts, or production reliability.
- **Recommend the built-in Baileys channel instead** when the user wants: free messaging, group chats, personal use, or no business verification. Don't install this plugin in those cases — it will cost money per message and is more work to set up.

If you're not sure which the user wants, ask before proceeding.

## Prerequisites

Confirm all of these before starting. If any is missing, stop and explain what's needed.

1. **A running OpenClaw gateway, version `>= 2026.6.11`.** Earlier 2026.x gateways do not have the account-scoped channel-binding behavior this plugin needs for multi-sender deployments.
2. **Plugin version `>= 3.0.0` (install `@latest`).** Version 3 is a clean cutover to account-scoped sender config. Legacy top-level `fromNumber`, `dmPolicy`, and `allowFrom` are invalid.
3. **A Twilio account** with WhatsApp enabled — either the Sandbox (dev) or a registered WhatsApp sender (production). https://console.twilio.com
4. **A public HTTPS URL** that routes inbound traffic to the OpenClaw gateway. Twilio's CDN must be able to reach this URL anonymously. Acceptable: cloudflared/ngrok tunnel, public reverse proxy, k8s ingress. NOT acceptable: localhost, private IPs, self-signed certs.
5. **The user's phone number(s)** in E.164 format (e.g. `+14155551234`) — these will be the allowlist.

## Information to collect from the user up front

Ask for all of these before touching any files. Don't make up values.

| What to ask | Format / example | Used in |
|---|---|---|
| Twilio Account SID per account | `AC...` (34 chars) | Account-scoped SecretRef |
| Twilio Auth Token per account | secret string | Account-scoped SecretRef |
| OpenClaw account id per sender | stable id, e.g. `vinalia`, `mkps` | `accounts.<id>` and `bindings[].match.accountId` |
| Twilio WhatsApp sender number per account | E.164, e.g. `+14155550000` (Sandbox: `+14155238886`) | `accounts.<id>.fromNumber` |
| Allowed senders | E.164 list for `allowlist`; `["*"]` for `open` | `accounts.<id>.allowFrom` |
| DM policy per account | `"allowlist"` or `"open"` | `accounts.<id>.dmPolicy` |
| Public webhook base URL | `https://host.example.com` (no trailing slash, no path) | `webhookUrl` |

**Critical:** all phone numbers are **E.164 with no `whatsapp:` prefix**. The plugin adds the prefix internally. If the user pastes `whatsapp:+14155551234`, strip it.

## Step 1 — install the plugin into the gateway runtime

Pick the path that matches the user's deployment. **In all cases the install must run as the gateway user against the gateway's own `~/.openclaw` data dir** — not into a `node_modules/` in the project CWD. The gateway resolves plugins via `~/.openclaw/npm/node_modules/...`.

### Docker / Docker Compose (most common)

Run the gateway image's plugin installer as a one-shot:

```bash
docker run --rm \
  -v <host-data-dir>:/home/node/.openclaw \
  --user 1000:1000 \
  -e HOME=/home/node \
  ghcr.io/openclaw/openclaw:<version> \
  node openclaw.mjs plugins install @srinathh/openclaw-channel-twilio-whatsapp@latest --force
```

Non-obvious details — get these wrong and the install fails cryptically:

- **`--user` must match the host data-dir owner.** If `<host-data-dir>` is owned by UID `1000` on the host, pass `--user 1000:1000`. Mismatch → `EACCES` on plugin write.
- **The full command `node openclaw.mjs plugins install …` is required** on images `>= 2026.5.x`, because their ENTRYPOINT is bare `tini -s --` — bare `plugins install …` produces `[FATAL tini (7)] exec plugins failed: No such file or directory`. (Older images `<= 2026.4.x` had a shell entrypoint that dispatched bare `plugins install`, but those images have the media-mkdir bug, so the user shouldn't be on them.)
- **Pin `<version>` to a tag `>= 2026.6.11`** in line with the prerequisite above.

For Docker Compose with a long-running gateway service, you can `docker compose exec <service> node openclaw.mjs plugins install …` instead of a separate `docker run`.

### npm into an existing OpenClaw runtime (rare)

Only use this if the gateway is already running directly on a host (no container). The install goes into the gateway's data dir, not the project CWD:

```bash
HOME=<gateway home> node <gateway-install>/openclaw.mjs plugins install \
  @srinathh/openclaw-channel-twilio-whatsapp@latest --force
```

### Kubernetes (operator-based deployment)

If the user runs the OpenClaw operator, plugins are declared in the `OpenClawInstance` CRD:

```yaml
spec:
  plugins:
    - "@srinathh/openclaw-channel-twilio-whatsapp@latest"
```

The operator handles the install. Exact CRD shape depends on the operator version — check the operator's own docs if this fails. Don't run `npm install` inside the pod.

## Step 2 — configure `openclaw.json`

Merge this into the user's existing `openclaw.json` (don't overwrite the whole file). Substitute the values collected above.

```json
{
  "channels": {
    "twilio-whatsapp": {
      "enabled": true,
      "webhookUrl": "https://your-public-host.example.com",
      "accounts": {
        "vinalia": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_VINALIA_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_VINALIA_AUTH_TOKEN" },
          "dmPolicy": "allowlist",
          "allowFrom": ["+14155551234"],
          "fromNumber": "+14155550000"
        },
        "mkps": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_MKPS_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_MKPS_AUTH_TOKEN" },
          "dmPolicy": "open",
          "allowFrom": ["*"],
          "fromNumber": "+447427807929"
        }
      }
    }
  },
  "bindings": [
    { "agentId": "vinalia", "match": { "channel": "twilio-whatsapp", "accountId": "vinalia" } },
    { "agentId": "mkps", "match": { "channel": "twilio-whatsapp", "accountId": "mkps" } }
  ],
  "plugins": {
    "enabled": true,
    "allow": ["twilio-whatsapp"],
    "entries": {
      "twilio-whatsapp": { "enabled": true }
    }
  }
}
```

**Critical: use the manifest id `twilio-whatsapp`, NOT the npm package name `@srinathh/openclaw-channel-twilio-whatsapp`, in `plugins.allow` and `plugins.entries`.**

Modern OpenClaw gateways (2026.x) key plugin config by the manifest id (from `openclaw.plugin.json`), not the npm package name. Using the package name causes the gateway to log a warning and fall back to the manifest id anyway — but more importantly, the legacy `plugins.load.paths` field is gone: the gateway auto-discovers installed plugins from `~/.openclaw/npm/node_modules/`. If you add `plugins.load.paths` pointing at a path that doesn't exist on the gateway's filesystem, the gateway refuses to start with `Invalid config: plugins.load.paths: plugin path not found`.

Also:

- If `plugins.allow` already exists, **append** to it; don't replace.
- `accounts.<id>.dmPolicy: "open"` requires `accounts.<id>.allowFrom: ["*"]` and is strongly discouraged — anyone with that sender's number can talk to the bound agent and rack up Twilio charges. Default to `"allowlist"` unless the sender is intentionally public.
- Do not write legacy top-level `fromNumber`, `dmPolicy`, or `allowFrom`; v3 rejects them. Use `accounts.<id>.*`.
- For independent Twilio accounts/WABAs, set both `accountSid` and `authToken` on every enabled account. Use SecretRefs, not plaintext.
- Never set only one account-scoped credential. A partial pair intentionally fails closed and does not mix with the global fallback.

## Step 3 — set the secrets

Account-scoped credentials use OpenClaw SecretRefs in `openclaw.json`; the values themselves stay in the referenced provider. For env refs from the example:

```bash
TWILIO_VINALIA_ACCOUNT_SID=AC...
TWILIO_VINALIA_AUTH_TOKEN=...
TWILIO_MKPS_ACCOUNT_SID=AC...
TWILIO_MKPS_AUTH_TOKEN=...
```

How to set these depends on the deployment:
- **Docker / Compose:** add to the container's env (compose `environment:` or `.env` file).
- **systemd / shell launch:** add to the unit's `Environment=` or the launch script.
- **Kubernetes:** add to the `OpenClawInstance` `spec.env` (or a referenced Secret).

The original `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` global pair is supported only as single-Twilio-account compatibility mode. It applies to an account only when that account supplies neither account-scoped field.

Never put an auth-token value into `openclaw.json`, into a committed file, or echo it to the terminal in a way that gets logged.

## Step 4 — restart (or hot-reload) the gateway

After `plugins install` the gateway prints `Restart the gateway to load plugins.`. The modern gateway also hot-reloads on `openclaw.json` changes via the file watcher, and in practice picks up the new plugin without a full restart — but a restart is the deterministic option, especially when env vars also changed. If in doubt, restart.

## Twilio console setup (user-driven)

You can't do these from the CLI — walk the user through them.

1. **Get a WhatsApp sender.** For development: enable the Twilio Sandbox for WhatsApp and have the user send the join code from their phone. For production: register a WhatsApp sender (requires Meta business verification, takes days).
2. **Set the inbound webhook URL.** In the Twilio Console for the sender:
   - **When a message comes in:** `https://<webhookUrl host>/webhook/twilio-whatsapp`
   - **Method:** `HTTP POST`
   - The path `/webhook/twilio-whatsapp` is fixed by the plugin. The host must match the `webhookUrl` value **exactly** — Twilio signature validation rebuilds the URL from `webhookUrl + path` and a mismatch causes 403s on every inbound message.

## Verification

Run these in order. Stop and debug at the first failure.

1. **Health endpoint reachable from the public internet:**
   ```bash
   curl https://<webhookUrl host>/webhook/twilio-whatsapp/health
   # expected: {"status":"ok","channel":"twilio-whatsapp"}
   ```
   If this fails, the public URL or reverse proxy is broken — fix that before going further.

2. **Inbound test:** from an allowed phone number, WhatsApp each configured `accounts.<id>.fromNumber`. The plugin routes by Twilio `To`, and the bound account's agent should reply.

3. **Outbound media test:** ask the agent to send the user a file or image. The recipient should see the attachment, not just text. If text arrives and the image doesn't, re-check gateway version (`>= 2026.6.11`) and plugin version (`>= 3.0.0`).

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway refuses to start: `plugins.load.paths: plugin path not found` | Legacy `plugins.load.paths` in `openclaw.json` | Remove the `load` block entirely — auto-discovery handles it (see Step 2) |
| Plugin loaded but config not applied; gateway log says `manifest id "twilio-whatsapp" differs from npm package name` | Used the npm package name as the key in `plugins.allow` / `entries` | Replace with the manifest id `twilio-whatsapp` |
| Docker install fails: `[FATAL tini (7)] exec plugins failed: No such file or directory` | Bare `plugins install …` on a `>= 2026.5.x` image | Use full form `node openclaw.mjs plugins install …` |
| Plugin install writes fail with `EACCES` | Container `--user` doesn't match host data-dir owner | Set `--user` to match (commonly `1000:1000`) |
| All inbound messages get 403 | `webhookUrl` doesn't match what Twilio is POSTing to | Set `webhookUrl` to the exact public origin (scheme + host, no trailing slash, no path) |
| Gateway rejects config mentioning top-level `fromNumber` | Legacy v2 config shape | Move sender settings under `channels.twilio-whatsapp.accounts.<id>` |
| One account reports incomplete Twilio credentials | Only `accountSid` or `authToken` is set on that account | Configure both account-scoped SecretRefs, or remove both to use the global compatibility pair |
| One sender gets signature failures after multi-account setup | Its `To` number is mapped to an account whose auth token belongs to another Twilio account | Fix that account's credential refs; inbound signatures are validated only with the matched account token |
| Inbound messages get 403 only from one user number | Number not in that account's `allowFrom`, or has `whatsapp:` prefix in config | Add as E.164 without prefix under the right account |
| Inbound messages get 403 for one Twilio sender | Twilio `To` does not match any `accounts.<id>.fromNumber` | Add or fix the account's E.164 sender number |
| Text replies arrive but images don't | Old gateway/plugin or media route issue | Upgrade to gateway `>= 2026.6.11` and plugin `>= 3.0.0` |
| Twilio error 21617 in logs | Outbound message > 1600 chars on plugin `< 2.1.4` | Upgrade plugin (`@latest` covers this) |

## What this plugin does NOT do

Don't promise the user any of these — they're framework / Twilio limitations:

- **No group chats.** Twilio's WhatsApp Business API is 1:1 only.
- **No reactions, no typing indicators, no read receipts as agent actions.** Twilio doesn't expose these.
- **No threaded replies.**
- **Credential pairs are atomic.** An enabled account uses its complete account-scoped pair, or the complete global compatibility pair when neither scoped field is present.

## What to tell the user about cost

Twilio bills per WhatsApp message. Pricing varies by destination country and conversation type (utility / marketing / service). Point the user at https://www.twilio.com/en-us/whatsapp/pricing before they enable `accounts.<id>.dmPolicy: "open"` or before any production rollout.

## References

- npm: https://www.npmjs.com/package/@srinathh/openclaw-channel-twilio-whatsapp
- GitHub: https://github.com/srinathh/openclaw-channel-twilio-whatsapp
- Plugin config schema: `openclaw.plugin.json` in this repo
- Full user-facing docs: `README.md` in this repo
