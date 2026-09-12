/**
 * Live Mouse tunnels.
 *
 * A Mouse never needs an address Spring can dial. The agent opens one
 * long-lived SSE request to `/api/mouses/tunnel`; Spring pushes work down that
 * connection and the agent answers on a second request it makes itself. Both
 * directions are therefore outbound from the node, so a node behind NAT needs
 * no inbound port, no public IP and no callback URL.
 *
 * State is process-local. It is mirrored on `globalThis` because Turbopack can
 * instantiate this module once per server entry point, and a task dispatched by
 * one copy has to be visible to the copy holding the SSE stream. The trade-off
 * is explicit: with more than one Spring replica a task can be pushed to a
 * replica that does not own the node's tunnel. That surfaces as an `offline`
 * error and the caller falls back, exactly as a disconnected node would.
 */

const REGISTRY_KEY = "__springMouseTunnels";
const DEFAULT_ACK_TIMEOUT_MS = 120_000;

export class MouseTunnelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MouseTunnelError";
    this.code = code;
  }
}

function registry() {
  if (!globalThis[REGISTRY_KEY]) {
    globalThis[REGISTRY_KEY] = { tunnels: new Map(), pending: new Map() };
  }
  return globalThis[REGISTRY_KEY];
}

// Time allowed between "task pushed" and "agent starts answering". This covers
// the agent's own provider request up to its first response byte, not the
// response itself, so it has to tolerate a slow provider queue.
function ackTimeoutMs(override) {
  const configured = Number(override ?? process.env.SPRING_MOUSE_TUNNEL_ACK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ACK_TIMEOUT_MS;
}

function abortAsTunnelError(reason) {
  const message = reason instanceof Error ? reason.message : (reason ? String(reason) : "The operation was aborted");
  const error = new MouseTunnelError("aborted", message);
  error.name = "AbortError";
  return error;
}

export function registerTunnel(mouseId, handle) {
  registry().tunnels.set(mouseId, handle);
  return handle;
}

export function isTunnelConnected(mouseId) {
  return Boolean(mouseId) && registry().tunnels.has(mouseId);
}

export function listTunneledMouseIds() {
  return [...registry().tunnels.keys()];
}

/**
 * Drops one node's tunnel and fails everything in flight on it. A reconnect can
 * register the replacement before the dead stream notices, so only the handle
 * that currently owns the slot is allowed to clear it.
 */
export function unregisterTunnel(mouseId, handle = null) {
  const { tunnels, pending } = registry();
  const current = tunnels.get(mouseId);
  if (!current) return false;
  if (handle && current !== handle) return false;
  tunnels.delete(mouseId);
  for (const entry of pending.values()) {
    if (entry.mouseId === mouseId) {
      entry.settle(new MouseTunnelError("offline", "Mouse tunnel disconnected"));
    }
  }
  return true;
}

/**
 * Closes a node's tunnel from the server side, which is how a rotated token or
 * a disabled node loses the connection it is still holding.
 */
export function disconnectTunnel(mouseId, reason = "disconnected") {
  const handle = registry().tunnels.get(mouseId);
  if (!handle) return false;
  handle.close?.();
  unregisterTunnel(mouseId, handle);
  return true;
}

/**
 * Pushes one task down the node's tunnel and resolves once the agent has handed
 * back the upstream response head. Rejects with a `MouseTunnelError` carrying
 * `code` = `offline` | `timeout` | `aborted`.
 */
export function dispatchMouseTask(mouseId, { taskId, request, signal = null, ackTimeoutMs: ackOverride } = {}) {
  const tunnel = registry().tunnels.get(mouseId);
  if (!tunnel) return Promise.reject(new MouseTunnelError("offline", "Mouse node has no live tunnel"));

  return new Promise((resolve, reject) => {
    const entry = { mouseId, settled: false, settle: null, timer: null, detach: null };

    entry.settle = (error, value) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.detach?.();
      registry().pending.delete(taskId);
      if (error) reject(error);
      else resolve(value);
    };

    if (signal) {
      if (signal.aborted) {
        entry.settled = true;
        reject(abortAsTunnelError(signal.reason));
        return;
      }
      const onAbort = () => {
        tunnel.send("cancel", { taskId });
        entry.settle(abortAsTunnelError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.detach = () => signal.removeEventListener("abort", onAbort);
    }

    const timeout = ackTimeoutMs(ackOverride);
    entry.timer = setTimeout(() => {
      tunnel.send("cancel", { taskId });
      entry.settle(new MouseTunnelError("timeout", `Mouse did not start the task within ${timeout}ms`));
    }, timeout);
    entry.timer.unref?.();

    registry().pending.set(taskId, entry);

    if (!tunnel.send("task", { taskId, request })) {
      entry.settle(new MouseTunnelError("offline", "Mouse tunnel closed while dispatching"));
    }
  });
}

/**
 * Hands the agent's replayed upstream response to whoever is waiting on the
 * task. Returns false when the task already timed out or was cancelled, which
 * tells the caller to drain the upload instead of letting it hang.
 */
export function deliverMouseResult(taskId, { status, headers, body } = {}) {
  const entry = registry().pending.get(taskId);
  if (!entry) return false;
  entry.settle(null, { status, headers, body });
  return true;
}

export function pendingTaskCount() {
  return registry().pending.size;
}
