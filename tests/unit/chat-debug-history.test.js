// The chat-debug history lives in localStorage, and sanitizeRunHistoryEntry is
// a whitelist: a field the reconciler backfills onto a run is dropped on reload
// unless it is listed there. That is exactly how the executed Mouse node would
// disappear from the history table between sessions.
import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_STORAGE_KEY, loadHistory, saveHistory } from "../../src/app/(dashboard)/dashboard/chat-debug/chatDebugLib.js";

function stubLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return store;
}

beforeEach(() => {
  stubLocalStorage();
});

const run = (extra = {}) => ({
  id: "run-1",
  time: "2026-09-17T10:00:00.000Z",
  model: "openai/gpt-4o",
  status: "done",
  ttft: 120,
  total: 900,
  timeline: [0, 400, 900],
  ...extra,
});

describe("chat-debug history keeps the executed Mouse node", () => {
  it("survives the localStorage round-trip", () => {
    saveHistory([run({ mouse: { id: "node-uuid", name: "tokyo-edge" } })]);

    const [restored] = loadHistory();
    expect(restored.mouse).toEqual({ id: "node-uuid", name: "tokyo-edge" });
  });

  it("keeps the id when a node has no name yet", () => {
    saveHistory([run({ mouse: { id: "node-uuid", name: null } })]);

    expect(loadHistory()[0].mouse).toEqual({ id: "node-uuid", name: null });
  });

  it("stores no node key for a request that ran on the Spring host", () => {
    saveHistory([run()]);

    expect(loadHistory()[0].mouse).toBeNull();
  });

  it("drops a malformed node rather than persisting junk", () => {
    saveHistory([run({ mouse: { name: "no-id" } })]);

    expect(loadHistory()[0].mouse).toBeNull();
  });

  it("never persists chat content or secrets alongside the node", () => {
    saveHistory([run({ mouse: { id: "node-uuid", name: "tokyo-edge" }, apiKey: "sk-secret", content: "hello" })]);

    const raw = globalThis.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("hello");
  });
});
