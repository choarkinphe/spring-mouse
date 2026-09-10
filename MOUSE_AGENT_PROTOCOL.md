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
  "capabilities": ["openai-compatible"],
  "metadata": { "region": "us-east" }
}
```

Spring returns a Mouse identity and a long-lived access token:

```json
{
  "mouse": { "id": "...", "name": "mouse-us-east-01" },
  "accessToken": "mse_..."
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
  "capabilities": ["openai-compatible"],
  "metadata": { "activeTasks": 0 }
}
```

## Current first-phase behavior

- Channel accounts without a Mouse keep using the existing Spring execution.
- Channel account creation/update accepts an optional online `mouseId`.
- A selected Mouse must be online; clearing it restores local execution.
- Task dispatch and remote execution will be added in a later phase.
