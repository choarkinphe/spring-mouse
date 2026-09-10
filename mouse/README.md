# Mouse agent runtime

Mouse is a standalone Node.js process. It does not require the Spring web
dependencies or database.

## Local debug

Use the VS Code launch configs in `.vscode/launch.json`:

- **调试 Mouse Agent (新注册)**: starts a fresh agent and consumes the
  one-time registration token.
- **调试 Mouse Agent (复用已保存身份)**: reuses the identity persisted in
  `data/mouse-agent-state.json`; no registration token is needed.

Replace the `msr_...` token from the Spring dashboard before launching. The
callback URL must be reachable from Spring. For local Spring and Mouse, the
default `http://localhost:9101` is sufficient.

## Docker

Build and run the standalone image:

```bash
SPRING_URL=https://spring.example.com \
MOUSE_REGISTRATION_TOKEN=msr_... \
MOUSE_CALLBACK_URL=https://mouse.example.com:9101 \
MOUSE_NAME=mouse-us-east-01 \
docker compose -f docker-compose.mouse.yml up -d --build
```

The registration token is consumed on first startup and then persisted in the
`spring-mouse-agent-data` volume. Later restarts can omit
`MOUSE_REGISTRATION_TOKEN`:

```bash
SPRING_URL=https://spring.example.com \
MOUSE_CALLBACK_URL=https://mouse.example.com:9101 \
docker compose -f docker-compose.mouse.yml up -d
```
