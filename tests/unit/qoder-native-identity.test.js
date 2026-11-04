import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
import { readFile } from "node:fs/promises";
import { extractOfficialNative, validateNativeIdentity, runOfficialNative } from "../../runtime/qoder-native-identity.mjs";

afterEach(() => vi.clearAllMocks());
const identity = { machineToken: "fixture-native-token", machineType: "fixture-native-type", machineCode: "fixture-native-code" };
describe("pinned official Qoder native runtime", () => {
  it("rejects altered download before extraction or execution", () => {
    expect(() => extractOfficialNative(Buffer.from("untrusted"), "x64")).toThrow(/integrity/);
  });
  it("accepts documented native fields but rejects empty/header-injected values", () => {
    expect(validateNativeIdentity(identity)).toEqual(identity);
    expect(validateNativeIdentity({ info: identity })).toEqual(identity);
    for (const value of [null, {}, { ...identity, machineToken: "fake\r\nheader" }, { ...identity, machineType: "" }]) {
      expect(() => validateNativeIdentity(value)).toThrow(/invalid/);
    }
  });
  it("never launches an altered installed executable", async () => {
    readFile.mockResolvedValue(Buffer.from("wrong binary"));
    const spawnProcess = vi.fn();
    await expect(runOfficialNative({ binary: "/untrusted", arch: "x64", spawnProcess })).rejects.toThrow(/integrity/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
