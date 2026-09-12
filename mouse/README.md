# Mouse agent runtime

Mouse is a standalone Node.js process. It does not require the Spring web
dependencies or database.

The agent dials Spring and holds one long-lived SSE tunnel open. Spring pushes
provider tasks down that connection and the agent answers on a request of its
own, so both directions are outbound. Nothing has to be able to reach the agent:
a node needs no public IP and publishes no port.

## Local debug

Use the VS Code launch configs in `.vscode/launch.json`.

Mouse environment can be configured directly in VS Code:

```json
{
  "SPRING_URL": "http://localhost:8007",
  "MOUSE_TOKEN": "mst_..."
}
```

The same values can be passed as CLI options:

```bash
node mouse/agent.mjs --spring-url http://localhost:8007 --token mst_...
```

Replace `mst_...` with the token shown when the node is created in the
dashboard. That token *is* the node's identity — one token, one node — and it is
shown exactly once. Re-issuing it from the dashboard (`启动命令`) invalidates the
old one and drops the tunnel it was holding.

## Docker

Nothing has to be copied to the target host. The container starts from the
official Node image and downloads its own runtime from the Spring it dials, so
this single command is the whole deployment:

```bash
docker run -d --name spring-mouse-agent --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --log-opt max-size=20m --log-opt max-file=3 \
  -e SPRING_URL=https://spring.example.com \
  -e MOUSE_TOKEN=mst_... \
  node:22-alpine \
  sh -c 'wget -qO /tmp/agent.mjs "$SPRING_URL/api/mouses/agent" && exec node /tmp/agent.mjs'
```

The dashboard generates this command with the real token and Spring address
filled in; the token is shown once, so copy it from there rather than retyping.

The container publishes no ports. Its only listener is the healthcheck on
`127.0.0.1:9101` inside the container, which is why the node can sit behind NAT:

```bash
docker exec spring-mouse-agent wget -qO- http://127.0.0.1:9101/healthz
```

The agent reconnects on its own with a capped backoff if the tunnel drops, so a
Spring restart or a network blip needs no intervention. It exits non-zero only
when it cannot start at all (missing token, unreachable Spring URL).

Building your own image from `Dockerfile.mouse` still works for hosts that
cannot reach Docker Hub or that need the agent version pinned at deploy time.

## Where the code lives

- `mouse/agent.mjs` — the whole agent: tunnel loop, SSE parsing, task execution.
  Spring serves this exact file at `GET /api/mouses/agent`, which is how a new
  node gets its runtime without an upload step.
- `MOUSE_AGENT_PROTOCOL.md` — the wire protocol, including the frames Spring
  sends and the shape of the reply.
