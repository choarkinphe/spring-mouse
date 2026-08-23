/**
 * Returns the client IP only when it was stamped by custom-server.js.
 * The custom server removes user-supplied forwarding headers before adding this
 * process-scoped proof, so dashboard IP data cannot be spoofed by API callers.
 */
export function getTrustedSourceIp(request) {
  const expectedToken = process.env.SPRING_MOUSE_PEER_TOKEN;
  const receivedToken = request?.headers?.get?.("x-sm-peer-token");
  const sourceIp = request?.headers?.get?.("x-sm-real-ip")?.trim();

  if (expectedToken && receivedToken === expectedToken && sourceIp) return sourceIp.slice(0, 128);

  // `next dev` does not load custom-server.js. Allow its locally generated
  // forwarding headers only outside production so development usage can still
  // be diagnosed without weakening the production trust boundary.
  if (process.env.NODE_ENV !== "production") {
    const developmentIp = request?.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim()
      || request?.headers?.get?.("x-real-ip")?.trim();
    return developmentIp ? developmentIp.slice(0, 128) : null;
  }

  return null;
}

function cleanHeader(value, maxLength) {
  if (!value || typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function appFromUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "").slice(0, 64) || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort request source metadata. `sourceIp` remains trusted and can only
 * come from custom-server.js. Application identity is an observability hint:
 * explicit client headers win, then Referer/Origin, then common User-Agents.
 */
export function getRequestSourceMeta(request) {
  const headers = request?.headers;
  const userAgent = cleanHeader(headers?.get?.("user-agent"), 256);
  const explicitApp = cleanHeader(
    headers?.get?.("x-app-name")
      || headers?.get?.("x-client-name")
      || headers?.get?.("x-title"),
    64,
  );
  const sourceUrl = cleanHeader(
    headers?.get?.("http-referer")
      || headers?.get?.("referer")
      || headers?.get?.("origin"),
    256,
  );

  return {
    sourceIp: getTrustedSourceIp(request),
    appName: explicitApp || appFromUrl(sourceUrl),
    userAgent,
    sourceUrl,
  };
}

export function detectSourceApp({ appName, userAgent, sourceUrl } = {}) {
  if (appName) return appName;

  const haystack = `${userAgent || ""} ${sourceUrl || ""}`.toLowerCase();
  const knownApps = [
    ["claude code", ["claude-code", "claude code"]],
    ["OpenAI Codex", ["codex_cli_rs", "openai codex", "codex-cli"]],
    ["Cursor", ["cursor"]],
    ["Cline", ["cline"]],
    ["Roo Code", ["roo-code", "roo code"]],
    ["Continue", ["continue.dev", "continue/"]],
    ["Aider", ["aider"]],
    ["Open WebUI", ["open-webui", "openwebui"]],
    ["LobeChat", ["lobechat", "lobe-chat"]],
    ["Chatbox", ["chatbox"]],
    ["Cherry Studio", ["cherry studio", "cherry-studio"]],
    ["NextChat", ["nextchat", "chatgpt-next-web"]],
    ["VS Code", ["vscode", "visual studio code"]],
    ["JetBrains", ["jetbrains", "intellij", "pycharm", "webstorm"]],
    ["OpenAI Python SDK", ["openai-python", "python-openai"]],
    ["OpenAI Node SDK", ["openai-node", "node-openai"]],
    ["curl", ["curl/"]],
  ];

  for (const [label, needles] of knownApps) {
    if (needles.some((needle) => haystack.includes(needle))) return label;
  }
  if (userAgent) return userAgent.split(/[ /]/)[0].slice(0, 48) || "未知客户端";
  return "未知客户端";
}
