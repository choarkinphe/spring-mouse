# Mouse agent registration protocol

Mouse is an optional remote execution node. Spring continues to run normally
when no Mouse is registered and all existing channel accounts keep using their
current local execution path.

## 1. Create a registration token

From the dashboard, open **Mouse 节点** and create a token, or call:

```http
POST /api/mouses
Content-Type: application/json

{ "name": "us-east-worker", "ttlSeconds": 600 }
```

The response contains a one-time `registrationToken`. It is displayed only
once and expires after the configured TTL.

## 2. Register Mouse

Mouse reads its Spring URL and registration token from configuration, then
calls:

```http
POST /api/mouses/register
Content-Type: application/json

{
  "registrationToken": "msr_...",
  "name": "mouse-us-east-01",
  "version": "1.0.0",
  "capabilities": ["http-provider-execute"],
  "callbackUrl": "https://mouse-host:9101",
  "metadata": { "region": "us-east" }
}
```

Spring returns a Mouse identity, an access token for heartbeats, and an
execution token used by Spring when dispatching provider tasks:

```json
{
  "mouse": { "id": "...", "name": "mouse-us-east-01" },
  "accessToken": "mse_...",
  "executionToken": "msx_..."
}
```

The access token should be stored securely by Mouse. Spring stores only its
SHA-256 hash and can disable or delete the identity.

## 3. Send heartbeats

Mouse should send a heartbeat every 30 seconds. Spring marks a non-disabled
Mouse online for 90 seconds after the latest heartbeat.

```http
POST /api/mouses/heartbeat
Authorization: Bearer mse_...
Content-Type: application/json

{
  "version": "1.0.0",
  "capabilities": ["http-provider-execute"],
  "metadata": {
    "callbackUrl": "https://mouse-host:9101",
    "activeTasks": 0
  }
}
```

## 4. Execute a provider task

Spring sends the already-translated provider request to:

```http
POST {callbackUrl}/v1/execute
Authorization: Bearer msx_...
Content-Type: application/json
```

The task contains a normal HTTP request:

```json
{
  "taskId": "...",
  "attempt": 1,
  "request": {
    "method": "POST",
    "url": "https://provider.example/v1/chat/completions",
    "headers": { "Authorization": "Bearer ..." },
    "body": "{...}"
  }
}
```

Mouse forwards the request to the channel and returns the channel response
unchanged, including streaming bodies. Spring continues to handle translation,
usage accounting, retries, account fallback, and OAuth token refresh.

The bundled agent implements this protocol:

```bash
node mouse/agent.mjs \
  --spring-url https://spring.example.com \
  --registration-token msr_... \
  --callback-url https://mouse-host:9101 \
  --port 9101
```

The identity and tokens are stored in `~/.spring-mouse-agent/agent.json`.
Subsequent restarts can omit the registration token and reuse that identity.

## Current phase behavior

- Channel accounts without a Mouse keep using the existing Spring execution.
- A channel account with an online Mouse sends its provider HTTP request through
  that Mouse and receives the channel response through Spring.
- A selected Mouse must be online with a callback URL and execution token.
  Spring does not silently fall back to local execution, because that would
  change the channel network environment.
- The transport is enabled for executors using the common BaseExecutor HTTP
  flow; highly specialized executors may continue to execute locally until they
  are migrated individually.
- Proxy configuration is not applied on the Spring side when Mouse transport is
  active. Configure the network/proxy on the Mouse host.
