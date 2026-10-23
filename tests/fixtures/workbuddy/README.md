# WorkBuddy isolated integration fixture

Reference: `@magpie-community/opencode-workbuddy-auth@0.1.30`, commit `575f1e23e7a3e5f9de45875ed0da94c9289eb982`; license in `THIRD_PARTY_NOTICES.md`.

Run the Claude Preview configuration `workbuddy-fixture` (port 8083). It invokes `start.sh`, creates an empty temporary HOME and DATA_DIR, seeds a disabled legacy CodeBuddy account, disables host bootstrap, and mocks only the two WorkBuddy origins. Other server-side external fetches are rejected by the shared smoke preload. The existing dashboard can still issue its own browser-side analytics requests; this is not an OS network sandbox.

In the dashboard choose Add channel → WorkBuddy (China) or WorkBuddy AI → OAuth. Authorization is simulated and does not contact a real login service. Both products use same-state token/account lookup and persist synthetic UID plus product provenance. Model discovery returns the synthetic `fixture-model`; synchronization and `/v1/chat/completions` can be tested without quota or real credentials.

The two new channels do not migrate, relabel, refresh or send any existing CodeBuddy credential to a new origin. Reauthorize deliberately in the correct product to use a real account. The normal adapter preserves supplied instructions and does not implement rejection-triggered prompt rewriting or client-attestation bypasses.

Coverage: `tests/unit/workbuddy-{oauth,executor,services,registration}.test.js` plus existing CodeBuddy/refresh/model-sync suites. Tests are Vitest; run from `tests/`.

Known verification limits: no live WorkBuddy entitlement/callability check has been performed, so offline success is not proof that a particular account passes upstream access policy. This fixture may log the existing `usageRollupDay` missing-table warning during inline usage updates; mocked chat still returns HTTP 200. The existing OAuthModal lint error `react-hooks/set-state-in-effect` predates these changes. Usage package presentation, check-in, existing account migration and automatic production deployment are not part of this adapter.
