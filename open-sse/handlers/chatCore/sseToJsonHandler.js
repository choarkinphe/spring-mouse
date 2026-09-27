import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS, NON_STREAM_RESPONSE_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { runWithAbortDeadline } from "../../utils/abortable.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { ROLE, RESPONSES_ITEM, CLAUDE_STOP } from "../../translator/schema/index.js";
import { classifyRawSSEBlock } from "../../utils/routingOutcome.js";
import { extractUsage, mergeUsage } from "../../utils/usageTracking.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";

/**
 * Build a Claude `Message` from a completed Responses-API turn.
 *
 * A Claude client hitting a forced-streaming provider (Codex) used to fall through
 * to the OpenAI ChatCompletion shape, so the caller rejected an otherwise valid 200
 * with "body is JSON but not a Message". The block shape here mirrors what the
 * streaming translator emits (`openai-to-claude.js`), so a non-streaming and a
 * streaming caller see the same structure.
 */
function buildClaudeMessage({ jsonResponse, textContent, toolCalls, usage, model }) {
  const content = [];
  if (textContent) content.push({ type: "text", text: textContent });
  for (const call of toolCalls || []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = {}; }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }

  // Claude reports cached tokens in its own fields rather than folding them into
  // input_tokens, so a cache-heavy turn does not look like a huge prompt.
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const inputTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate;

  return {
    id: jsonResponse.id || `msg_${Date.now()}`,
    type: "message",
    role: ROLE.ASSISTANT,
    model: jsonResponse.model || model,
    content,
    stop_reason: (toolCalls || []).length > 0 ? CLAUDE_STOP.TOOL_USE : CLAUDE_STOP.END_TURN,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: usage.output_tokens || 0,
      ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
    },
  };
}

function textFromResponsesMessageItem(item) {  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Convert an OpenAI Chat Completions JSON body into the Responses API shape.
 * Inlined here (not imported from nonStreamingHandler.js) to avoid a circular
 * import. Mirrors openAICompletionToResponses in nonStreamingHandler.js.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function chatCompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: "completed",
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.error) streamError = chunk.error;
      else chunks.push(chunk);
    } catch { /* ignore malformed lines */ }
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const extractedUsage = extractUsage(chunk);
    if (extractedUsage) usage = mergeUsage(usage, extractedUsage);

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, originalModel, executedModel, routing, routingObserver: suppliedRoutingObserver, body, stream, translatedBody, finalBody, requestStartTime, requestId, trafficRequestId, startedAt, connectionId, mouse, apiKey, clientRawRequest, onRequestSuccess, customToolNames, trackDone, appendLog, reqTag, log, streamController, recordUsage = true }) {
  const routingObserver = suppliedRoutingObserver || (routing && typeof routing.recordTerminal === "function" ? routing : null);
  routingObserver?.emitHeaders({ status: providerResponse.status, sourceFormat, targetFormat, streamMode: "sse_to_json", nativePassthrough: false });
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  let pendingFinished = false;
  const finishPending = () => {
    if (pendingFinished) return;
    pendingFinished = true;
    trackDone();
  };

  const readBody = (operation) => runWithAbortDeadline(operation, {
    signal: streamController?.signal,
    timeoutMs: NON_STREAM_RESPONSE_TIMEOUT_MS,
    timeoutMessage: `Forced streaming response timed out after ${NON_STREAM_RESPONSE_TIMEOUT_MS}ms`,
    onTimeout: () => streamController?.abort?.("response_body_timeout"),
  });

  const ctx = {
    provider, model, originalModel, executedModel, routing, connectionId, requestId, mouse,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  // Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
  // not the client format: a Responses-API client behind a chat-native forced-streaming
  // provider still receives chat SSE chunks, which must go through the standard path.
  const isCodexResponsesApi = isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    // Diagnostic only (no behaviour change): this path had NO stall bound at all and
    // only ended at the 360s ceiling, so it is a prime suspect for the stuck turns.
    // Counts upstream bytes against bytes actually converted into the JSON result,
    // which is the pair needed to tell "upstream went quiet" from "we read fine but
    // produced nothing". Logged via errorLine so it survives LOG_LEVEL=WARN.
    const diagT0 = Date.now();
    let diagUpBytes = 0;
    let diagUpChunks = 0;
    const diagSource = providerResponse.body;
    const diagWrapped = diagSource && typeof diagSource.getReader === "function"
      ? (() => {
        const r = diagSource.getReader();
        return new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await r.read();
              if (done) { controller.close(); return; }
              diagUpChunks++;
              diagUpBytes += value?.byteLength || value?.length || 0;
              controller.enqueue(value);
            } catch (e) { controller.error(e); }
          },
          cancel(reason) { try { r.cancel(reason); } catch { /* best-effort */ } },
        });
      })()
      : diagSource;

    try {
      const jsonResponse = await readBody(() => convertResponsesStreamToJson(diagWrapped));
      const rawOutcome = jsonResponse?.status === "failed"
        ? { outcome: "failed", terminalReason: "upstream_error" }
        : { outcome: jsonResponse?.status === "incomplete" ? "incomplete" : "valid_terminal", terminalReason: jsonResponse?.status === "incomplete" ? "incomplete" : "terminal" };
      routingObserver?.recordTerminal(rawOutcome);
      routingObserver?.settle({ usage: jsonResponse?.usage, upstreamStatus: providerResponse.status });
      finishPending();

      const diagDur = Date.now() - diagT0;
      if (diagDur > 60000) {
        const outBytes = JSON.stringify(jsonResponse?.output ?? null).length;
        const outTokens = jsonResponse?.usage?.output_tokens ?? 0;
        log?.errorLine?.("", "🔬", `SSE2JSON-DIAG ${jsonResponse?.status || "?"} | ${provider}/${model} | dur=${diagDur}ms | up_chunks=${diagUpChunks} up_bytes=${diagUpBytes} | json_out_bytes=${outBytes} out_tokens=${outTokens}`);
      }

      // A failed turn is NOT a success. The upstream can fail a Responses stream
      // after emitting a few deltas (e.g. server_is_overloaded), and the previous
      // code recorded usage and returned that empty/partial body as 200 OK — so the
      // combo never rotated to the next model. Surface it as an error result instead,
      // tagged as an upstream SSE failure so account/breaker bookkeeping is correct.
      if (jsonResponse.status === "failed") {
        const message = jsonResponse.error?.message
          || jsonResponse.error?.code
          || "Upstream Responses stream failed";
        if (recordUsage) saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: null, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "error", silent: true });
        if (log?.errorLine) log.errorLine(reqTag, "✗", `UPSTREAM ${HTTP_STATUS.SERVICE_UNAVAILABLE} · provider · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    [${HTTP_STATUS.SERVICE_UNAVAILABLE}]: ${message}`);
        return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, message, undefined, {
          source: "sse",
          status: providerResponse.status || 200,
          message,
          body: jsonResponse.error ? JSON.stringify(jsonResponse.error) : "",
          retryAfterMs: null,
          receivedAt: new Date().toISOString(),
          layer: "provider",
        });
      }

      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      appendLog({ tokens: usage, status: "200 OK" });
      if (recordUsage) saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "success", silent: true });
      if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

      // Same cache-inclusive total for the recorded detail, so the DB and the
      // client-facing usage can never disagree.
      const inTokensForLog = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || usage.cached_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const totalLatency = Date.now() - requestStartTime;

      if (recordUsage) saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: inTokensForLog, completion_tokens: usage.output_tokens || 0 },
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(jsonResponse), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
      }

      // Build client-format response.
      // input_tokens EXCLUDES cached tokens on cache-capable upstreams, so summing
      // only input+output under-reports prompt_tokens — measured: 2012 reported
      // where the real prompt was ~5344 with 5332 served from cache. Fold the cache
      // counters in, and keep them visible in prompt_tokens_details so a client can
      // tell a cache hit from a small prompt.
      const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const inTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate;
      const outTokens = usage.output_tokens || 0;
      const cacheDetails = (cacheRead > 0 || cacheCreate > 0)
        ? { prompt_tokens_details: {
              ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
              ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}) } }
        : {};
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        finalResp = {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: textContent || "" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens },
            modelVersion: model,
            responseId: jsonResponse.id || `resp_${Date.now()}`
          }
        };
      } else if (sourceFormat === FORMATS.CLAUDE) {
        // A Claude client (an Anthropic-format caller behind a forced-streaming
        // provider) must receive a Message, not an OpenAI ChatCompletion. Without
        // this branch it fell through to the OpenAI shape below, so the client
        // rejected a perfectly good 200 with "body is JSON but not a Message" —
        // which is what a Codex (forceStream) channel produced for every
        // non-streaming /v1/messages request, while a plain openai-format channel
        // (deepseek) never took this path at all and looked healthy.
        finalResp = buildClaudeMessage({ jsonResponse, textContent, toolCalls, usage, model });
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const finishReason = hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop"));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens, ...cacheDetails }
        };
      }

      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      finishPending();
      if (recordUsage) saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: null, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "error", silent: true });
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(err?.name === "AbortError" ? 499 : err?.name === "TimeoutError" ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.BAD_GATEWAY, err?.name === "TimeoutError" ? "Upstream response body timeout" : err?.name === "AbortError" ? "Request aborted" : "Failed to convert streaming response to JSON");
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await readBody(() => providerResponse.text());
    const rawOutcome = classifyRawSSEBlock(sseText, targetFormat);
    if (rawOutcome) routingObserver?.recordTerminal(rawOutcome);
    else routingObserver?.settle({ outcome: "incomplete", terminalReason: "incomplete", upstreamStatus: providerResponse.status });
    routingObserver?.settle({ usage: null, upstreamStatus: providerResponse.status });
    finishPending();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      if (recordUsage) saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: null, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "error", silent: true });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    if (parsed.error) {
      if (recordUsage) saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: null, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "error", silent: true });
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        parsed.error.message || "Upstream SSE stream failed"
      );
    }

    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, originalModel, executedModel, routing, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, sourceIp: clientRawRequest?.sourceIp, appName: clientRawRequest?.appName, userAgent: clientRawRequest?.userAgent, sourceUrl: clientRawRequest?.sourceUrl, requestId, trafficRequestId, startedAt, status: "success", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

    // Re-attach usage explicitly. This handler already HAS the correct usage — it is
    // the same object written to the usage DB, and for a cached Claude request that DB
    // row reads cache_read_input_tokens: 11022 — yet the client was observed receiving
    // no usage field at all (verified 2026-08-04 with a fingerprinted payload matched
    // on both sides). Whatever drops it between assembly and serialisation, the client
    // must not be left unable to account for its own token spend: a caller cannot tell
    // a 90%-cached request from a cheap one without this.
    if (usage && Object.keys(usage).length > 0) parsed.usage = usage;

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    // A Responses-format client (e.g. Codex) forced this provider to stream,
    // but wants JSON back. parseSSEToOpenAIResponse yields a Chat Completions
    // body; convert it to the Responses `output` shape so tool_calls are not
    // lost on the non-streaming return path. Inlined (not imported from
    // nonStreamingHandler.js) to avoid a circular import: nonStreamingHandler
    // already imports parseSSEToOpenAIResponse from this module.
    const finalBody = sourceFormat === FORMATS.OPENAI_RESPONSES
      ? chatCompletionToResponses(parsed, customToolNames)
      : parsed;

    return { success: true, response: new Response(JSON.stringify(finalBody), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
  } catch (err) {
    finishPending();
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    const status = err?.name === "AbortError" ? 499
      : err?.name === "TimeoutError" ? HTTP_STATUS.GATEWAY_TIMEOUT
        : HTTP_STATUS.BAD_GATEWAY;
    return createErrorResult(status, status === 499 ? "Request aborted" : status === HTTP_STATUS.GATEWAY_TIMEOUT ? "Upstream response body timeout" : "Failed to convert streaming response to JSON");
  }
}
