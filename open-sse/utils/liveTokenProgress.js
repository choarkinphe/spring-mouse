import { canonicalizeUsage, extractUsage, mergeUsage } from "./usageTracking.js";

// Display-only progress: real upstream counters win; between usage events use
// only received text/tool deltas, never elapsed time or invented throughput.
export function createLiveTokenProgress(inputEstimate = 0) {
  let usage = null;
  let contentLength = 0;
  let lengthAtUsage = 0;

  return (chunk) => {
    const delta = chunk?.choices?.[0]?.delta;
    const textParts = [delta?.content, delta?.reasoning_content, chunk?.delta?.text, chunk?.delta?.thinking, chunk?.delta?.partial_json];
    for (const call of delta?.tool_calls || []) textParts.push(call.function?.arguments);
    if (typeof chunk?.delta === "string" && /\.(output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta$/.test(chunk.type || "")) {
      textParts.push(chunk.delta);
    }
    for (const part of (chunk?.candidates || chunk?.response?.candidates)?.[0]?.content?.parts || []) textParts.push(part.text);
    contentLength += textParts.reduce((length, text) => length + (typeof text === "string" ? text.length : 0), 0);

    const extracted = extractUsage(chunk);
    if (extracted) {
      usage = mergeUsage(usage, extracted);
      if (extracted.completion_tokens != null) lengthAtUsage = contentLength;
    }
    const canonical = canonicalizeUsage(usage);
    const extraOutput = Math.ceil((contentLength - lengthAtUsage) / 4);
    return {
      inputTokens: usage?.prompt_tokens != null ? canonical.prompt_tokens : Math.max(0, inputEstimate),
      outputTokens: (canonical?.completion_tokens || 0) + extraOutput,
      estimated: usage?.prompt_tokens == null || usage?.completion_tokens == null || usage?.estimated === true || extraOutput > 0,
    };
  };
}
