// Gateway observations, measured from the same request start as latency.ttft.
// Observe complete Claude SSE data lines, never enqueue, delay or change bytes.
// Missing timestamps mean not observed (not zero). No payload enters a snapshot.
import { CLAUDE_BLOCK } from "../translator/schema/blocks.js";

const MAX_LINE_BYTES = 64 * 1024;
const nonempty = value => typeof value === "string" && value.length > 0;

function createTap(elapsed) {
  const times = { firstByteMs: null, firstBlockMs: null, firstTextMs: null, firstThinkingMs: null, firstToolArgsMs: null };
  const decoder = new TextDecoder();
  let partial, used = 0, skipping = false, skippedLargeLine = false;
  function line(bytes, time) {
    if (bytes[0] !== 100 || bytes[1] !== 97 || bytes[2] !== 116 || bytes[3] !== 97 || bytes[4] !== 58) return; // data:
    let event;
    try { event = JSON.parse(decoder.decode(bytes.subarray(5))); } catch { return; }
    if (event?.type === "content_block_start" && event.content_block) {
      times.firstBlockMs ??= time;
      const block = event.content_block;
      if (block.type === CLAUDE_BLOCK.TEXT && nonempty(block.text)) times.firstTextMs ??= time;
      if (block.type === CLAUDE_BLOCK.THINKING && nonempty(block.thinking)) times.firstThinkingMs ??= time;
      if (block.type === CLAUDE_BLOCK.TOOL_USE && block.input && Object.keys(block.input).length) times.firstToolArgsMs ??= time;
    } else if (event?.type === "content_block_delta") {
      const d = event.delta;
      if (nonempty(d?.text)) times.firstTextMs ??= time;
      if (nonempty(d?.thinking)) times.firstThinkingMs ??= time;
      if (nonempty(d?.partial_json)) times.firstToolArgsMs ??= time;
    }
  }
  return {
    observe(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) return;
      const time = elapsed();
      times.firstByteMs ??= time;
      if (times.firstBlockMs !== null && times.firstTextMs !== null && times.firstThinkingMs !== null && times.firstToolArgsMs !== null) return;
      for (let pos = 0; pos < bytes.length;) {
        const nl = bytes.indexOf(10, pos), end = nl < 0 ? bytes.length : nl;
        const n = end - pos;
        if (used + n > MAX_LINE_BYTES) { skipping = true; skippedLargeLine = true; }
        if (!skipping) {
          if (used || nl < 0) {
            partial ??= new Uint8Array(MAX_LINE_BYTES);
            partial.set(bytes.subarray(pos, end), used);
            used += n;
            if (nl >= 0) line(partial.subarray(0, used), time);
          } else line(bytes.subarray(pos, end), time);
        }
        if (nl < 0) break;
        used = 0; skipping = false; pos = nl + 1;
      }
    },
    finish() {
      if (!skipping && used) line(partial.subarray(0, used), elapsed());
      partial = null; used = 0;
    },
    snapshot: () => ({ ...times, skippedLargeLine }),
  };
}

export function createClaudeFirstArrival(startedAt, nativeClient, now = Date.now) {
  const elapsed = () => Math.max(0, now() - startedAt);
  const raw = createTap(elapsed), forwarded = nativeClient ? createTap(elapsed) : null;
  return { raw, forwarded, snapshot: () => ({ raw: raw.snapshot(), forwarded: forwarded?.snapshot() ?? null }) };
}
