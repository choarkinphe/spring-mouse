import http from "node:http";
const send = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
http.createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { fixture: "jevapi" });
  if (req.headers.authorization !== "Bearer fixture-jevapi-key") return send(res, 401, { error: "invalid fixture key" });
  if (req.url === "/v1/models" && req.method === "GET") return send(res, 200, { models: [{ name: "jev-latest", description: "Latest fixture model", release_date: "2026-09-15" }, { name: "jev-preview", description: "Preview fixture model", release_date: "2026-09-15" }] });
  if (req.url !== "/v1/systemone" || req.method !== "POST") return send(res, 404, { error: "Not a native System One endpoint" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model !== "jev-latest" || body.state === undefined || !body.questions) return send(res, 422, { detail: "Invalid fixture request" });
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === "noul") return [id, { type: "noul", noul: 0.95 }];
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      return [id, { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])), confidence: 1 }];
    }
    return [id, { type: "score", score: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 1 : 0])), confidence: 1, legend: Object.fromEntries(question.criteria.map((level, index) => [index, level])) }];
  }));
  send(res, 200, { model: "jev-1.13.0", answers, usage: { input_tokens: 318, output_tokens: 34 } });
}).listen(Number(process.env.MOCK_PORT), "127.0.0.1");
