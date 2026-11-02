/*
 * Normal transport compatibility adapted from @magpie-community/opencode-workbuddy-auth
 * v0.1.30, magpie-community/plugins@575f1e23e7a3e5f9de45875ed0da94c9289eb982.
 * Copyright (c) 2026 magpie-community contributors. MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { CodeBuddyBaseExecutor } from "./codebuddy-base.js";
import { errorResponse } from "../utils/error.js";
import { getWorkBuddySite, buildWorkBuddyHeaders, WORKBUDDY_REQUEST, WORKBUDDY_LEGACY, assertWorkBuddyCredential } from "../config/workbuddy.js";
import { applyCodeBuddyRateLimit } from "../shared/codebuddyRateLimit.js";
import { refreshWorkBuddyToken } from "../services/tokenRefresh/workbuddy.js";
import { normalizeCodeBuddyToolChoice } from "../shared/codebuddyToolChoice.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";

/** Origin-bound transport; never silently delegates migrated credentials to
 * another product or rewrites instructions after a channel rejection. */
export class WorkBuddyExecutor extends CodeBuddyBaseExecutor {
  constructor(provider) {
    const site = getWorkBuddySite(provider);
    super(provider);
    this.config = { baseUrl: site.chatUrl, baseUrls: [site.chatUrl], format: site.format };
  }

  buildUrl(model, stream, urlIndex, credentials) {
    assertWorkBuddyCredential(credentials);
    return getWorkBuddySite(this.provider).chatUrl;
  }

  execute(args) {
    if (args?.credentials?.providerSpecificData?.workbuddyLegacyCredential === true) {
      return Promise.resolve({
        response: errorResponse(WORKBUDDY_LEGACY.status, WORKBUDDY_LEGACY.message),
        transformedBody: args.body,
      });
    }
    return super.execute({ ...args, stream: true });
  }

  transformRequest(model, body, stream, credentials) {
    assertWorkBuddyCredential(credentials);
    return this.transformWorkBuddyRequest(model, body);
  }

  buildHeaders(credentials, stream = true, url, model, conversation = null) {
    assertWorkBuddyCredential(credentials);
    if (!credentials?.accessToken) throw new Error("WorkBuddy requires a bound OAuth accessToken");
    return buildWorkBuddyHeaders(this.provider, credentials, { stream: true, conversation });
  }

  refreshCredentials(credentials, log, proxyOptions = null) {
    return refreshWorkBuddyToken(this.provider, credentials, log, proxyOptions);
  }

  parseError(response, bodyText) {
    return applyCodeBuddyRateLimit(super.parseError(response, bodyText), response, bodyText);
  }

  transformWorkBuddyRequest(model, body) {
    // Do not call the legacy CodeBuddy transforms: they replace/drop system
    // instructions. Copy before adaptation so caller input is never mutated.
    const transformed = normalizeCodeBuddyToolChoice({ ...body, stream: true });
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    transformed.messages = messages.map(message => {
      if (!message || typeof message !== "object") return message;
      if (message.role === ROLE.DEVELOPER) return { ...message, role: ROLE.SYSTEM };
      if (message.role === ROLE.USER && typeof message.content === "string") {
        return { ...message, content: [{ type: OPENAI_BLOCK.TEXT, text: message.content }] };
      }
      return { ...message };
    });
    if (!transformed.messages.some(message => message?.role === ROLE.SYSTEM)) {
      transformed.messages.unshift({ role: ROLE.SYSTEM, content: WORKBUDDY_REQUEST.neutralSystem });
    }

    if (transformed.max_completion_tokens !== undefined) {
      // An explicit max_tokens wins if both OpenAI spellings were supplied.
      if (transformed.max_tokens === undefined) transformed.max_tokens = transformed.max_completion_tokens;
      delete transformed.max_completion_tokens;
    }
    const effort = transformed.reasoning_effort;
    if (WORKBUDDY_REQUEST.disabledReasoning.includes(effort)) {
      delete transformed.reasoning_effort;
      delete transformed.reasoning_summary;
    } else if (effort && transformed.reasoning_summary === undefined) {
      transformed.reasoning_summary = WORKBUDDY_REQUEST.reasoningSummary;
    }
    return transformed;
  }
}

export default WorkBuddyExecutor;
