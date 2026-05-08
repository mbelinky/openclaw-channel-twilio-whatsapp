# Plan: Deploy OpenClaw with Twilio WhatsApp Channel

## Context

OpenClaw (360k+ stars) is a self-hosted AI agent that runs on WhatsApp, Telegram, etc. The goal is to deploy it on the home k8s cluster pinned to the primary node (t480server), using the official `openclaw-rocks/k8s-operator` and a custom Twilio WhatsApp channel plugin adapted from the existing TypeScript implementation in `~/src/nanoclaw`.

The official OpenClaw registry only ships Baileys (unofficial WhatsApp). We bypass that with the official Twilio Business API — the same production-proven pattern used in both nanoclaw and clawless.

**Plugin strategy:** The operator supports declarative npm plugin installation via an init container (`spec.plugins` array in the CR). The plugin is published to **public npm** as `@srinathh/openclaw-channel-twilio-whatsapp`. The operator installs it (and any future plugins added to the array) at startup into the persistent volume — no custom Docker image needed. The main OpenClaw image is never modified, so it can be upgraded freely.

**Networking:** The cluster uses cloudflared tunnels for all external access (no k8s Ingress). A cloudflared tunnel route for `openclaw.srinathh.com` is added to the existing running cloudflared instance — no new cloudflared Deployment needed.

---

## Architecture Overview

```
Twilio WhatsApp API
      │  POST /webhook/twilio-whatsapp
      ▼
cloudflared tunnel (existing) → openclaw Service :18789
      │
  OpenClaw Pod  ◄── operator-managed OpenClawInstance CR
      │   image: official OpenClaw image (unmodified, upgradeable)
      │   plugins: [@srinathh/openclaw-channel-twilio-whatsapp]
      │             (operator init container installs from npm at startup)
      │
  hostPath PV: /srv/openclaw  (MicroK8s hostPath, pinned to t480server)
```

---

## Deliverable 1: Plugin Package — `~/src/openclaw-channel-twilio-whatsapp`

**Public GitHub repo**, published to npm as `@srinathh/openclaw-channel-twilio-whatsapp`.  
Additional private plugins can be added to `spec.plugins` independently — the array supports any mix of npm packages.

### File structure

```
~/src/openclaw-channel-twilio-whatsapp/
├── package.json              # npm package + openclaw plugin manifest
├── tsconfig.json
└── src/
    ├── index.ts              # plugin entry point
    └── channel.ts            # TwilioWhatsAppChannel
```

No Dockerfile — operator init container handles installation from npm.

### `package.json` (key fields)

```json
{
  "name": "@srinathh/openclaw-channel-twilio-whatsapp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "openclaw": {
    "type": "channel",
    "name": "twilio-whatsapp"
  },
  "dependencies": {
    "twilio": "^5.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@openclaw/sdk": "latest"
  }
}
```

### `src/index.ts`

```typescript
import type { OpenClawPlugin } from '@openclaw/sdk';
import { TwilioWhatsAppChannel } from './channel.js';

const plugin: OpenClawPlugin = {
  name: 'twilio-whatsapp',
  async register(api) {
    api.registerChannel(new TwilioWhatsAppChannel(api));
  },
};
export default plugin;
```

### `src/channel.ts` — implementation notes

Adapts `~/src/nanoclaw/src/channels/twilio-whatsapp.ts` to the OpenClaw SDK `Channel` interface. Key differences from nanoclaw:

- No own HTTP server — uses `api.registerHttpRoute('/webhook/twilio-whatsapp', handler)`
- Config from `api.getConfig()` / env vars injected by the operator secret

**Config (env vars in operator Secret):**
```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM         # e.g. whatsapp:+14155238886
TWILIO_WEBHOOK_URL           # public URL (for sig validation + media serving)
OPENCLAW_ALLOWED_SENDERS     # JSON array of allowed whatsapp:+PHONE strings
```

**Inbound webhook handler:**
1. Validate `X-Twilio-Signature` (HMAC-SHA1 via `twilio.validateRequest()`)
2. Parse `application/x-www-form-urlencoded` — reuse `parseFormBody()` from nanoclaw:84-91
3. Reject senders not in `OPENCLAW_ALLOWED_SENDERS`
4. Download media via `_downloadMedia()` — reuse redirect-following Basic Auth logic from nanoclaw:48-79; save to `media/inbound/<MessageSid><ext>` (Twilio SID as filename, same as clawless)
5. Build content with `[mime: path]` tags for each media file (clawless pattern)
6. Call `api.handleInboundMessage({ from, text: content, messageId })`
7. Reply `<Response/>` TwiML (200 OK)

**Outbound media staging** — follow clawless `_stage_media()` exactly ([`channels/whatsapp.py:169-180`](../../../src/clawless/src/clawless/channels/whatsapp.py)):
- Copy local file to `media/outbound/<uuid4hex><ext>` (UUID randomizes filename, prevents enumeration)
- Serve via `GET /webhook/twilio-whatsapp/media/{filename}` registered with `api.registerHttpRoute()`
- Security check: `resolvedPath.parent === outboundDir` only — no extension allowlist needed since UUID names already prevent traversal, but verify resolved path is within `outboundDir` before serving (clawless line 186)
- No directory listing (point route at single file, not dir)

**Outbound `send(to, text, mediaUrls)`** — reuse nanoclaw:132-201:
- Chunk text >1600 chars, send sequentially
- Call `_stageMedia(localPath)` to get public URL, then `client.messages.create()`

---

## Deliverable 2: k8s Manifests — `home_k8s/openclaw/`

Follows the same structure as `home_k8s/clawless/`. No cloudflared Deployment — just add a route to the existing tunnel config.

```
home_k8s/openclaw/
├── namespace.yaml
├── pv.yaml                      # manual hostPath PV with nodeAffinity → t480server
├── pvc.yaml                     # PVC bound to above PV (operator needs a PVC)
├── configmap-template.yaml      # openclaw.json — copy to configmap.yaml before deploy
├── secret-template.yaml         # API keys — copy to secret.yaml before deploy
├── openclaw-instance.yaml       # OpenClawInstance CR
├── service.yaml                 # ClusterIP on 18789
├── kustomization-template.yaml
└── README.md
```

### `namespace.yaml`
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: openclaw
```

### `pv.yaml`
MicroK8s hostPath PV — manual PV is needed here (not the microk8s-hostpath provisioner) because we must pin the physical path to a specific node. The `nodeAffinity` ensures the PV is only usable on t480server, consistent with the pod's `nodeSelector`.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: openclaw-home-pv
spec:
  capacity:
    storage: 10Gi
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: role
              operator: In
              values: [primary]
  hostPath:
    path: /srv/openclaw
    type: DirectoryOrCreate
```

### `pvc.yaml`
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-home
  namespace: openclaw
spec:
  storageClassName: manual
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
```

### `openclaw-instance.yaml`
```yaml
apiVersion: openclaw.rocks/v1alpha1
kind: OpenClawInstance
metadata:
  name: openclaw
  namespace: openclaw
spec:
  # Verify exact image ref from docs.openclaw.ai/install/kubernetes before deploying
  image: ghcr.io/openclaw/openclaw:latest
  nodeSelector:
    role: primary          # pin to t480server — same label as clawless
  plugins:
    - "@srinathh/openclaw-channel-twilio-whatsapp"
    # Add further plugins here (public or private npm packages)
  persistence:
    existingClaim: openclaw-home
  config:
    configMapRef:
      name: openclaw-config
  secretRef:
    name: openclaw-secrets
  gateway:
    port: 18789
```

### `configmap-template.yaml`
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: openclaw-config
  namespace: openclaw
data:
  openclaw.json: |
    {
      "channels": {
        "twilio-whatsapp": {
          "enabled": true,
          "webhookPath": "/webhook/twilio-whatsapp"
        }
      }
    }
```

### `secret-template.yaml`
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-secrets
  namespace: openclaw
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "REPLACE_ME"
  TWILIO_ACCOUNT_SID: "REPLACE_ME"
  TWILIO_AUTH_TOKEN: "REPLACE_ME"
  TWILIO_WHATSAPP_FROM: "whatsapp:+REPLACE_ME"
  TWILIO_WEBHOOK_URL: "https://openclaw.srinathh.com"
  OPENCLAW_ALLOWED_SENDERS: '["whatsapp:+PHONE1"]'
```

### `service.yaml`
```yaml
apiVersion: v1
kind: Service
metadata:
  name: openclaw
  namespace: openclaw
spec:
  type: ClusterIP
  selector:
    app: openclaw      # label set by operator
  ports:
    - port: 18789
      targetPort: 18789
      name: gateway
```

### Cloudflared tunnel update
Add a route to the **existing** cloudflared tunnel config (wherever it lives in this repo):
```yaml
- hostname: openclaw.srinathh.com
  service: http://openclaw.openclaw.svc.cluster.local:18789
```

### `kustomization-template.yaml`
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: openclaw
resources:
  - namespace.yaml
  - pv.yaml
  - pvc.yaml
  - configmap.yaml
  - secret.yaml
  - openclaw-instance.yaml
  - service.yaml
```

---

## Critical Files

| File | Action |
|------|--------|
| `~/src/openclaw-channel-twilio-whatsapp/src/channel.ts` | New — adapted from nanoclaw |
| `~/src/openclaw-channel-twilio-whatsapp/src/index.ts` | New |
| `home_k8s/openclaw/*.yaml` | New — 7 manifest files |
| existing cloudflared config in home_k8s | Edit — add openclaw route |

**Reuse from nanoclaw** (`~/src/nanoclaw/src/channels/twilio-whatsapp.ts`):
- `downloadTwilioMedia()` — lines 48–79
- `parseFormBody()` — lines 84–91
- `sendMessage()` chunking logic — lines 132–201

**Mirror from clawless** (`~/src/clawless/src/clawless/channels/whatsapp.py`):
- `_stage_media()` UUID outbound staging — lines 169–180
- `_serve_media()` parent-dir-only path check — lines 182–190
- `_download_media()` using MessageSid as filename — lines 196–217

---

## Operator Installation Prerequisite (one-time)

```bash
helm install openclaw-operator \
  oci://ghcr.io/openclaw-rocks/charts/openclaw-operator \
  --namespace openclaw-operator-system \
  --create-namespace
```

---

## Pre-flight: Verify Image Name

Before writing the manifests, confirm the correct image tag:
```bash
# Check operator docs or:
helm show values oci://ghcr.io/openclaw-rocks/charts/openclaw-operator | grep image
```

---

## Verification

1. **Publish plugin:**
   ```bash
   cd ~/src/openclaw-channel-twilio-whatsapp && npm publish --access public
   ```

2. **Deploy:**
   ```bash
   kubectl apply -k home_k8s/openclaw/
   kubectl get openclawinstance -n openclaw
   kubectl get pods -n openclaw -w
   ```

3. **Check plugin installed:**
   ```bash
   kubectl logs -n openclaw -l app=openclaw -c init-plugins
   kubectl logs -n openclaw -l app=openclaw | grep twilio-whatsapp
   ```

4. **Test inbound via tunnel:**
   ```bash
   curl -X POST https://openclaw.srinathh.com/webhook/twilio-whatsapp \
     -d "From=whatsapp:+YOUR_NUMBER&Body=Hello&MessageSid=SM123&NumMedia=0"
   ```

5. **Verify node pinning:**
   ```bash
   kubectl get pod -n openclaw -o wide   # must show t480server
   ```
