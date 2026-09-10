# Mouse agent runtime

Mouse is a standalone Node.js process. It does not require the Spring web
dependencies or database.

## Local debug

Use the VS Code launch configs in `.vscode/launch.json`:

- **调试 Mouse Agent (新注册)**: starts a fresh agent with the environment
  configured in each launch configuration's `env` block.
- **调试 Mouse Agent (复用已保存身份)**: reuses the callback/execution identity
  persisted in `data/mouse-agent-state.json`; the access token is still required
  for heartbeat authorization.

Mouse environment can be configured directly in VS Code:

```json
{
  "SPRING_URL": "http://localhost:8007",
  "MOUSE_TOKEN": "mst_...",
  "MOUSE_CLIENT_ID": "local-mouse-01",
  "MOUSE_CALLBACK_URL": "http://localhost:9101"
}
```

The same values can be passed as CLI options:

```bash
node mouse/agent.mjs \
  --spring-url http://localhost:8007 \
  --token mst_... \
  --client-id local-mouse-01 \
  --callback-url http://localhost:9101
```

Replace `mst_...` with a token from the Spring dashboard. The callback URL must
be reachable from Spring. For local Spring and Mouse, the default
`http://localhost:9101` is sufficient.

## Docker

Build and run the standalone image:

```bash
SPRING_URL=https://spring.example.com \
MOUSE_TOKEN=mst_... \
MOUSE_CLIENT_ID=mouse-us-east-01 \
MOUSE_CALLBACK_URL=https://mouse.example.com:9101 \
MOUSE_NAME=mouse-us-east-01 \
docker compose -f docker-compose.mouse.yml up -d --build
```

`MOUSE_CLIENT_ID` is the stable unique identity. The same `MOUSE_TOKEN` can
authenticate multiple Mouse processes. Keep the token configured on restarts
because it authorizes heartbeat requests. Rotating or deleting the token in
Spring revokes access for every Mouse using it:

```bash
SPRING_URL=https://spring.example.com \
MOUSE_TOKEN=mst_... \
MOUSE_CLIENT_ID=mouse-us-east-01 \
MOUSE_CALLBACK_URL=https://mouse.example.com:9101 \
docker compose -f docker-compose.mouse.yml up -d
```
