import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { certificates } from "../fixtures/release-smoke/upstream.mjs";

describe("real outbound cancellation matrix", () => {
  it("reclaims stalled TLS/headers/stream/body/retry work and serves a healthy request afterwards", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-cancel-"));
    const tls = certificates();
    fs.writeFileSync(path.join(dir, "key.pem"), tls.key, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "cert.pem"), tls.cert);
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", path.resolve(import.meta.dirname, "../fixtures/claude-desktop-smoke/register.mjs"), path.resolve(import.meta.dirname, "../fixtures/release-smoke/cancellation.mjs")], {
          env: { ...process.env, SMOKE_CERT_DIR: dir, NODE_EXTRA_CA_CERTS: path.join(dir, "cert.pem"), NO_PROXY: "*", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
        child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout.trim().split("\n").at(-1));
      expect(record.concurrentCancelled).toBe(20);
      expect(record.healthyAfterCancel).toBe(true);
      expect(record.outcomes).toHaveLength(12);
      expect(record.after.active).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true }); }
  }, 60000);
});
