import http from "node:http";
import assert from "node:assert/strict";
const port = Number(process.env.MOCK_PORT || 9067);
const resultUrl = "https://fixture.example.test/combo-search-result";
const requests = [];
const failures = [];
http.createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return reply(200, { fixture: "combo-search", ok: true });
  if (req.url === "/requests") return reply(200, { requests, failures });
  if (req.url === "/v1/models") return reply(200, { data: [{ id: "search-model" }] });
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.method, "POST");
    if (req.url === "/v1/tools/search") {
      assert.equal(req.headers.authorization, "Bearer sk-fixture-deepseek-only");
      assert.equal(body.query, "combo search fixture query");
      assert.equal(body.count, 5, "combo must cap the requested 9 results to 5");
      requests.push({ kind: "search", query: body.query, count: body.count });
      return reply(200, { results: [{ title: "Local fixture result", url: resultUrl, snippet: "Deterministic fixture evidence", summary: "No external network needed", rerank_score: 3, site_name: "Fixture" }] });
    }
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer sk-fixture-model-only");
    assert.equal(body.model, "search-model");
    assert.notEqual(body.stream, true, "gateway loop should buffer upstream generations");
    const result = body.messages?.findLast((message) => message.role === "tool");
    const tool = body.tools?.find((item) => item.function?.name === "spring_mouse_web_search");
    assert.ok(tool, "gateway must inject its function definition");
    const toolCalls = result ? undefined : [{ id: "call_fixture_search", type: "function", function: { name: "spring_mouse_web_search", arguments: JSON.stringify({ query: "combo search fixture query", max_results: 9 }) } }];
    if (result) {
      assert.equal(result.tool_call_id, "call_fixture_search");
      assert.ok(JSON.stringify(result.content).includes(resultUrl), "model must receive actual normalized search evidence");
    }
    requests.push({ kind: "model", phase: result ? "final" : "tool_call", stream: body.stream === true, hasResultUrl: !!result && JSON.stringify(result.content).includes(resultUrl) });
    const content = result ? `Fixture verified using ${resultUrl}` : null;
    reply(200, {
      id: "chatcmpl-fixture-search", object: "chat.completion", created: 1700000000, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
  } catch (error) {
    failures.push(error.message);
    reply(400, { error: { type: "fixture_assertion", message: error.message } });
  }
}).listen(port, "127.0.0.1", () => console.log(`Combo search mock ready at http://127.0.0.1:${port}`));
