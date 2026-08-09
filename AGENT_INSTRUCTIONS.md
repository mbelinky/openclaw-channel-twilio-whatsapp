# Agent Instructions: Installing `@mbelinky/openclaw-channel-twilio-whatsapp`

You are an AI agent helping a user install this plugin into their OpenClaw deployment. This document tells you exactly what to do, what to ask, and what not to assume. The setup has several parts: plugin install, OpenClaw config, secrets, Twilio console setup, and a public URL. Work through them in order.

## When to install this plugin (vs. the built-in Baileys WhatsApp channel)

- **Recommend this plugin** when the user needs: official/compliant WhatsApp Business API, stable protocol, delivery receipts, or production reliability.
- **Recommend the built-in Baileys channel instead** when the user wants free messaging, group chats, personal use, or no business verification. Do not install this plugin in those cases because it costs money per message and takes more work to set up.

If you're not sure which the user wants, ask before proceeding.

## Prerequisites

Confirm all of these before starting. If any is missing, stop and explain what's needed.

1. **A running OpenClaw gateway, version `>= 2026.6.11`.** Earlier 2026.x gateways do not have the account-scoped channel-binding behavior this plugin needs for multi-sender deployments.
2. **Plugin version `>= 3.0.2` (install `@latest`).** Version 3 is a clean cutover to account-scoped sender config. Legacy top-level `fromNumber`, `dmPolicy`, and `allowFrom` are invalid.
3. **A Twilio account** with WhatsApp enabled, either the Sandbox for development or a registered WhatsApp sender for production. https://console.twilio.com
4. **A public HTTPS URL** that routes inbound traffic to the OpenClaw gateway. Twilio's CDN must be able to reach this URL anonymously. Acceptable: cloudflared/ngrok tunnel, public reverse proxy, k8s ingress. NOT acceptable: localhost, private IPs, self-signed certs.
5. **The user's phone number(s)** in E.164 format (e.g. `+14155550123`). These will be the allowlist.

## Information to collect from the user up front

Ask for all of these before touching any files. Don't make up values.

| What to ask | Format / example | Used in |
|---|---|---|
| Twilio Account SID per account | `AC...` (34 chars) | Account-scoped SecretRef |
| Twilio Auth Token per account | secret string | Account-scoped SecretRef |
| OpenClaw account id per sender | stable id, e.g. `sales`, `support` | `accounts.<id>` and `bindings[].match.accountId` |
| Twilio WhatsApp sender number per account | E.164, e.g. `+14155550100` (Sandbox: `+14155238886`) | `accounts.<id>.fromNumber` |
| Allowed senders | E.164 list for `allowlist`; `["*"]` for `open` | `accounts.<id>.allowFrom` |
| DM policy per account | `"allowlist"` or `"open"` | `accounts.<id>.dmPolicy` |
| Public webhook base URL | `https://host.example.com` (no trailing slash, no path) | `webhookUrl` |

**Critical:** all phone numbers are **E.164 with no `whatsapp:` prefix**. The plugin adds the prefix internally. If the user pastes `whatsapp:+14155550123`, strip it.

## Step 1: install the plugin into the gateway runtime

Pick the path that matches the user's deployment. **In all cases the install must run as the gateway user against the gateway's own `~/.openclaw` data dir**, not into a `node_modules/` directory in the project working directory. The gateway resolves plugins via `~/.openclaw/npm/node_modules/...`.

### Docker / Docker Compose (most common)

Run the gateway image's plugin installer as a one-shot:

```bash
docker run --rm \
  -v <host-data-dir>:/home/node/.openclaw \
  --user 1000:1000 \
  -e HOME=/home/node \
  ghcr.io/openclaw/openclaw:<version> \
  node openclaw.mjs plugins install @mbelinky/openclaw-channel-twilio-whatsapp@latest --force
```

Check these details because mistakes here can make the install fail:

- **`--user` must match the host data-dir owner.** If `<host-data-dir>` is owned by UID `1000` on the host, pass `--user 1000:1000`. Mismatch → `EACCES` on plugin write.
- **The full command `node openclaw.mjs plugins install …` is required** on images `>= 2026.5.x` because their ENTRYPOINT is bare `tini -s --`. A bare `plugins install …` command produces `[FATAL tini (7)] exec plugins failed: No such file or directory`. Older images `<= 2026.4.x` used a shell entrypoint, but those images have the media-directory bug and should be upgraded.
- **Pin `<version>` to a tag `>= 2026.6.11`** in line with the prerequisite above.

For Docker Compose with a long-running gateway service, you can `docker compose exec <service> node openclaw.mjs plugins install …` instead of a separate `docker run`.

### npm into an existing OpenClaw runtime (rare)

Only use this if the gateway is already running directly on a host (no container). The install goes into the gateway's data dir, not the project CWD:

```bash
HOME=<gateway home> node <gateway-install>/openclaw.mjs plugins install \
  @mbelinky/openclaw-channel-twilio-whatsapp@latest --force
```

### Kubernetes (operator-based deployment)

If the user runs the OpenClaw operator, plugins are declared in the `OpenClawInstance` CRD:

```yaml
spec:
  plugins:
    - "@mbelinky/openclaw-channel-twilio-whatsapp@latest"
```

The operator handles the install. The exact CRD shape depends on the operator version, so check the operator's own docs if this fails. Do not run `npm install` inside the pod.

## Step 2: configure `openclaw.json`

Merge this into the user's existing `openclaw.json` (don't overwrite the whole file). Substitute the values collected above.

```json
{
  "channels": {
    "twilio-whatsapp": {
      "enabled": true,
      "webhookUrl": "https://your-public-host.example.com",
      "accounts": {
        "sales": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_SALES_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_SALES_AUTH_TOKEN" },
          "dmPolicy": "allowlist",
          "allowFrom": ["+14155550123"],
          "fromNumber": "+14155550100"
        },
        "support": {
          "accountSid": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_ACCOUNT_SID" },
          "authToken": { "source": "env", "provider": "default", "id": "TWILIO_SUPPORT_AUTH_TOKEN" },
          "dmPolicy": "open",
          "allowFrom": ["*"],
          "fromNumber": "+14155550101"
        }
      }
    }
  },
  "bindings": [
    { "agentId": "sales", "match": { "channel": "twilio-whatsapp", "accountId": "sales" } },
    { "agentId": "support", "match": { "channel": "twilio-whatsapp", "accountId": "support" } }
  ],
  "plugins": {
    "enabled": true,
    "allow": ["twilio-whatsapp-multi-account"],
    "entries": {
      "twilio-whatsapp-multi-account": { "enabled": true }
    }
  }
}
```

**Critical: use the manifest id `twilio-whatsapp-multi-account`, NOT the npm package name `@mbelinky/openclaw-channel-twilio-whatsapp` or the channel id `twilio-whatsapp`, in `plugins.allow` and `plugins.entries`.**

Modern OpenClaw gateways (2026.x) key plugin config by the manifest id from `openclaw.plugin.json`, not the npm package name. Using the package name causes a warning. The legacy `plugins.load.paths` field is also gone because the gateway discovers installed plugins under `~/.openclaw/npm/node_modules/`. A missing path in `plugins.load.paths` makes the gateway refuse to start with `Invalid config: plugins.load.paths: plugin path not found`.

Also:

- If `plugins.allow` already exists, **append** to it; don't replace.
- `accounts.<id>.dmPolicy: "open"` requires `accounts.<id>.allowFrom: ["*"]` and is strongly discouraged. Anyone with that sender's number can talk to the bound agent and create Twilio charges. Default to `"allowlist"` unless the sender is intentionally public.
- `typingIndicators: true` uses Twilio's public beta typing-indicator API. It also marks the inbound message as read and is not eligible for HIPAA or PCI workflows. Leave it disabled unless the user explicitly wants that behavior.
- Do not write legacy top-level `fromNumber`, `dmPolicy`, or `allowFrom`; v3 rejects them. Use `accounts.<id>.*`.
- For independent Twilio accounts or WhatsApp Business accounts, set both `accountSid` and `authToken` on every enabled account. Use SecretRefs, not plaintext.
- Never set only one account-scoped credential. A partial pair intentionally fails closed and does not mix with the global fallback.

## Step 3: set the secrets

Account-scoped credentials use OpenClaw SecretRefs in `openclaw.json`; the values themselves stay in the referenced provider. For env refs from the example:

```bash
TWILIO_SALES_ACCOUNT_SID=AC...
TWILIO_SALES_AUTH_TOKEN=...
TWILIO_SUPPORT_ACCOUNT_SID=AC...
TWILIO_SUPPORT_AUTH_TOKEN=...
```

How to set these depends on the deployment:
- **Docker / Compose:** add to the container's env (compose `environment:` or `.env` file).
- **systemd / shell launch:** add to the unit's `Environment=` or the launch script.
- **Kubernetes:** add to the `OpenClawInstance` `spec.env` (or a referenced Secret).

The original `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` global pair is supported only as single-Twilio-account compatibility mode. It applies to an account only when that account supplies neither account-scoped field.

Never put an auth-token value into `openclaw.json`, into a committed file, or echo it to the terminal in a way that gets logged.

## Step 4: restart or hot-reload the gateway

After `plugins install` the gateway prints `Restart the gateway to load plugins.` The modern gateway also watches `openclaw.json` for changes, but a restart is the reliable option when secrets or environment variables changed. If in doubt, restart.

## Twilio console setup (user-driven)

You cannot do these from the CLI. Walk the user through them.

1. **Get a WhatsApp sender.** For development: enable the Twilio Sandbox for WhatsApp and have the user send the join code from their phone. For production: register a WhatsApp sender (requires Meta business verification, takes days).
2. **Set the inbound webhook URL.** In the Twilio Console for the sender:
   - **When a message comes in:** `https://<webhookUrl host>/webhook/twilio-whatsapp`
   - **Method:** `HTTP POST`
   - The path `/webhook/twilio-whatsapp` is fixed by the plugin. The host must match the `webhookUrl` value **exactly** because a mismatch causes Twilio signature validation to reject every inbound message with a 403.

## Verification

Run these in order. Stop and debug at the first failure.

1. **Health endpoint reachable from the public internet:**
   ```bash
   curl https://<webhookUrl host>/webhook/twilio-whatsapp/health
   # expected: {"status":"ok","channel":"twilio-whatsapp"}
   ```
   If this fails, fix the public URL or reverse proxy before going further.

2. **Inbound test:** from an allowed phone number, WhatsApp each configured `accounts.<id>.fromNumber`. The plugin routes by Twilio `To`, and the bound account's agent should reply.

3. **Outbound media test:** ask the agent to send the user a file or image. The recipient should see the attachment, not just text. If text arrives and the image doesn't, re-check gateway version (`>= 2026.6.11`) and plugin version (`>= 3.0.2`).

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway refuses to start: `plugins.load.paths: plugin path not found` | Legacy `plugins.load.paths` in `openclaw.json` | Remove the `load` block entirely; auto-discovery handles it (see Step 2) |
| Plugin loaded but config not applied; gateway log says the manifest id differs from the package name | Used the package name or channel id as the key in `plugins.allow` / `entries` | Replace it with `twilio-whatsapp-multi-account` |
| Docker install fails: `[FATAL tini (7)] exec plugins failed: No such file or directory` | Bare `plugins install …` on a `>= 2026.5.x` image | Use full form `node openclaw.mjs plugins install …` |
| Plugin install writes fail with `EACCES` | Container `--user` doesn't match host data-dir owner | Set `--user` to match (commonly `1000:1000`) |
| All inbound messages get 403 | `webhookUrl` doesn't match what Twilio is POSTing to | Set `webhookUrl` to the exact public origin (scheme + host, no trailing slash, no path) |
| Gateway rejects config mentioning top-level `fromNumber` | Legacy v2 config shape | Move sender settings under `channels.twilio-whatsapp.accounts.<id>` |
| One account reports incomplete Twilio credentials | Only `accountSid` or `authToken` is set on that account | Configure both account-scoped SecretRefs, or remove both to use the global compatibility pair |
| One sender gets signature failures after multi-account setup | Its `To` number is mapped to an account whose auth token belongs to another Twilio account | Fix that account's credential refs; inbound signatures are validated only with the matched account token |
| Inbound messages get 403 only from one user number | Number not in that account's `allowFrom`, or has `whatsapp:` prefix in config | Add as E.164 without prefix under the right account |
| Inbound messages get 403 for one Twilio sender | Twilio `To` does not match any `accounts.<id>.fromNumber` | Add or fix the account's E.164 sender number |
| Text replies arrive but images don't | Old gateway/plugin or media route issue | Upgrade to gateway `>= 2026.6.11` and plugin `>= 3.0.2` |
| Twilio error 21617 in logs | Outbound message > 1600 chars on plugin `< 2.1.4` | Upgrade plugin (`@latest` covers this) |

## What this plugin does NOT do

Do not promise the user any of these because they are framework or Twilio limitations:

- **No group chats.** Twilio's WhatsApp Business API is 1:1 only.
- **No reactions, standalone read receipts, or agent-triggered typing actions.** The plugin can send an automatic typing indicator after accepting an inbound message, but Twilio also marks that message as read and the agent cannot control it as a message action.
- **No threaded replies.**
- **Credential pairs are atomic.** An enabled account uses its complete account-scoped pair, or the complete global compatibility pair when neither scoped field is present.

## What to tell the user about cost

Twilio bills per WhatsApp message. Pricing varies by destination country and conversation type (utility / marketing / service). Point the user at https://www.twilio.com/en-us/whatsapp/pricing before they enable `accounts.<id>.dmPolicy: "open"` or before any production rollout.

## References

- npm: https://www.npmjs.com/package/@mbelinky/openclaw-channel-twilio-whatsapp
- GitHub: https://github.com/mbelinky/openclaw-channel-twilio-whatsapp
- Original project: https://github.com/srinathh/openclaw-channel-twilio-whatsapp
- Plugin config schema: `openclaw.plugin.json` in this repo
- Full user-facing docs: `README.md` in this repo
