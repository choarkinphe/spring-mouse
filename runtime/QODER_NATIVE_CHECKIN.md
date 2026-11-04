# Qoder official native check-in

This integration performs the real campaign flow rather than presenting a guide:

1. Run the pinned official Qoder 1.1.82 native helper on this device.
2. Read the first identity JSON line, then terminate and reap that child.
3. Send the native identity to the regional campaign GET.
4. Claim **only** an active `CLAIM_BENEFIT` / `CLAIMABLE` campaign, under the shared
   persisted lease and per-account daily marker.
5. Accept success only when the official claim response says `CLAIMED`.

A 401/403 claim is not replayed. An absent activity or refusal is reported as such.
No device identifiers, VM flags, subscription state or eligibility are spoofed.
A valid native identity is not a guarantee that Qoder offers a campaign.

## Docker (glibc companion)

The application uses Alpine; the official Linux helper requires glibc. Keep it
in the optional `Dockerfile.qoder-identity` companion instead of adding an
unverified compatibility layer to the gateway. `compose.qoder-identity.yml` adds:

- A glibc runtime, running as UID 1000 with no Linux capabilities.
- No TCP listener: the gateway accesses a 0600 Unix socket through a shared volume.
- A separate persistent state volume for this device's official native state.
- A fixed, administrator-configured socket. DB/account fields cannot choose a
  runtime binary, network address, or executable path.

Start the stack with the ordinary Compose file plus this override. The companion
must be healthy before the gateway starts. No account access/refresh token is
sent to the companion; only `region` is accepted. It returns native identity to
the gateway, which alone authenticates and calls Qoder.

Artifacts are fetched from the official package's pinned CDN location, verified
against the pinned bundle hash, then extracted as data and verified again against
the per-architecture binary hash. A mismatch aborts the build. Neither the bundle
nor its scripts are evaluated. The native helper itself runs only in the glibc
runtime and requires networking for its own official initialization.

## Verification evidence and limits

- Real official arm64 helper produced valid fields in an isolated glibc container.
- The new Node lifecycle executed it and shut it down successfully (~5.4 seconds).
- Download tampering, header injection and arbitrary paths are rejected by tests.
- CN still works without the optional native helper.
- Mocked CLAIMED results are not proof of actual reward delivery; live GET/claim
  results must be recorded separately. Never report a query as a claim.
- No production image, Compose config or auto-check-in switch is changed just by
  adding these files. Publishing/deployment is a separate action.
