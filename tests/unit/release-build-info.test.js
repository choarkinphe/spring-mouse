import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildInfo } from "../../scripts/write-build-info.mjs";

const root = path.resolve(import.meta.dirname, "../..");

describe("release identity", () => {
  it("fingerprints the committed lockfile and installed runtime packages", () => {
    const info = buildInfo(root, "test-revision");
    expect(info.revision).toBe("test-revision");
    expect(info.nodeMajor).toBe(22);
    expect(info.next).toMatch(/^\d+\./);
    expect(info.undici).toMatch(/^\d+\./);
    expect(info.lockfileSha256).toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "package-lock.json"))).digest("hex"));
  });

  it("fails closed when the lockfile is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-info-"));
    try { expect(() => buildInfo(dir)).toThrow(); } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("requires reproducible installs and publishes candidates, not latest", () => {
    const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");
    expect(docker).toContain("COPY package.json package-lock.json ./");
    expect(docker).not.toMatch(/npm install|sed -i/);
    expect(docker).toContain("write-build-info.mjs");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("npm --prefix tests ci");
    expect(workflow).not.toContain("value=latest");
    expect(workflow).toContain("value=candidate-");
  });
});
