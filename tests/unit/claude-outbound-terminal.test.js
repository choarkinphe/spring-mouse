import { describe, it, expect, vi } from 'vitest';
import { createClaudeOutboundTerminal, boundedOutboundTerminal } from '../../src/lib/claudeOutboundTerminal.js';
import '../translator/registerAll.js';
import { createSSEStream } from '../../open-sse/utils/stream.js';
import { withNetworkTraffic } from '../../src/lib/networkTraffic.js';
import { saveNetworkTraffic } from '@/lib/db/repos/trafficRepo.js';
vi.mock('@/lib/db/repos/trafficRepo.js', () => ({saveNetworkTraffic: vi.fn(async () => {})}));
const enc = new TextEncoder();
const event = (type, fields = {}) => `event: ${type}\r\ndata: ${JSON.stringify({type,...fields})}\r\n\r\n`;
const observe = (text, sliced = false) => {
  const probe = createClaudeOutboundTerminal(Date.now());
  const bytes = enc.encode(text);
  if (sliced) for (const b of bytes) probe.observe(Uint8Array.of(b)); else probe.observe(bytes);
  return boundedOutboundTerminal(probe.finish('eof', 100));
};
const start = event('content_block_delta', {delta:{text:'私密'}});
const tail = event('content_block_stop') + event('message_delta', {delta:{stop_reason:'tool_use'}}) + event('message_stop');
const traceResponse = body => withNetworkTraffic(new Request('http://localhost/v1/messages'), async () => new Response(body, {headers:{'content-type':'text/event-stream'}}), {traceClaudeOutbound:true});

describe('Claude outbound wire evidence', () => {
  it('counts only dispatched frames across UTF-8 and CRLF splits, including the final translated tail', async () => {
    const trace = observe(': keepalive\r\n\r\n' + start + tail + 'data: [DONE]\n\n', true);
    expect(trace).toMatchObject({events:4,blockStops:1,lastBlockStopSeq:2,stopReasonSeq:3,messageStopSeq:4,lastEvent:'message_stop',end:'eof',skippedFrames:0});
    expect(JSON.stringify(trace)).not.toContain('私密');
    const res = await traceResponse(start + tail); expect(await res.text()).toBe(start + tail);
    await vi.waitFor(() => expect(saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({aborted:false,meta:expect.objectContaining({claudeOutboundTerminal:expect.objectContaining({messageStopSeq:4,end:'eof'})})})));
  });
  it('observes the actual Responses → Claude conversion, not the upstream response.completed', async () => {
    const input = event('response.output_text.delta',{delta:'fixture'}) + event('response.completed',{response:{status:'completed',output:[],usage:{input_tokens:2,output_tokens:1}}});
    const converter = createSSEStream({mode:'translate',targetFormat:'openai-responses',sourceFormat:'claude',body:{}});
    const response = await traceResponse(new Response(input).body.pipeThrough(converter));
    expect(await response.text()).toContain('event: message_stop');
    await vi.waitFor(() => {
      const row = saveNetworkTraffic.mock.calls.at(-1)?.[0];
      const trace = row?.meta?.claudeOutboundTerminal;
      expect(trace?.lastEvent).toBe('message_stop');
      expect(trace.lastBlockStopSeq).toBeGreaterThan(0);
      expect(trace.stopReasonSeq).toBeGreaterThan(trace.lastBlockStopSeq);
      expect(trace.messageStopSeq).toBeGreaterThan(trace.stopReasonSeq);
      expect(trace.end).toBe('eof');
    });
  });
  it('does not mistake an unterminated tail, upstream terminal or bare EOF for message_stop', () => {
    expect(observe(start + event('response.completed') + 'event: message_stop\ndata: {"type":"message_stop"}\n')).toMatchObject({messageStopSeq:null,stopReasonSeq:null,end:'eof',skippedFrames:1,lastEvent:'other'});
  });
  it('bounds oversized frames and resumes without storing unknown labels or stop reason values', () => {
    const trace = observe(event('content_block_delta',{text:'x'.repeat(70000)}) + event('private-label') + tail);
    expect(trace).toMatchObject({events:4,skippedFrames:1,messageStopSeq:4});
    expect(JSON.stringify(trace)).not.toMatch(/private-label|tool_use/);
  });
  it.each(['cancel','read_error'])('separates %s from EOF on an unfinished read', async end => {
    let source;
    const response = await traceResponse(new ReadableStream({start(c){source=c;c.enqueue(enc.encode(start));}}));
    const reader=response.body.getReader(); await reader.read(); const pending=reader.read();
    if(end==='cancel'){ await reader.cancel(); await pending; } else { source.error(new Error('private failure')); await expect(pending).rejects.toThrow(); }
    await vi.waitFor(() => expect(saveNetworkTraffic).toHaveBeenCalledWith(expect.objectContaining({aborted:true,meta:expect.objectContaining({claudeOutboundTerminal:expect.objectContaining({end,lastEvent:'content_block_delta',messageStopSeq:null})})})));
  });
});
