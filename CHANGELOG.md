# Changelog

## 3.0.3

- Remove deprecated channel environment metadata now covered by the setup entry and account credential schema, clearing the ClawHub validation warning.

## 3.0.2

- Publish the compiled runtime in the ClawHub artifact. The v3.0.1 ClawHub artifact was withdrawn before any installs because its GitHub-source build contained documentation and metadata but no `dist` files.

## 3.0.1

- Give the maintained fork its own ClawHub plugin install id while preserving the existing `twilio-whatsapp` channel id and configuration path.
- Tell OpenClaw to prefer this maintained fork over the legacy plugin when both can provide the channel.

## 3.0.0

This is the first release of the independently maintained fork.

- Add multiple named Twilio WhatsApp accounts to one OpenClaw gateway.
- Route inbound messages, replies, media, credentials, and delivery callbacks through the correct account.
- Add account-scoped OpenClaw SecretRefs and fail closed on incomplete credentials.
- Add current Twilio typing-indicator support, bounded webhook bodies, safe retries, and message chunking.
- Add migration instructions, an agent installation guide, continuous integration, and 60 focused tests.
- Require OpenClaw 2026.6.11 or newer and Node.js 22.19 or newer.

Version 3 uses a new account-based configuration. See the README upgrade section before replacing version 2.
