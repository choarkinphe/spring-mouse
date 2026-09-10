# Mouse agent registration protocol

Mouse is an optional remote execution node. Spring continues to run normally
when no Mouse is registered and all existing channel accounts keep using their
current local execution path.

## 1. Create an access token

From the dashboard, open **Mouse 节点** and create a token, or call:

```http
POST /api/mouses
Content-Type: application/json

{ "name": "production-mice", "ttlSeconds": 604800 }
```

The response contains an `accessToken`. It is displayed only once. A token is
not owned by one Mouse: multiple Mouse processes may use the same active token.
Each Mouse must report its own stable `clientId`. Tokens may be permanent,
expiry-based, rotated, or deleted.

## 2. Register Mouse

Mouse reads its Spring URL and registration token from configuration, then
calls:

```http
POST /api/mouses/register
Content-Type: application/json

{
  "clientId": "mouse-us-east-01",
  "name": "mouse-us-east-01",
  "version": "1.0.0",
  "capabilities": ["http-provider-execute"],
  "callbackUrl": "https://mouse-host:9101",
  "metadata": { "region": "us-east" }
}
```

The token is sent in the Authorization header. Spring returns a Mouse identity
and an execution token used by Spring when dispatching provider tasks:

```json
{
  "mouse": { "id": "...", "name": "mouse-us-east-01" },
  "executionToken": "msx_..."
}
```

Spring stores only the access token's SHA-256 hash. The callback execution
token is specific to the Mouse identity.

## 3. Send heartbeats

Mouse should send a heartbeat every 30 seconds. Spring marks a non-disabled
Mouse online for 90 seconds after the latest heartbeat.

```http
POST /api/mouses/heartbeat
Authorization: Bearer mse_...
Content-Type: application/json

{
  "clientId": "mouse-us-east-01",
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

## Token lifecycle

- One token can authorize many Mouse registrations and heartbeats.
- `clientId` is the stable unique key for a Mouse.
- A token can have `expiresAt`, be rotated, or be deleted.
- Deleting a token immediately rejects registration and heartbeat requests for
  every Mouse that used it.

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
