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
import { CodeBuddyExecutor } from "./codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
import { getWorkBuddySite, resolveWorkBuddySite, buildWorkBuddyHeaders, WORKBUDDY_REQUEST } from "../config/workbuddy.js";
import { applyCodeBuddyRateLimit } from "../shared/codebuddyRateLimit.js";
import { refreshWorkBuddyToken } from "../services/tokenRefresh/workbuddy.js";
import { normalizeCodeBuddyToolChoice } from "../shared/codebuddyToolChoice.js";
import {
  isWorkBuddyRefusal, unflagWorkBuddyMessages, workBuddySystemAsUser,
} from "../shared/workbuddyInstructions.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";

// System prompts WorkBuddy has already refused, by their text. An agent that
// sends the same system prompt every turn is refused once, not on every request:
// its next chat moves the prompt into the user's turn before it is sent.
const refusedSystems = new Set();
const REFUSED_SYSTEMS_MAX = 256;

function systemKey(messages) {
  if (!Array.isArray(messages)) return "";
  const key = messages
    .filter(message => message?.role === ROLE.SYSTEM)
    .map(message => (typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n")
        : ""))
    .join("\n");
  return key.trim() === WORKBUDDY_REQUEST.neutralSystem ? "" : key;
}

function rememberRefusal(key) {
  if (!key) return;
  refusedSystems.add(key);
  if (refusedSystems.size > REFUSED_SYSTEMS_MAX) refusedSystems.delete(refusedSystems.values().next().value);
}

// Test seam: the cache is process-wide, so a suite needs to start from empty.
export function forgetRefusedWorkBuddySystems() {
  refusedSystems.clear();
}

/**
 * WorkBuddy's normal OpenAI-compatible, stream-only transport. Authentication,
 * refresh and account selection belong to the caller. The channel check's
 * refused lines are reworded and a refused system prompt is moved into the user's
 * turn (see shared/workbuddyInstructions.js); no client is impersonated and no
 * caller identity is cloaked. CodeBuddy's legacy executors are deliberately not
 * reused for their request/header transformations.
 */
export class WorkBuddyExecutor extends CodeBuddyBaseExecutor {
  constructor(provider) {
    const site = getWorkBuddySite(provider);
    super(provider);
    this.config = { baseUrl: site.chatUrl, baseUrls: [site.chatUrl], format: site.format };
  }

  // Migration 027 renames the provider id but the account's credential was issued
  // by the CodeBuddy implementation. Such a row must keep the pre-upgrade request
  // shape (its own transform, URL and headers) or a production account that
  // worked before the upgrade could start failing. Only accounts authorized by
  // this build take the WorkBuddy path below.
  legacyDelegate(provider, credentials) {
    if (credentials?.providerSpecificData?.workbuddyLegacyCredential !== true) return null;
    if (provider !== "workbuddy" && provider !== "workbuddy-ai") return null;
    return provider === "workbuddy" ? new CodeBuddyExecutor() : new CodeBuddyIntlExecutor();
  }

  // Legacy CodeBuddy credentials keep the host their tokens were issued by;
  // only the destination is derived, and only from saved server-side evidence.
  buildUrl(model, stream, urlIndex, credentials) {
    const legacy = this.legacyDelegate(this.provider, credentials);
    if (legacy) return legacy.buildUrl(model, stream, urlIndex, credentials);
    return resolveWorkBuddySite(this.provider, credentials?.providerSpecificData || {}).chatUrl;
  }

  execute(args) {
    const legacy = this.legacyDelegate(this.provider, args?.credentials);
    if (legacy) return legacy.execute({ ...args, stream: true });
    // Even non-stream clients use SSE upstream (the router aggregates it).
    // This also applies the shared first-output gate to every upstream request.
    return this.executeWithRefusalRetry({ ...args, stream: true });
  }

  // WorkBuddy refuses a whole chat (11128) when the channel check meets a line it
  // will not accept, and a system prompt it refused before is sent as the user's
  // instructions up front instead of waiting to be refused again. One retry only:
  // a second refusal is the upstream's answer and is passed back unchanged, and
  // the prompt is never rewritten to claim another client.
  async executeWithRefusalRetry(args) {
    const refusedKey = systemKey(args?.body?.messages);
    let body = args.body;
    if (refusedKey && refusedSystems.has(refusedKey)) {
      const moved = workBuddySystemAsUser(body?.messages);
      if (moved) body = { ...body, messages: moved };
    }
    const first = await super.execute({ ...args, body });
    if (first.response?.status !== 400 || !first.response.body) return first;
    // The refusal body is read here to tell it from any other 400; the caller
    // still receives it byte for byte.
    let text;
    try { text = await first.response.clone().text(); } catch { return first; }
    if (!isWorkBuddyRefusal(first.response.status, text)) return first;
    rememberRefusal(systemKey(body?.messages));
    const moved = workBuddySystemAsUser(body?.messages);
    if (!moved) return first;
    try { await first.response.body.cancel?.(); } catch { /* already consumed */ }
    return super.execute({ ...args, body: { ...body, messages: moved } });
  }

  transformRequest(model, body, stream, credentials) {
    const legacy = this.legacyDelegate(this.provider, credentials);
    if (legacy) return legacy.transformRequest(model, body, stream, credentials);
    return this.transformWorkBuddyRequest(model, body);
  }

  buildHeaders(credentials, stream = true, url, model, conversation = null) {
    const legacy = this.legacyDelegate(this.provider, credentials);
    if (legacy) return legacy.buildHeaders(credentials, stream);
    if (!credentials?.accessToken) throw new Error("WorkBuddy requires a bound OAuth accessToken");
    return buildWorkBuddyHeaders(this.provider, credentials, { stream: true, conversation });
  }

  refreshCredentials(credentials, log, proxyOptions = null) {
    // refreshWorkBuddyToken delegates legacy rows to their original CodeBuddy
    // refresher (host, headers and parser unchanged).
    return refreshWorkBuddyToken(this.provider, credentials, log, proxyOptions);
  }

  parseError(response, bodyText) {
    // In particular, 11128 remains the original status and raw body: the retry
    // above happens once, inside execute, and a refusal that survives it is the
    // upstream's answer to this request.
    return applyCodeBuddyRateLimit(super.parseError(response, bodyText), response, bodyText);
  }

  transformWorkBuddyRequest(model, body) {
    // Do not call the legacy CodeBuddy transforms: they replace/drop system
    // instructions. Copy before adaptation so retries never mutate caller input.
    const transformed = normalizeCodeBuddyToolChoice({ ...body, stream: true });
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    transformed.messages = unflagWorkBuddyMessages(messages.map(message => {
      if (!message || typeof message !== "object") return message;
      if (message.role === ROLE.DEVELOPER) return { ...message, role: ROLE.SYSTEM };
      if (message.role === ROLE.USER && typeof message.content === "string") {
        return { ...message, content: [{ type: OPENAI_BLOCK.TEXT, text: message.content }] };
      }
      return { ...message };
    }));
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
