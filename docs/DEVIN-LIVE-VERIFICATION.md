# Devin live verification — 2026-11-06

Verified against an explicitly authorized real Devin account through the local
Spring Mouse development server on port 8007. No credentials, email, organization
identifiers, authorization codes or thinking signatures are recorded here.

## Results

| Check | Result |
| --- | --- |
| Browser PKCE login and persistent account save | Passed |
| Exchange response compatibility | Live response used `token` rather than `sessionToken`; parser now accepts all three documented/observed spellings |
| GetUserStatus identity | Passed after a clean development-server restart |
| Account connectivity probe | HTTP 200, valid true |
| Day/week quota | HTTP 200, Devin Pro, both reported 100% remaining |
| Official model sync | Passed, 320 entries including families and explicit variants (not 320 distinct underlying models) |
| Chat Completions JSON | HTTP 200, expected `DEVIN_OK` |
| Chat Completions SSE + family/effort resolution | HTTP 200, expected `STREAM_OK`, one DONE, actual usage |
| Function call generation | HTTP 200, `echo_probe({value:"TOOL_OK"})`, finish reason tool_calls |
| Function result round trip | HTTP 200, expected `TOOL_ROUNDTRIP_OK` |
| Anthropic Messages compatibility | HTTP 200, expected `MESSAGES_OK`, cache-read usage |
| OpenAI Responses compatibility | HTTP 200, expected `RESPONSES_OK` |

Six short successful inference requests used the account-visible SWE-2 Medium
variant (marked free by the live official catalog); no background inference or
keepalive was enabled. This is not a guarantee about future billing. The test
function was synthetic and ran no shell/file operation.

The status endpoint initially failed inside the hot-reloaded development process
while the same request in a clean process succeeded. After restarting the dev
server, identity, probe and quota all succeeded. No speculative retry-to-the-same
endpoint workaround was retained.

## Scope

This verifies the login, directory, quota and listed API paths for this account
and selected SWE model. It is not a live test of every offered model, paid model
permission, native Claude model thinking/signature behavior, image reasoning, or
large-context compression. Those protocol paths have mock/regression coverage,
not an all-model production certification.

Existing unrelated changes remain in the working tree. No commit, push,
production build or deployment was performed as part of this live verification.
