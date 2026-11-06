# Devin model proxy

Spring Mouse's `devin` provider calls the model backend used by Devin CLI,
following Magpie's Devin protocol adapter at
`magpie-community/plugins/packages/devin`, commit
`749e9dd12a5401cc11a701b7598c7ce32fcd7259` (0.1.37, MIT).
It is independent of the disabled `devin-cli` local ACP agent bridge. No CLI or
host shell/file tools are started. Client-side tool calls return to the client.

## Connect an account

1. In **渠道管理**, add **Devin**, then **开始授权**.
2. Sign in through the official Devin browser page. Local deployments receive a
   callback on a random IPv4 loopback port. For remote/container deployments,
   choose **改用手动授权码** and paste the authorization code, not a session token.
3. Open **模型管理 → 同步模型**. The account's `GetCliModelConfigs` directory
   supplies model families, effort variants, images, free tiers and token prices.
4. Use `dvn/<model-family>` or `devin/<official-UID>` at the existing `/v1/*`
   endpoint. Families select the account's default variant, or the nearest
   available requested reasoning effort (ties choose the higher effort), as
   Magpie does. Explicit variant UIDs remain directly addressable.

PKCE verifiers are server-side, expire after ten minutes and are single-use.
A restart requires restarting the pending login. Tokens are persistent session
credentials: no fabricated refresh token or expiry is stored. Reauthorize if
revoked. Same-email organizations retain separate account identities.

## Protocol compatibility

- Browser PKCE code exchange uses `ExchangeDevinCLIPKCECode`; account identity
  and plan windows use `GetUserStatus`.
- Connect-Protobuf chat, gzip, split-frame decoding, cancellation, bounded input,
  error trailers and truncated/empty response checks follow the native protocol.
- Text, system/developer instructions, function schemas, streamed tool calls,
  tool results, interrupted calls and safe reversible tool IDs are adapted as in
  Magpie. Tool descriptions are relocated to the prompt to avoid upstream errors.
- Structured output and tool-choice instructions are represented at the prompt
  level where the wire protocol has no dedicated enforcement field; they are
  not rejected just because the adapter lacks a native field. This is not a
  claim of server-enforced strict JSON or forced tool selection.
- Inline image data and tool-result images are preserved. Magpie itself does not
  fetch external image URLs in its Devin encoder. No special Devin-only remote
  fetch restriction is added here; ordinary gateway preprocessing still applies.
- Native Anthropic Messages input retains original content blocks, cache marks,
  thinking and signatures without a lossy OpenAI request pivot. Output is adapted
  to the client's format; signature and cache usage regression tests cover it.
- JSON and SSE expose real upstream usage; session credentials and fingerprints
  are redacted from request diagnostics.

Mouse's existing remote transport carries JSON rather than binary Connect RPC,
so its picker remains disabled for this executor. This is a gateway transport
boundary, not a Devin account or model restriction. Cache keep-alive is not
started automatically: Magpie also defaults it off because it consumes quota.

## Quota and verification

Day/week quota, ACU and paid balance are read from the account status. Missing
zero values on quota-billed plans are interpreted as exhausted when a reset is
present, not as unlimited. Directory discovery alone does not prove inference
permission. Free model tiers come from the official directory, not name guesses.

The `devin-fixture` Desktop Preview starts `tests/fixtures/devin/start.sh`, uses a
temporary database/home and mocks all upstream calls. It does not prove live
login or billing. Live checks require a real browser authorization and small
explicit test requests. No background inference or keep-alive is enabled.

Run focused tests from the repository root, excluding archived repository copies:

```bash
./tests/node_modules/.bin/vitest run --config tests/vitest.config.js --exclude '.code/**' tests/unit/devin-models.test.js tests/unit/devin-protocol.test.js tests/unit/devin-executor.test.js tests/unit/devin-integration.test.js tests/unit/devin-oauth.test.js tests/unit/devin-usage.test.js
```

Protocol references and MIT notices are in `THIRD_PARTY_NOTICES.md`.
