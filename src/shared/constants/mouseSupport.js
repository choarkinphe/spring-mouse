/**
 * Which providers can actually dispatch through a Mouse (remote node)?
 *
 * The Mouse branch lives at the top of `BaseExecutor.execute()`
 * (`open-sse/executors/base.js`): `if (credentials?.mouseExecution) return
 * this.executeViaMouse(...)`. An executor that overrides `execute()` and never
 * calls `super.execute()` therefore makes that branch unreachable — binding a
 * Mouse to such an account silently keeps traffic on the Spring host.
 *
 * Authoritative source: the provider keys registered in
 * `open-sse/executors/index.js` (aliases included). `tests/unit/mouse-support.test.js`
 * fails when this list drifts from the real executor code, so add new
 * overrides there — not by hand-copying a filesystem scan.
 *
 * Everything not listed here is routed through `DefaultExecutor` (or an
 * executor that delegates to the base class), so it supports Mouse.
 */
export const MOUSE_UNSUPPORTED_PROVIDERS = Object.freeze([
  "cursor", // CursorExecutor — protobuf upstream, no super.execute
  "cu", // alias of cursor
  "vertex", // VertexExecutor
  "vertex-partner", // alias of vertex
  "qoder", // QoderExecutor
  "trae", // TraeExecutor
  "windsurf", // WindsurfExecutor — talks to server.codeium.com directly
  "zed", // ZedExecutor
  "grok-web", // GrokWebExecutor — talks to grok.com directly
  "mimo-free", // MimoFreeExecutor — talks to api.xiaomimimo.com directly
  "mmf", // alias of mimo-free
  "perplexity-web", // PerplexityWebExecutor — talks to www.perplexity.ai directly
  "devin-cli", // DevinCliExecutor — spawns a local child process
]);

const UNSUPPORTED = new Set(MOUSE_UNSUPPORTED_PROVIDERS);

/**
 * True when the provider's executor is able to send its request through a
 * Mouse node. Unknown providers fall back to `DefaultExecutor`, which does
 * support Mouse, so anything unrecognised is treated as supported.
 */
export function supportsMouseExecution(provider) {
  if (typeof provider !== "string") return false;
  const id = provider.trim().toLowerCase();
  if (!id) return false;
  return !UNSUPPORTED.has(id);
}

/** UI hint explaining why the Mouse picker is hidden for this provider. */
export function mouseUnsupportedReason(provider) {
  if (supportsMouseExecution(provider)) return null;
  return "该渠道由内置执行器直接访问上游，暂不支持绑定 Mouse 节点";
}
