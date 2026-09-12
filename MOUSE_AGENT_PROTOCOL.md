# Mouse agent tunnel protocol

Mouse is an optional remote execution node. Spring continues to run normally
when no Mouse is connected and all existing channel accounts keep using their
current local execution path.

## Connection model

The node dials Spring, not the other way round. It holds one long-lived SSE
request open, Spring pushes tasks down that request, and the node answers on a
second request of its own. Both directions are outbound from the node.

The consequence is the point: **a Mouse needs no reachable address**. There is
no callback URL to configure, no inbound port to publish and no public IP
required. A node behind NAT works exactly like one on the same host.

Spring tracks a node by the tunnel it is holding. Opening a tunnel is what makes
a node `online`; the tunnel closing is what makes it `offline`.

## 1. Create the Mouse

The node is provisioned first — from the dashboard (**Mouse 节点** → **新建 Mouse**)
or over the API:

```http
POST /api/mouses
Content-Type: application/json

{ "name": "tokyo-edge-01" }
```

The response carries the node plus its own `token`, shown exactly once:

```json
{
  "mouse": { "id": "...", "clientId": "tokyo-edge-01-6da85af6", "status": "unregistered" },
  "token": "mst_..."
}
```

A freshly created node reports `status: "unregistered"`. Nothing about the node's
network location is stored, because nothing needs it.

## 2. Open the tunnel

```http
GET /api/mouses/tunnel?version=2.0.0
Authorization: Bearer mst_...
Accept: text/event-stream
```

The token *is* the node's identity, so the node never has to say which node it
is. A stream opens with a `ready` frame:

```
event: ready
data: {"mouseId":"...","clientId":"tokyo-edge-01-6da85af6","pingIntervalSeconds":15}
```

Spring then keeps the stream alive with a `ping` frame every 15 seconds. A node
that stops answering pings loses its tunnel and is reported offline.

Only one tunnel per node is kept: a second connection replaces the first, and
the replaced stream is closed from the Spring side.

## 3. Receive a task

```
event: task
data: {"taskId":"...","request":{"method":"POST","url":"https://provider.example/v1/chat/completions","headers":{"Authorization":"Bearer ..."},"body":"{...}"}}
```

`request` is a normal HTTP request that Spring has already built and
translated for the channel. The node forwards it unchanged — Spring keeps
handling translation, usage accounting, retries, account fallback and OAuth
token refresh.

Tasks are independent: a node should run them concurrently rather than in
sequence, and one slow provider must not block the tasks behind it.

```
event: cancel
data: {"taskId":"..."}
```

Spring sends `cancel` when the caller went away or the task ran out of time. The
node should abort the matching provider request.

## 4. Answer the task

The response is replayed as a request of the node's own:

```http
POST /api/mouses/tunnel/result
Authorization: Bearer mst_...
X-Mouse-Task-Id: <taskId>
X-Upstream-Status: 200
X-Upstream-Headers: <base64 of a JSON object of response headers>
Content-Type: application/octet-stream

<the upstream response body, streamed>
```

The status line and headers have to travel ahead of the body, so they go in
headers; the body is the upload itself. The request stays open for as long as
the upstream response lasts — Spring reads the body from it directly, which is
what keeps streaming responses streaming.

Two details the agent has to get right:

- `Content-Encoding` and `Content-Length` describe the original transfer, not
  the bytes being replayed. A runtime that decodes the response (`fetch` does)
  must not forward either, or the receiver will misread the payload.
- A failed provider call still has to be reported, as `X-Upstream-Status: 502`
  with a JSON error body. Silence looks identical to a node that died, and only
  costs the caller a timeout.

## 5. Liveness

There is no heartbeat to send. Holding the tunnel open *is* the heartbeat, and
Spring refreshes the node's `lastHeartbeatAt` on the `ready` frame and on every
`ping`. A node that cannot hold a stream is not usable as a node, so no separate
signal is needed to describe it.

The dashboard shows `online` while a tunnel is connected and `offline` once it
is not.

## Token lifecycle

- One token belongs to exactly one Mouse. The token is the node's identity, so a
  start command is bound to the node it was generated for.
- `clientId` is derived from the node name when the node is created. It is
  descriptive, for the dashboard — the agent does not need to know it.
- Tokens do not expire. Re-issuing one (`POST /api/mouses/{id}/access-token`)
  returns a new plaintext once, immediately rejects the previous token and drops
  whatever tunnel the node was holding.
- Disabling a node drops its tunnel; deleting a node rejects its token outright.

## Running the bundled agent

The node needs nothing from this repository. It downloads its own runtime from
the Spring it is about to connect to — `GET /api/mouses/agent` serves exactly the
`mouse/agent.mjs` in this checkout — so one command is all a fresh host needs:

```bash
docker run -d --name spring-mouse-agent --restart unless-stopped \
  -e SPRING_URL=https://spring.example.com \
  -e MOUSE_TOKEN=mst_... \
  node:22-alpine \
  sh -c 'wget -qO /tmp/agent.mjs "$SPRING_URL/api/mouses/agent" && exec node /tmp/agent.mjs'
```

Running it straight from a checkout works too:

```bash
node mouse/agent.mjs --spring-url https://spring.example.com --token mst_...
```

The agent opens a local healthcheck on `127.0.0.1:9101/healthz` and nothing else;
it never listens on an interface Spring has to reach.

## Current phase behavior

- Channel accounts without a Mouse keep using the existing Spring execution.
- A channel account bound to a Mouse sends its provider HTTP request through
  that node and receives the channel response through Spring.
- A bound node must be online — that is, holding a tunnel. Spring does not
  silently fall back to local execution, because that would change the channel
  network environment.
- The transport is enabled for executors using the common BaseExecutor HTTP
  flow; highly specialized executors may continue to execute locally until they
  are migrated individually.
- Proxy configuration is not applied on the Spring side when Mouse transport is
  active. Configure the network/proxy on the Mouse host.
