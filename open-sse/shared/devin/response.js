import { randomUUID } from "node:crypto";
import { DEVIN } from "../../config/devin.js";
import { ROLE } from "../../translator/schema/roles.js";
import { OPENAI_BLOCK } from "../../translator/schema/blocks.js";
import { OPENAI_FINISH } from "../../translator/schema/finishReasons.js";
import { DevinProtocolError, parseDevinFrame, parseDevinTrailer, readConnectFrames } from "./protocol.js";
import { encodeDevinToolId, rememberDevinSignatureType } from "./request.js";

export async function* devinOpenAIChunks(body, model, { signal } = {}) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const contentDecoder = new TextDecoder("utf-8", { fatal: true });
  const reasoningDecoder = new TextDecoder("utf-8", { fatal: true });
  const calls = [];
  const byId = new Map();
  let active;
  let stopReason;
  let totalBytes = 0;
  let signatureType;
  const signatures = [];
  const usage = {};
  const dimensionUsage = {};
  let terminal = false;
  let started = false;
  for await (const frame of readConnectFrames(body, { signal })) {
    if (frame.flag & DEVIN.flags.end) {
      parseDevinTrailer(frame.payload);
      terminal = true;
      break;
    }
    totalBytes += frame.payload.length;
    if (totalBytes > DEVIN.maxCompletionBytes) throw new DevinProtocolError("Devin completion exceeds size limit");
    const event = parseDevinFrame(frame.payload);
    if (event.usage.status >= 400) throw new DevinProtocolError(`Devin upstream status ${event.usage.status}`, "upstream_error", event.usage.status);
    Object.assign(usage, event.usage);
    Object.assign(dimensionUsage, event.dimensionUsage);
    if (event.stopReason) stopReason = event.stopReason;
    if (!started && (event.contentBytes.length || event.thinkingBytes.length || event.tools.some(tool => tool.name))) started = true;
    const reasoning = reasoningDecoder.decode(event.thinkingBytes, { stream: true });
    if (reasoning) yield chunk({ reasoning_content: reasoning });
    const content = contentDecoder.decode(event.contentBytes, { stream: true });
    if (content) yield chunk({ content });
    if (event.signature.length) signatures.push(event.signature);
    if (event.signatureType) signatureType = event.signatureType;
    for (const tool of event.tools) {
      let slot = tool.id ? byId.get(tool.id) : active;
      // Some upstreams send arguments first and supply identity on a later delta.
      if (!slot && tool.id && active && !active.id) slot = active;
      const delta = { index: 0, function: {} };
      if (!slot) {
        if (calls.length >= DEVIN.maxToolCalls) throw new DevinProtocolError("Devin tool call count exceeds limit");
        slot = { index: calls.length, id: "", name: "", pendingArguments: "", emittedIdentity: false, decoder: new TextDecoder("utf-8", { fatal: true }) };
        calls.push(slot);
        delta.type = OPENAI_BLOCK.FUNCTION;
      }
      active = slot;
      delta.index = slot.index;
      if (tool.id && !slot.id) { slot.id = tool.id; byId.set(tool.id, slot); delta.id = encodeDevinToolId(tool.id); }
      if (tool.name && !slot.name) { slot.name = tool.name; delta.function.name = tool.name; }
      else if (tool.name && tool.name !== slot.name) throw new DevinProtocolError("Conflicting Devin tool name for one call id");
      const argumentBytes = tool.argumentsBytes?.length ? tool.argumentsBytes : tool.invalidJsonBytes;
      const args = argumentBytes ? slot.decoder.decode(argumentBytes, { stream: true }) : "";
      if (args) slot.pendingArguments += args;
      if (tool.invalidJsonError && !argumentBytes?.length) throw new DevinProtocolError(`Devin tool argument error: ${tool.invalidJsonError}`);
      // All downstream formats need identity before arguments: Claude cannot
      // open a tool_use block for an argument-only OpenAI delta. Delay only this
      // call until both id and name exist, then replay its accumulated prefix.
      if (!slot.id || !slot.name) continue;
      if (!slot.emittedIdentity) {
        delta.id = encodeDevinToolId(slot.id);
        delta.type = OPENAI_BLOCK.FUNCTION;
        delta.function.name = slot.name;
        slot.emittedIdentity = true;
      }
      if (slot.pendingArguments) delta.function.arguments = slot.pendingArguments;
      slot.pendingArguments = "";
      yield chunk({ tool_calls: [delta] });
    }
  }
  if (!terminal) throw new DevinProtocolError("Devin stream ended before EOS trailer", "stream_truncated");
  if (!started) throw new DevinProtocolError("An empty reply (Devin returned no text, reasoning or tool call)", "empty_stream");
  const contentTail = contentDecoder.decode();
  const reasoningTail = reasoningDecoder.decode();
  if (contentTail) yield chunk({ content: contentTail });
  if (reasoningTail) yield chunk({ reasoning_content: reasoningTail });
  for (const call of calls) {
    if (!call.id || !call.name) throw new DevinProtocolError("Devin stream ended with an incomplete tool identity");
    const tail = call.decoder.decode();
    if (tail) yield chunk({ tool_calls: [{ index: call.index, function: { arguments: tail } }] });
  }
  if (signatures.length) {
    const signature = Buffer.concat(signatures).toString("utf8");
    rememberDevinSignatureType(signature, signatureType);
    yield chunk({ reasoning_signature: signature, ...(signatureType ? { reasoning_signature_type: signatureType } : {}) });
  }
  const reasons = DEVIN.stopReasons;
  const finishReason = [reasons.incomplete, reasons.maxTokens].includes(stopReason) ? OPENAI_FINISH.LENGTH
    : stopReason === reasons.contentFilter ? OPENAI_FINISH.CONTENT_FILTER
      : calls.length || stopReason === reasons.toolCalls ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP;
  // #7 is authoritative; dimension metrics fill only missing/zero counters.
  // Attach usage to the finish event so the shared passthrough pipeline never
  // emits a provisional estimate before seeing the authoritative counters.
  for (const key of ["input", "output", "cached"]) if (!usage[key] && dimensionUsage[key] != null) usage[key] = dimensionUsage[key];
  const finish = chunk({}, finishReason);
  if (Object.keys(usage).length) {
    const promptTokens = (usage.input || 0) + (usage.cached || 0) + (usage.cacheWrite || 0);
    finish.usage = {
      prompt_tokens: promptTokens, completion_tokens: usage.output || 0,
      total_tokens: promptTokens + (usage.output || 0),
      prompt_tokens_details: { cached_tokens: usage.cached || 0, ...(usage.cacheWrite ? { cache_write_tokens: usage.cacheWrite } : {}) },
    };
  }
  yield finish;
}

export async function devinCompletion(body, model, options) {
  const message = { role: ROLE.ASSISTANT, content: "" };
  const calls = [];
  let completion;
  for await (const chunk of devinOpenAIChunks(body, model, options)) {
    completion ||= { id: chunk.id, object: "chat.completion", created: chunk.created, model, choices: [{ index: 0, message, finish_reason: null }] };
    if (chunk.usage) completion.usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) completion.choices[0].finish_reason = choice.finish_reason;
    const delta = choice.delta;
    for (const key of ["content", "reasoning_content", "reasoning_signature"]) if (delta[key]) message[key] = (message[key] || "") + delta[key];
    if (delta.reasoning_signature_type) message.reasoning_signature_type = delta.reasoning_signature_type;
    for (const call of delta.tool_calls || []) {
      const entry = calls[call.index] ||= { id: "", type: OPENAI_BLOCK.FUNCTION, function: { name: "", arguments: "" } };
      if (call.id) entry.id = call.id;
      if (call.function.name) entry.function.name += call.function.name;
      if (call.function.arguments) entry.function.arguments += call.function.arguments;
    }
  }
  if (calls.length) { message.tool_calls = calls; if (!message.content) message.content = null; }
  return completion;
}
