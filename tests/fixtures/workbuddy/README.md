# WorkBuddy isolated integration fixture

Reference: `@magpie-community/opencode-workbuddy-auth@0.1.30`, commit `575f1e23e7a3e5f9de45875ed0da94c9289eb982`; license in `THIRD_PARTY_NOTICES.md`.

Run the Claude Preview configuration `workbuddy-fixture` (port 8083). It invokes `start.sh`, creates an empty temporary HOME and DATA_DIR, seeds two migrated legacy CodeBuddy accounts plus one separately authorized synthetic account, disables host bootstrap, and mocks the WorkBuddy and old CodeBuddy origins. Other server-side external fetches are rejected by the shared smoke preload. The existing dashboard can still issue its own browser-side analytics requests; this is not an OS network sandbox.

In the dashboard choose Add channel → WorkBuddy (China) or WorkBuddy AI → OAuth. Authorization is simulated and does not contact a real login service. Both products use same-state token/account lookup and persist synthetic UID plus product provenance. Model discovery returns the synthetic `fixture-model`; synchronization and `/v1/chat/completions` can be tested without quota or real credentials.

Migrated CodeBuddy credentials are rejected locally by chat, refresh, catalog, usage, probe and check-in paths; they are not silently delegated to the old executor or sent to a new origin. WorkBuddy-only legacy pools return a reauthorization error. The fresh synthetic account exercises the new origin-bound transport using a truthful Spring-Mouse User-Agent, preserving supplied instructions and passing channel refusals back without rewriting/retry. The fixture does not prove upstream entitlement; reauthorization does not lift an account restriction.

Coverage: `tests/unit/workbuddy-{oauth,executor,services,registration}.test.js` plus existing CodeBuddy/refresh/model-sync suites. Tests are Vitest; run from `tests/`.

Known verification limits: no live WorkBuddy entitlement/callability check has been performed, so offline success is not proof that a particular account passes upstream access policy. This fixture may log the existing `usageRollupDay` missing-table warning during inline usage updates; mocked chat still returns HTTP 200. The existing OAuthModal lint error `react-hooks/set-state-in-effect` predates these changes. Usage package presentation, check-in, existing account migration and automatic production deployment are not part of this adapter.
