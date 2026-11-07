# Third-party notices

## Devin direct model protocol

The Devin browser PKCE authentication and Connect-RPC / Protobuf model adapter
are informed by and adapted from `router-for-me/CLIProxyAPI`, pinned commit
`c2f402b45643f0740d70b9010fd7d8d0aab7ef65` (MIT). This integration does not bundle
or execute the Devin CLI, and does not enable the separate local ACP agent.

Source: https://github.com/router-for-me/CLIProxyAPI/tree/c2f402b45643f0740d70b9010fd7d8d0aab7ef65

The current Devin login exchange, request normalization, model families, quota,
cache marks, schema and tool-history compatibility follow
`@magpie-community/opencode-devin-auth` 0.1.37 at `magpie-community/plugins`
commit `749e9dd12a5401cc11a701b7598c7ce32fcd7259` (`packages/devin`, MIT).
Copyright (c) 2026 magpie-community contributors. The Magpie MIT license text is
included below under the Qoder catalog and campaign protocol notice.

Source: https://github.com/magpie-community/plugins/tree/749e9dd12a5401cc11a701b7598c7ce32fcd7259/packages/devin

### MIT License — CLIProxyAPI

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## WorkBuddy protocol adapter

The WorkBuddy OAuth, refresh, model catalog and normal request compatibility code is adapted from `@magpie-community/opencode-workbuddy-auth` version **0.1.30**, published from `magpie-community/plugins` commit `575f1e23e7a3e5f9de45875ed0da94c9289eb982` (`packages/workbuddy`).

Source: https://github.com/magpie-community/plugins/tree/575f1e23e7a3e5f9de45875ed0da94c9289eb982/packages/workbuddy

The channel-refusal handling in `open-sse/shared/workbuddyInstructions.js` and
`open-sse/executors/workbuddy.js` follows the same upstream design (refused-line
rewording, one instruction-relocation retry, and a cache of system prompts already
refused), re-measured against `www.workbuddy.ai` on 2026-10-24. It differs from
upstream in two ways: the rewording table is only the lines measured to be refused
today, and no request is ever re-signed as another client — the instructions are
kept and only the objected-to wording changes. Existing CodeBuddy credentials are
not migrated across products.

## Qoder catalog and campaign protocol

Qoder / Qoder CN model scene merging, credit multipliers/promotions and daily
campaign check-in protocol are adapted from `magpie-community/plugins` commit
`270b228a964dc4f7fb55b211e23f7a2c7b7329f6` (`packages/qoder`, MIT).
WorkBuddy's `credits: "x…"` catalog metadata is documented by the same revision's
`packages/workbuddy/testdata/config-561.json`. No third-party native binary is
bundled or downloaded; check-in uses an existing official installation if available.

Source: https://github.com/magpie-community/plugins/tree/270b228a964dc4f7fb55b211e23f7a2c7b7329f6/packages/qoder

### MIT License

Copyright (c) 2026 magpie-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
