# Per-account Twilio credentials: completion evidence

## OpenClaw 2026.6.11 contract

The implementation uses the public contracts shipped by OpenClaw 2026.6.11:

- [`defineSetupPluginEntry`](https://github.com/openclaw/openclaw/blob/66e676d29b92d040716376a75aca32bad655cfac/src/plugin-sdk/core.ts#L593-L604)
  accepts the setup plugin object and returns `{ plugin }`.
- [`ChannelSecretsAdapter`](https://github.com/openclaw/openclaw/blob/66e676d29b92d040716376a75aca32bad655cfac/src/channels/plugins/types.adapters.ts#L163-L176)
  accepts `secretTargetRegistryEntries` and `collectRuntimeConfigAssignments`.
- The [gateway runtime collector](https://github.com/openclaw/openclaw/blob/66e676d29b92d040716376a75aca32bad655cfac/src/secrets/runtime-config-collectors-channels.ts#L11-L34)
  invokes each configured channel's assignment collector before account runtime use.

`test/setup-status.test.mjs` now follows OpenClaw's own resolution sequence:
collect the account-level env SecretRefs, resolve and apply them, and then call
`resolveTwilioWhatsAppAccount`. It passed against both the local test SDK and the
installed OpenClaw 2026.7.2-beta.3 SDK.

## Changed files

- `AGENT_INSTRUCTIONS.md`
- `README.md`
- `docs/per-account-twilio-credentials-evidence.md`
- `openclaw.plugin.json`
- `src/channel.ts`
- `src/credentials.ts`
- `src/openclaw-sdk.d.ts`
- `src/secret-contract.ts`
- `src/setup-entry.ts`
- `src/shared-routes.ts`
- `src/webhook.ts`
- `test/plugin-schema.test.mjs`
- `test/setup-status.test.mjs`
- `test/shared-routes.test.mjs`
- `test/text-send.test.mjs`
- `test/webhook.test.mjs`
- `tsconfig.json`

## Test evidence

Focused SecretRef and setup proof:

```text
$ npm run build && node --test test/setup-status.test.mjs
✔ setup status requires allowFrom when dmPolicy is allowlist
✔ setup status requires a wildcard allowFrom when dmPolicy is open
✔ runtime config parsing rejects legacy top-level sender shape with migration error
✔ outbound text selects the requested account credentials and sender
✔ outbound media selects the requested account credentials
✔ partial account-scoped credentials fail closed without exposing values
✔ global-only credentials remain the compatibility fallback
✔ disabled accounts do not make the channel setup status incomplete
✔ setup entry reports the incomplete account and exposes SecretRef targets
✔ account env SecretRefs hydrate before account resolution
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Full clean-worktree proof at the final commit:

```text
$ npm test
> @srinathh/openclaw-channel-twilio-whatsapp@3.0.0 test
> npm run build && node --test test/*.mjs
> @srinathh/openclaw-channel-twilio-whatsapp@3.0.0 build
> tsc
✔ channel schema accepts multi-account prod-shaped config with group and delivery keys
✔ channel schema rejects legacy top-level sender config keys
✔ channel schema still rejects unknown channel config keys
✔ channel schema rejects incomplete or malformed credential refs
✔ sent hook emits the routed session and canonical outbound payload
✔ sent hook emits failed delivery details without a message id
✔ sent hook is a no-op when no message_sent hook is registered
✔ setup status requires allowFrom when dmPolicy is allowlist
✔ setup status requires a wildcard allowFrom when dmPolicy is open
✔ runtime config parsing rejects legacy top-level sender shape with migration error
✔ outbound text selects the requested account credentials and sender
✔ outbound media selects the requested account credentials
✔ partial account-scoped credentials fail closed without exposing values
✔ global-only credentials remain the compatibility fallback
✔ disabled accounts do not make the channel setup status incomplete
✔ setup entry reports the incomplete account and exposes SecretRef targets
✔ account env SecretRefs hydrate before account resolution
✔ shared inbound, status, media, and health routes survive individual account stops
✔ shared route release is idempotent and a later account can register a fresh owner
✔ partial shared route registration is rolled back
✔ normalizes markdown and unicode punctuation for WhatsApp
✔ forwards WhatsApp profile identity into the OpenClaw inbound contract
✔ splits long WhatsApp text by blocks and hard line limits
✔ splits with default limit when an invalid chunk limit is provided
✔ send helper chunks text, attaches status callback, and sends media separately
✔ normal inbound replies preserve their PDF attachment for the shared sender
✔ normal inbound replies keep media-only payloads instead of dropping them
✔ send helper falls back to the default chunk limit for invalid limits
✔ send helper does not retry ambiguous transport errors
✔ send helper retries Twilio 429 and 5xx responses
✔ send helper fails fast when Twilio returns a terminal message status
✔ send helper trims and preserves WhatsApp-prefixed addresses
✔ send helper does not blindly retry after an unknown timeout outcome
✔ media staging normalizes trailing slash webhook URLs
✔ typing indicator body includes Twilio required WhatsApp channel
✔ processing ack sends only when the run remains active past the delay
✔ final reply and processing acknowledgement keep their account credentials
✔ typing indicator uses the resolved account credentials
✔ inbound webhook accepts forwarded public URL signatures and dispatches after empty TwiML ack
✔ inbound webhook does not mislabel a phone number as a profile name
✔ inbound webhook keeps the request lifecycle open until async dispatch settles
✔ inbound webhook accepts configured alternate public paths
✔ inbound webhook routes by Twilio To number across configured accounts
✔ inbound signature is validated only with the recipient account token
✔ one shared inbound handler reflects account starts and stops dynamically
✔ inbound media uses the recipient account credentials
✔ inbound webhook does not send typing indicators unless explicitly enabled
✔ inbound webhook rejects non-allowlisted senders
✔ inbound webhook rejects oversized bodies before signature validation
✔ inbound webhook keeps allowlist policy closed when allowFrom is empty
✔ inbound webhook requires wildcard allowFrom when dmPolicy is open
✔ status callback validates signature and logs failed delivery
✔ status callback marker selects only the matching account token
✔ status callback falls back to the Twilio sender when the account marker is absent
✔ status callback rejects oversized bodies before signature validation
✔ inbound webhook rejects messages addressed to a different WhatsApp sender
✔ inbound webhook keeps the Twilio ack when synchronous dispatch fails
ℹ tests 57
ℹ suites 0
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## OpenClaw plugin-API limitation

No unresolved OpenClaw plugin-API limitation blocks this design. The minimum
declared gateway version, 2026.6.11, contains the setup-entry, channel-secret
collector, and env SecretRef runtime contracts used here. This repository keeps
a small ignored SDK stub for isolated npm tests, so the focused test was also
run against the installed real SDK to guard against the stub asserting its own
shape.
