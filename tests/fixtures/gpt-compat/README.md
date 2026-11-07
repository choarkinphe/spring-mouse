# Isolated GPT compatibility proof

Start Claude Preview configuration `gpt-compat-fixture` (8085). The unified `start.sh` creates temporary HOME/DATA_DIR, seeds synthetic OpenAI/Codex accounts, checks health, and cleans up only its child processes. An occupied port is an error; unrelated services are not stopped.

`preload.cjs` intercepts only the exact official OpenAI Chat/Responses and Codex chat URLs, returning synthetic JSON/SSE that echoes the outbound body. Other server-side external global fetch calls are rejected by the shared smoke guard. It never uses real credentials or verifies provider entitlement. The dashboard's existing browser-side analytics are not blocked by this server preload. Its automatic Codex usage request returns 500 because billing is deliberately not mocked.

Verified through Browser fetch against the real Next gateway:

- `/v1/responses`: JSON default and SSE preserve native Responses body/endpoint.
- `/v1/chat/completions` + `openai/o3`: output limit becomes max_completion_tokens.
- `/v1/chat/completions` + `cx/gpt-5.4`: first rule stays in instructions, later developer/system rules stay in input in order.
- Nonempty previous_response_id / Responses conversation: 400 before account routing, requiring complete input history.

Stop with Preview tools when finished. This is not an OS network sandbox and is not a real-provider success check.
