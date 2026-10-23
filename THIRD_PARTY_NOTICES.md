# Third-party notices

## WorkBuddy protocol adapter

The WorkBuddy OAuth, refresh, model catalog and normal request compatibility code is adapted from `@magpie-community/opencode-workbuddy-auth` version **0.1.30**, published from `magpie-community/plugins` commit `575f1e23e7a3e5f9de45875ed0da94c9289eb982` (`packages/workbuddy`).

Source: https://github.com/magpie-community/plugins/tree/575f1e23e7a3e5f9de45875ed0da94c9289eb982/packages/workbuddy

This adaptation excludes upstream channel-refusal prompt rewriting, instruction relocation, refusal caching and rejection-triggered evasion retries. Existing CodeBuddy credentials are not migrated across products.

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
