import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  MOUSE_UNSUPPORTED_PROVIDERS,
  supportsMouseExecution,
} from "@/shared/constants/mouseSupport.js";

// ============================================================
// The Mouse branch lives at the very top of BaseExecutor.execute():
//
//   if (credentials?.mouseExecution) return this.executeViaMouse(...)
//
// An executor that overrides execute() and never calls super.execute() makes
// that branch unreachable, so binding a Mouse to such an account silently
// keeps traffic on the Spring host. `MOUSE_UNSUPPORTED_PROVIDERS` is the
// single source of truth the UI and the /api/providers write path consult.
//
// These tests fail when that list drifts from the real executor code — e.g.
// someone rewrites a delegating executor to stop calling super.execute().
// Run from the repo root: `npx vitest run unit/mouse-support.test.js`.
// ============================================================

const EXECUTORS_DIR = path.resolve("open-sse/executors");

/** provider key → executor class → source file, straight from the registry. */
function readExecutorRegistry() {
  const source = fs.readFileSync(path.join(EXECUTORS_DIR, "index.js"), "utf-8");

  const classToFile = new Map();
  for (const match of source.matchAll(
    /import\s+(?:\{\s*)?(?:default as\s+)?(\w+)(?:\s*\})?\s+from\s+"\.\/([\w.-]+\.js)"/g,
  )) {
    classToFile.set(match[1], match[2]);
  }

  const entries = [];
  for (const match of source.matchAll(
    /^\s*["'`]?([\w-]+)["'`]?\s*:\s*new\s+(\w+)\s*\(/gm,
  )) {
    entries.push({
      provider: match[1],
      className: match[2],
      file: classToFile.get(match[2]) || null,
    });
  }
  return entries;
}

/**
 * True when the executor defines its own `execute()` and never hands control
 * back to BaseExecutor via `super.execute()`. Files are scanned rather than
 * imported so the check does not depend on optional native deps.
 */
function bypassesBaseExecute(file) {
  const source = fs.readFileSync(path.join(EXECUTORS_DIR, file), "utf-8");
  const definesExecute = /^[ \t]+(?:async\s+)?execute\s*\(/m.test(source);
  if (!definesExecute) return false;
  return !/super\.execute\s*\(/.test(source);
}

const REGISTRY = readExecutorRegistry();

describe("Mouse execution support", () => {
  it("MOUSE_UNSUPPORTED_PROVIDERS matches the executors that bypass BaseExecutor.execute", () => {
    const detected = REGISTRY
      .filter((entry) => entry.file && bypassesBaseExecute(entry.file))
      .map((entry) => entry.provider)
      .sort();

    expect(detected).toEqual([...MOUSE_UNSUPPORTED_PROVIDERS].sort());
  });

  it("every registered provider key resolves to an executor file", () => {
    const unresolved = REGISTRY.filter((entry) => !entry.file).map((entry) => entry.provider);
    expect(unresolved).toEqual([]);
  });

  it("registered aliases inherit the verdict of the executor they point at", () => {
    // e.g. `cu` → CursorExecutor must be unsupported, `gcli` → GrokCliExecutor supported.
    const byClass = new Map();
    for (const entry of REGISTRY) {
      const verdict = supportsMouseExecution(entry.provider);
      const previous = byClass.get(entry.className);
      if (previous === undefined) byClass.set(entry.className, verdict);
      else expect(verdict, `alias "${entry.provider}" disagrees with ${entry.className}`).toBe(previous);
    }
  });

  it("supportsMouseExecution agrees with the declared list", () => {
    for (const provider of MOUSE_UNSUPPORTED_PROVIDERS) {
      expect(supportsMouseExecution(provider), `${provider} should be unsupported`).toBe(false);
    }
    for (const entry of REGISTRY) {
      if (MOUSE_UNSUPPORTED_PROVIDERS.includes(entry.provider)) continue;
      expect(supportsMouseExecution(entry.provider), `${entry.provider} should be supported`).toBe(true);
    }
  });

  it("treats unknown providers as supported (DefaultExecutor handles them)", () => {
    expect(supportsMouseExecution("openai")).toBe(true);
    expect(supportsMouseExecution("some-brand-new-provider")).toBe(true);
    expect(supportsMouseExecution("CuRsOr-ReAlLy")).toBe(true); // case-insensitive, unknown slug
    expect(supportsMouseExecution("cursor")).toBe(false);
    expect(supportsMouseExecution("Cursor")).toBe(false);
    expect(supportsMouseExecution("  cursor  ")).toBe(false);
  });

  it("rejects empty / non-string providers instead of guessing", () => {
    expect(supportsMouseExecution(undefined)).toBe(false);
    expect(supportsMouseExecution(null)).toBe(false);
    expect(supportsMouseExecution("")).toBe(false);
    expect(supportsMouseExecution("   ")).toBe(false);
    expect(supportsMouseExecution(42)).toBe(false);
  });
});
