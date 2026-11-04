import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const QODER_NATIVE = Object.freeze({
  version: "1.1.82",
  bundleUrl: "https://cdn.jsdelivr.net/npm/@qoder-ai/qodercli@1.1.82/bundle/qoder-worker-runtime.mjs",
  bundleSha256: "3fa3b9ca5907b9b74e658d63b0ce4757d620cd76edafbabd3a5211dc83028ab9",
  binaries: Object.freeze({
    x64: { variable: "_el", sha256: "e30b307eaae12680d2f4e220d4d34b0ea4f70355a624d6d55ee916e03f7d7478" },
    arm64: { variable: "$el", sha256: "2df9d2c5aa44cb6c45ad27f493bf3dca2aaf1e067fa0ad6e88c6cad0153329fe" },
  }),
  // Official 1.1.82 global build uses SINGAPORE=4, CN ONLINE=0.
  environments: Object.freeze({ global: "4", cn: "0" }),
});

export function nativeDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function extractOfficialNative(bundle, arch) {
  if (nativeDigest(bundle) !== QODER_NATIVE.bundleSha256) throw new Error("Qoder bundle integrity mismatch");
  const config = QODER_NATIVE.binaries[arch];
  if (!config) throw new Error("Unsupported Qoder native architecture");
  const name = config.variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = bundle.toString("utf8").match(new RegExp(`${name}="([A-Za-z0-9+/=]+)"`));
  if (!match) throw new Error("Qoder native artifact missing");
  const bytes = Buffer.from(match[1], "base64");
  if (nativeDigest(bytes) !== config.sha256) throw new Error("Qoder native integrity mismatch");
  return bytes;
}

export function validateNativeIdentity(value) {
  // Official bridge builds may expose these fields directly; a few releases wrap
  // them under `info`. Accept only these two documented object shapes.
  if (value?.info && typeof value.info === "object") value = value.info;
  const clean = {};
  for (const field of ["machineToken", "machineType", "machineCode"]) {
    const item = value?.[field];
    if (typeof item !== "string" || !item.trim() || item.length > 8192 || !/^[\x21-\x7e]+$/.test(item)) {
      throw new Error("Qoder native identity invalid");
    }
    clean[field] = item;
  }
  return clean;
}

// Official helper can remain alive after emitting its first JSON line. Await
// first-line identity, terminate our own child, and wait for exit before reuse.
export async function runOfficialNative({ binary, region = "global", arch = process.arch,
  cwd, timeoutMs = 25000, spawnProcess = spawn }) {
  const expected = QODER_NATIVE.binaries[arch];
  if (!expected || !Object.hasOwn(QODER_NATIVE.environments, region)) throw new Error("Invalid Qoder native configuration");
  if (nativeDigest(await readFile(binary)) !== expected.sha256) throw new Error("Qoder native integrity mismatch");
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, [QODER_NATIVE.environments[region]], {
      cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    let output = "", identity, failure, settled = false, killTimer, finalTimer;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(finalTimer);
      if (failure) reject(new Error(failure));
      else if (identity) resolve(identity);
      else reject(new Error("Qoder native helper exited without identity"));
    };
    const stop = () => {
      if (child.exitCode !== null && child.exitCode !== undefined) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      finalTimer = setTimeout(() => { failure = "Qoder native helper did not terminate"; child.stdout.destroy(); child.unref(); finish(); }, 5000);
      killTimer.unref?.();
    };
    const deadline = setTimeout(() => { failure = "Qoder native identity timed out"; stop(); }, timeoutMs);
    child.stdout.on("data", chunk => {
      if (identity || failure) return;
      output += chunk.toString("utf8");
      if (output.length > 65536) { failure = "Qoder native output too large"; stop(); return; }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try { identity = validateNativeIdentity(JSON.parse(output.slice(0, newline))); }
      catch { failure = "Qoder native identity invalid"; }
      stop();
    });
    child.once("error", () => { failure = "Qoder native helper could not start"; finish(); });
    child.once("close", finish);
  });
}
