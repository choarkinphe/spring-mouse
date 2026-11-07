# Devin verification fixtures

`start.sh` launches an isolated synthetic gateway on port 8099, after inspecting
port ownership and waiting for `/api/health`. It blocks unconfigured upstream
fetches and never uses real account credentials. It is not a live-account test.

`magpie-model-configs-1015.bin` is copied unchanged from
`magpie-community/plugins/packages/devin/testdata/model-configs-1015.bin`, commit
`749e9dd12a5401cc11a701b7598c7ce32fcd7259` (MIT, copyright 2026
magpie-community contributors), 4,747 bytes. It is only parsed as protobuf data,
never executed. License notice: `THIRD_PARTY_NOTICES.md`.

Catalog regression tests check SWE-2's free variants versus paid Lightning,
image capability, family identifiers, context/output limits and official prices.
