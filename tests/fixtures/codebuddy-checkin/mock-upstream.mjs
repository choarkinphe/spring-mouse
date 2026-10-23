import http from "node:http";

const port = Number(process.env.MOCK_PORT || 9079);
const requests = [];
let todayCheckedIn = false;

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { fixture: "codebuddy-checkin", ok: true });
  if (req.method === "GET" && req.url === "/requests") return reply(res, 200, { requests });

  let raw = "";
  try { for await (const chunk of req) raw += chunk; } catch { return reply(res, 400, { code: 400, msg: "invalid request" }); }
  const path = req.url?.split("?", 1)[0];
  // Deliberately retain no headers, tokens, request bodies or user identity.
  const record = { method: req.method, path };
  requests.push(record);

  if (req.method !== "POST" || raw !== "{}") return reply(res, 400, { code: 400, msg: "invalid fixture request" });
  if (path === "/v2/billing/meter/checkin-activity-status") {
    return reply(res, 200, { code: 0, data: { active: true, today_checked_in: todayCheckedIn } });
  }
  if (path === "/v2/billing/meter/daily-checkin") {
    if (todayCheckedIn) return reply(res, 200, { code: 1001, data: {} });
    todayCheckedIn = true;
    return reply(res, 200, { code: 0, data: { credit: "18", credit_delayed: false } });
  }
  if (path === "/v2/billing/meter/get-user-resource") {
    return reply(res, 200, { code: 0, data: { Response: { Data: { Accounts: [] } } } });
  }
  if (path === "/v2/plugin/auth/token/refresh") {
    return reply(res, 200, { code: 0, data: { accessToken: "fixture-refreshed-access", refreshToken: "fixture-refreshed-refresh", expiresIn: 3600 } });
  }
  return reply(res, 404, { code: 404, msg: "unknown fixture route" });
}).listen(port, "127.0.0.1", () => console.log(`CodeBuddy check-in mock ready at http://127.0.0.1:${port}`));
