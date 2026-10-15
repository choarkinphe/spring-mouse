import { describe, it, expect, vi, afterEach } from 'vitest';
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
const { CodeBuddyIntlExecutor } = await import('../../open-sse/executors/codebuddy-intl.js');
const { CodeBuddyExecutor } = await import('../../open-sse/executors/codebuddy-cn.js');
const { BaseExecutor } = await import('../../open-sse/executors/base.js');
const { guardOpenAIFirstOutput } = await import('../../open-sse/utils/openaiFirstOutput.js');
const { FIRST_OUTPUT_FALLBACK_RESERVE_MS, OPENAI_STREAM_PREAMBLE_MAX_BYTES } = await import('../../open-sse/config/runtimeConfig.js');
const encoder = new TextEncoder();
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`;
function source(initial = '') {
  let controller;
  const cancel = vi.fn();
  const body = new ReadableStream({ start(c) { controller = c; if(initial) c.enqueue(encoder.encode(initial)); }, cancel }, { highWaterMark: 0 });
  return { response: new Response(body, {headers:{'content-type':'text/event-stream'}}), cancel,
    send(text) { controller.enqueue(encoder.encode(text)); }, close() { controller.close(); } };
}
const args = () => ({model:'deepseek-v4.1-flash',body:{messages:[{role:'user',content:'synthetic'}]},stream:true,credentials:{apiKey:'test-key'}});
afterEach(() => { vi.useRealTimers(); fetchMock.mockReset(); });

describe.each([CodeBuddyIntlExecutor, CodeBuddyExecutor])('%s first output gate', Executor => {
  it('waits through role and heartbeat, then replays exact bytes', async () => {
    const prefix=': heartbeat\r\n\r\n'+frame({role:'assistant'}), src=source(prefix);
    fetchMock.mockResolvedValueOnce(src.response);
    let settled=false;
    const work=new Executor().execute({...args(),overloadDeadline:Date.now()+10000}).then(x => {settled=true;return x;});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    const rest=frame({reasoning_content:'思考'})+frame({content:'答案'})+frame({},'stop')+'data: [DONE]\n\n';
    src.send(rest);src.close();
    const result=await work;
    expect(await result.response.text()).toBe(prefix+rest);
    expect(result.timing.upstreamHeadersMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.firstOutputWaitMs).toBeGreaterThanOrEqual(0);
  });
  it('reserves fallback time, ignores heartbeats, and cancels upstream on timeout', async () => {
    vi.useFakeTimers();
    const src=source(': ping\n\n'+frame({role:'assistant'}));let networkSignal;
    fetchMock.mockImplementation(async (_url,options) => {networkSignal=options.signal;return src.response;});
    const work=new Executor().execute({...args(),hasFallback:true,overloadDeadline:Date.now()+150000});
    await vi.advanceTimersByTimeAsync(100000);src.send(': still alive\n\n');
    await vi.advanceTimersByTimeAsync(50000-FIRST_OUTPUT_FALLBACK_RESERVE_MS);
    const result=await work;
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError).toMatchObject({status:200,origin:'sse_first_output_timeout',layer:'gateway'});
    expect(networkSignal.aborted).toBe(true);expect(src.cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('keeps a healthy long tool stream alive beyond routing deadline without retrying', async () => {
    vi.useFakeTimers();
    const first=frame({tool_calls:[{index:0,id:'call_test',function:{name:'probe',arguments:''}}]});
    const src=source(first);let networkSignal;
    fetchMock.mockImplementation(async (_u,options) => {networkSignal=options.signal;return src.response;});
    const result=await new Executor().execute({...args(),hasFallback:true,overloadDeadline:Date.now()+150000});
    await vi.advanceTimersByTimeAsync(400000);expect(networkSignal.aborted).toBe(false);
    const tail=frame({tool_calls:[{index:0,function:{arguments:'{"ok":true}'}}]})+frame({},'tool_calls')+'data: [DONE]\n\n';
    src.send(tail);src.close();
    expect(await result.response.text()).toBe(first+tail);expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels before first output without retrying', async () => {
    const src=source(),client=new AbortController();fetchMock.mockResolvedValueOnce(src.response);
    const work=new Executor().execute({...args(),signal:client.signal,overloadDeadline:Date.now()+10000}).catch(e=>e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());client.abort();
    expect(await work).toMatchObject({name:'AbortError'});expect(src.cancel).toHaveBeenCalledOnce();
  });
  it('propagates downstream cancellation after first output', async () => {
    const src=source(frame({tool_calls:[{id:'call_test'}]}));fetchMock.mockResolvedValueOnce(src.response);
    const result=await new Executor().execute({...args(),overloadDeadline:Date.now()+10000});
    await result.response.body.cancel();expect(src.cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('returns a model-fallback timeout when response headers never arrive', async () => {
    vi.useFakeTimers();let signal;
    fetchMock.mockImplementation((_u,o)=>{signal=o.signal;return new Promise(()=>{});});
    const work=new Executor().execute({...args(),hasFallback:true,overloadDeadline:Date.now()+150000});
    await vi.advanceTimersByTimeAsync(60000);
    const result=await work;
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError).toMatchObject({origin:'sse_first_output_timeout',source:'dispatch',layer:'gateway'});
    expect(signal.aborted).toBe(true);expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('does not re-upload a failed request when another channel is available', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable',{status:503}));
    const result=await new Executor().execute({...args(),hasFallback:true,overloadDeadline:Date.now()+150000});
    expect(result.response.status).toBe(503);expect(await result.response.text()).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('preamble validation', () => {
  it.each(['',': heartbeat\n\n','data: [DONE]\n\n',frame({role:'assistant'})+'data: [DONE]\n\n','{"message":"proxy failure"}'])('rejects empty or malformed HTTP 200: %s',async text=>{
    const result=await guardOpenAIFirstOutput(new Response(text),{deadlineMs:Date.now()+1000});
    expect(result.status).toBe(502);
  });
  it('retains quota error evidence and retry hint',async()=>{
    const payload={code:14003,msg:'frequency limit'};
    const result=await guardOpenAIFirstOutput(new Response(`data: ${JSON.stringify(payload)}\n\n`),{deadlineMs:Date.now()+1000});
    expect(result.status).toBe(429);expect(result.__smUpstreamError.status).toBe(200);
    expect(result.__smUpstreamError.retryAfterMs).toBeGreaterThan(0);expect(await result.json()).toEqual(payload);
  });
  it('bounds metadata-only preambles even with a hanging cancel hook',async()=>{
    const abort=vi.fn(), cancel=vi.fn(()=>new Promise(()=>{}));
    const response=new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(': '+'x'.repeat(OPENAI_STREAM_PREAMBLE_MAX_BYTES)+'\n\n'));},cancel}));
    const result=await guardOpenAIFirstOutput(response,{deadlineMs:Date.now()+1000,abort});
    expect(result.status).toBe(503);expect(result.__smUpstreamError.origin).toBe('sse_scan_limit');
    expect(abort).toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
  });
  it('replays frames split inside UTF-8 characters and CRLF delimiters',async()=>{
    const text=frame({content:'中文'}).replaceAll('\n','\r\n'),bytes=encoder.encode(text);let index=0;
    const response=new Response(new ReadableStream({pull(c){if(index<bytes.length)c.enqueue(bytes.slice(index,index+=1));else c.close();}}));
    const result=await guardOpenAIFirstOutput(response,{deadlineMs:Date.now()+1000});expect(await result.text()).toBe(text);
  });
});

describe('base executor shared dispatch deadline',()=>{
  const executor=()=>new BaseExecutor('test',{baseUrl:'https://test.invalid'});
  it('does not dispatch after deadline',async()=>{
    await expect(executor().execute({...args(),overloadDeadline:Date.now()-1})).rejects.toMatchObject({name:'TimeoutError'});
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('aborts a hung fetch at the shared deadline without retries',async()=>{
    vi.useFakeTimers();let signal;
    fetchMock.mockImplementation((_u,o)=>{signal=o.signal;return new Promise(()=>{});});
    const result=executor().execute({...args(),overloadDeadline:Date.now()+1000}).catch(e=>e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({name:'TimeoutError'});expect(signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves error body if retry delay exceeds remaining budget',async()=>{
    fetchMock.mockResolvedValue(new Response('upstream failure',{status:503}));
    const result=await executor().execute({...args(),overloadDeadline:Date.now()+100});
    expect(await result.response.text()).toBe('upstream failure');expect(fetchMock).toHaveBeenCalledOnce();
  });
});
