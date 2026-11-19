// Observe only dispatched SSE frames (a blank line is required). HTTP body
// enqueue/EOF is a gateway boundary, not an acknowledgement from the client.
const MAX_FRAME_BYTES = 32 * 1024;
const EVENT_TYPES = new Set(['message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);
const END_TYPES = new Set(['eof', 'cancel', 'read_error']);
const METRICS = ['events', 'skippedFrames', 'blockStops', 'lastBlockStopSeq', 'lastBlockStopMs',
  'stopReasonSeq', 'stopReasonMs', 'messageStopSeq', 'messageStopMs', 'endMs'];

// The traffic writer is a trust boundary: do not spread untrusted metadata.
export function boundedOutboundTerminal(trace) {
  if (!trace || !END_TYPES.has(trace.end)) return null;
  const out = { end: trace.end, lastEvent: EVENT_TYPES.has(trace.lastEvent) ? trace.lastEvent : trace.lastEvent ? 'other' : null };
  for (const k of METRICS) out[k] = Number.isSafeInteger(trace[k]) && trace[k] >= 0 ? trace[k] : null;
  return out;
}

export function createClaudeOutboundTerminal(startMs) {
  const metrics = { events: 0, skippedFrames: 0, blockStops: 0 };
  const decoder = new TextDecoder();
  let buf = new Uint8Array(512), used = 0, lineBytes = 0, afterCR = false, skipping = false;
  function dispatch(now) {
    if (skipping) { metrics.skippedFrames++; return; }
    let name = '', data = [];
    for (const line of decoder.decode(buf.subarray(0, used)).split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length || (data.length === 1 && data[0] === '[DONE]')) return;
    let obj;
    try { obj = JSON.parse(data.join('\n')); } catch { metrics.skippedFrames++; return; }
    if (!obj?.type || (name && name !== obj.type)) { metrics.skippedFrames++; return; }
    const seq = ++metrics.events;
    metrics.lastEvent = EVENT_TYPES.has(obj.type) ? obj.type : 'other';
    switch (obj.type) {
      case 'content_block_stop':
        metrics.blockStops++; metrics.lastBlockStopSeq = seq; metrics.lastBlockStopMs = now; break;
      case 'message_delta':
        if (typeof obj.delta?.stop_reason === 'string' && obj.delta.stop_reason) {
          metrics.stopReasonSeq ??= seq; metrics.stopReasonMs ??= now;
        }
        break;
      case 'message_stop':
        metrics.messageStopSeq ??= seq; metrics.messageStopMs ??= now; break;
    }
  }
  function append(byte) {
    if (skipping) return;
    if (used === MAX_FRAME_BYTES) { skipping = true; return; }
    if (used === buf.length) { const next = new Uint8Array(buf.length * 2); next.set(buf); buf = next; }
    buf[used++] = byte;
  }
  return {
    observe(bytes) {
      const now = Math.max(0, Date.now() - startMs);
      for (const byte of bytes) {
        if (afterCR && byte === 10) { afterCR = false; continue; }
        afterCR = byte === 13;
        if (afterCR || byte === 10) {
          if (!lineBytes) { if (used || skipping) dispatch(now); used = 0; skipping = false; }
          else append(10);
          lineBytes = 0;
        } else { lineBytes++; append(byte); }
      }
    },
    finish(end, endMs) {
      // A partial final frame would not dispatch to an SSE client.
      return { ...metrics, skippedFrames: metrics.skippedFrames + Number(Boolean(used || skipping)), end, endMs };
    },
  };
}
