import { describe, expect, it } from 'vitest';
import { createClaudeFirstArrival } from '../../open-sse/utils/claudeFirstArrival.js';
import { wholeReplyAsStream } from '../../open-sse/handlers/chatCore/wholeReplyStream.js';
import { createStreamController, pipeWithDisconnect } from '../../open-sse/utils/streamHandler.js';

const bytes = s => new TextEncoder().encode(s);
const frame = o => bytes(`data: ${JSON.stringify(o)}\r\n\r\n`);
const delta = fields => frame({type:'content_block_delta', delta:fields});

describe('Claude first arrival', () => {
  it('times first complete lines, not heartbeats, empty deltas, signatures, or repeats', () => {
    let now = 1000;
    const diag = createClaudeFirstArrival(now, false, () => now), raw = diag.raw;
    raw.observe(frame({type:'ping'})); now += 20;
    raw.observe(frame({type:'content_block_start', content_block:{type:'thinking', thinking:''}}));
    raw.observe(delta({signature:'sensitive'})); raw.observe(delta({text:''}));
    now += 10; raw.observe(delta({thinking:'sensitive'}));
    const text = delta({text:'私密'}), idx = text.indexOf(0xe7) + 1;
    raw.observe(text.subarray(0,idx)); now += 10; raw.observe(text.subarray(idx));
    now += 10; raw.observe(delta({partial_json:'secret'})); raw.observe(text);
    expect(diag.snapshot()).toEqual({raw:{firstByteMs:0,firstBlockMs:20,firstTextMs:40,firstThinkingMs:30,firstToolArgsMs:50,skippedLargeLine:false},forwarded:null});
  });
  it('bounds fragmented lines, resumes at the next line, and handles EOF', () => {
    const {raw} = createClaudeFirstArrival(0,false,()=>10);
    raw.observe(bytes('data: '+ 'x'.repeat(40000))); raw.observe(bytes('x'.repeat(40000)+'\n'));
    raw.observe(bytes('data: bad\ndata: {"type":"content_block_start","content_block":{"type":"text","text":"private"}}')); raw.finish();
    expect(raw.snapshot()).toMatchObject({skippedLargeLine:true,firstBlockMs:10,firstTextMs:10,firstThinkingMs:null});
  });
  it.each([true,false])('compares raw arrivals with bytes after the relay (whole JSON = %s)', async whole => {
    let now = 100;
    const a = createClaudeFirstArrival(now,true,()=>now);
    const diag = {claudeArrival:a};
    const body = whole ? JSON.stringify({type:'message',content:[{type:'text',text:'hello'}],stop_reason:'end_turn'}) : new TextDecoder().decode(delta({text:'hello'}));
    const response = await wholeReplyAsStream(new Response(body,{headers:{'content-type':'text/event-stream'}}),'claude',{streamingClient:true,rawArrival:a.raw});
    const transform = new TransformStream({transform(chunk,c){ now=150; c.enqueue(chunk); }});
    const output = await new Response(pipeWithDisconnect(response, transform, createStreamController(), null, 60000, diag)).text();
    expect(output).toContain('hello');
    if (!whole) expect(output).toBe(body);
    expect(diag.snapshot('complete').claudeFirstArrival).toMatchObject({raw:{firstByteMs:0,firstTextMs:whole?null:0},forwarded:{firstTextMs:50}});
  });
});
