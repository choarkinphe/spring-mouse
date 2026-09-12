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

Build and run the standalone image:

```bash
SPRING_URL=https://spring.example.com \
MOUSE_TOKEN=mst_... \
docker compose -f docker-compose.mouse.yml up -d --build
```

The container publishes no ports. Its only listener is the healthcheck on
`127.0.0.1:9101` inside the container, which is why the node can sit behind NAT:

```bash
docker compose -f docker-compose.mouse.yml exec mouse wget -qO- http://127.0.0.1:9101/healthz
```

The agent reconnects on its own with a capped backoff if the tunnel drops, so a
Spring restart or a network blip needs no intervention. It exits non-zero only
when it cannot start at all (missing token, unreachable Spring URL).

## Where the code lives

- `mouse/agent.mjs` — the whole agent: tunnel loop, SSE parsing, task execution.
- `MOUSE_AGENT_PROTOCOL.md` — the wire protocol, including the frames Spring
  sends and the shape of the reply.
