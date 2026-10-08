import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function validateRelease(record) {
  if (!record?.image || !/^choarkinphe\/spring-mouse@sha256:[a-f0-9]{64}$/.test(record.image)) throw new Error("immutable release image required");
  if (!/^[a-f0-9]{40}$/.test(record.revision || "")) throw new Error("full revision required");
  if (!/^\d+\.\d+\.\d+$/.test(record.version || "")) throw new Error("release version required");
  for (const key of ["unitTests", "containerSmoke", "cancellationMatrix", "resourceRecovery", "realUpstream", "proxyPath", "rollbackRehearsal", "runtimeFingerprint"]) {
    if (record.gates?.[key]?.passed !== true || !record.gates[key].evidence) throw new Error(`missing gate: ${key}`);
  }
  if (!(record.observation?.durationSeconds >= 300) || record.observation?.passed !== true || !record.observation.evidence) throw new Error("five-minute pre-release observation required");
  if (!/^choarkinphe\/spring-mouse@sha256:[a-f0-9]{64}$/.test(record.rollbackImage || "")) throw new Error("immutable rollback image required");
  const approvals = (record.approvals || []).filter((a) => a.approved === true && a.name && a.at);
  const owners = approvals.filter((a) => a.role === "code-owner");
  const releases = approvals.filter((a) => a.role === "release-owner");
  if (!owners.some((owner) => releases.some((release) => owner.name !== release.name))) throw new Error("two explicit owner approvals required");
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = validateRelease(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  const run = (args) => {
    const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
    return result.stdout;
  };
  const manifest = JSON.parse(run(["buildx", "imagetools", "inspect", record.image, "--raw"]));
  if (!Array.isArray(manifest.manifests) || !["amd64", "arm64"].every((arch) => manifest.manifests.some((m) => m.platform?.os === "linux" && m.platform?.architecture === arch))) throw new Error("multi-architecture candidate required");
  for (const platform of manifest.manifests.filter((m) => m.platform?.os === "linux" && ["amd64", "arm64"].includes(m.platform?.architecture))) {
    const ref = `choarkinphe/spring-mouse@${platform.digest}`;
    const metadata = JSON.parse(run(["buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"]));
    const labels = metadata.config?.Labels || {};
    if (labels["org.opencontainers.image.revision"] !== record.revision) throw new Error("platform image revision mismatch");
  }
  // This is an outward-facing action; invoke only after a human has explicitly
  // authorized promotion. Evidence validation is a gate, not delegated consent.
  if (!process.argv.includes("--publish")) {
    console.log(JSON.stringify({ validated: true, image: record.image, publishing: false }));
  } else {
    run(["buildx", "imagetools", "create", "-t", `choarkinphe/spring-mouse:v${record.version}`, "-t", "choarkinphe/spring-mouse:latest", record.image]);
    console.log(JSON.stringify({ published: true, image: record.image, revision: record.revision, version: record.version }));
  }
}
