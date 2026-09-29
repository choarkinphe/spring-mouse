import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-restore-test-"));
process.env.DATA_DIR = tmpDir;

const { MARKER_FILE, STAGING_FILE, getRestoreState, clearRestoreMarker, markRestorePending, canSwapOnBoot } =
  await import("../../src/lib/backup/restore.js");

beforeEach(() => {
  fs.mkdirSync(path.dirname(STAGING_FILE), { recursive: true });
  try { fs.rmSync(MARKER_FILE, { force: true }); } catch {}
  try { fs.rmSync(STAGING_FILE, { force: true }); } catch {}
});

describe("restore marker", () => {
  it("reports nothing pending on a clean install", () => {
    const state = getRestoreState();
    expect(state.pending).toBe(false);
    expect(state.pendingSince).toBeNull();
    expect(state.staged).toBe(false);
    expect(state.stagedBytes).toBe(0);
  });

  it("refuses to mark a restore when nothing has been staged", () => {
    // This is the guard that keeps a marker from pointing at a file that was
    // never downloaded — entrypoint would find nothing to swap and clear the
    // marker, so the operator's "restore" would silently do nothing.
    expect(() => markRestorePending()).toThrow(/No verified restore is staged/);
    expect(getRestoreState().pending).toBe(false);
  });

  it("records intent once a staging file exists", () => {
    fs.writeFileSync(STAGING_FILE, "not-really-sqlite");
    markRestorePending({ requestedBy: "test" });

    const state = getRestoreState();
    expect(state.pending).toBe(true);
    expect(state.staged).toBe(true);
    expect(state.stagedBytes).toBeGreaterThan(0);
    expect(state.pendingSince).toMatch(/^\d{4}-/);
  });

  it("clears the marker so a boot loop cannot be created by a failed swap", () => {
    fs.writeFileSync(STAGING_FILE, "x");
    markRestorePending();
    expect(getRestoreState().pending).toBe(true);

    clearRestoreMarker();
    expect(getRestoreState().pending).toBe(false);
  });

  it("tolerates clearing an already-absent marker", () => {
    expect(() => clearRestoreMarker()).not.toThrow();
  });

  it("reports whether this deployment can perform the boot swap", () => {
    // Off by default: a bare `npm run start` has nothing to apply the swap, and
    // the dashboard must refuse rather than exit into a dead service.
    delete process.env.SPRING_MOUSE_BOOT_RESTORE;
    expect(canSwapOnBoot()).toBe(false);
    expect(getRestoreState().canSwapOnBoot).toBe(false);

    process.env.SPRING_MOUSE_BOOT_RESTORE = "1";
    expect(canSwapOnBoot()).toBe(true);
    expect(getRestoreState().canSwapOnBoot).toBe(true);
    delete process.env.SPRING_MOUSE_BOOT_RESTORE;
  });
});
