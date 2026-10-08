import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { certificates } from "../tests/fixtures/release-smoke/upstream.mjs";

// Runs only a pre-existing immutable candidate. No builds, registry pushes,
// production credentials, production volumes, or unrelated container cleanup.
const image = process.argv[2];
if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Supply an immutable image@sha256:digest");
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-release-"));
const name = path.basename(dir).toLowerCase();
const network = `${name}-net`;
const app = `${name}-app`;
const upstream = `${name}-upstream`;
const port = Number(process.env.SMOKE_PORT || 8038);
const controlPort = Number(process.env.SMOKE_CONTROL_PORT || 8039);
const password = randomBytes(24).toString("hex");
let networkCreated = false;
const owned = [];
const dataVolume = `${name}-data`;
let volumeCreated = false;
const docker = (args, { quiet = false } = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr?.slice(-1000)}`);
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout.trim();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = () => {
  for (const container of owned.reverse()) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  if (networkCreated) spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  if (volumeCreated) spawnSync("docker", ["volume", "rm", dataVolume], { stdio: "ignore" });
  fs.rmSync(dir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(1); });
try {
  // Verify local identity before starting, never silently pull 'latest'.
  const inspection = JSON.parse(docker(["image", "inspect", image], { quiet: true }))[0];
  const revision = inspection.Config.Labels?.["org.opencontainers.image.revision"];
  const info = JSON.parse(docker(["run", "--rm", "--entrypoint", "node", image, "-e", "process.stdout.write(require('fs').readFileSync('/app/build-info.json','utf8'))"], { quiet: true }));
  if (info.revision !== revision) throw new Error("image/build-info revision mismatch");
  const fingerprintComplete = info.nodeMajor === 22 && info.next && info.undici && /^[a-f0-9]{64}$/.test(info.lockfileSha256 || "");
  if (!fingerprintComplete && process.env.SMOKE_ALLOW_LEGACY_IDENTITY !== "true") throw new Error("Candidate fingerprint incomplete; cannot pass release gate");
  const tls = certificates();
  fs.writeFileSync(path.join(dir, "cert.pem"), tls.cert);
  fs.writeFileSync(path.join(dir, "key.pem"), tls.key, { mode: 0o600 });
  // Docker UID may differ from the host's; fixture private directory is isolated.
  fs.chmodSync(dir, 0o755);
  const fixtureRoot = path.join(dir, "fixture");
  fs.mkdirSync(path.join(fixtureRoot, "tests", "fixtures"), { recursive: true });
  fs.cpSync(path.join(root, "tests", "fixtures", "release-smoke"), path.join(fixtureRoot, "tests", "fixtures", "release-smoke"), { recursive: true });
  fs.cpSync(path.join(root, "src"), path.join(fixtureRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "smoke.env"), [
    `INITIAL_PASSWORD=${password}`, `JWT_SECRET=${randomBytes(32).toString("hex")}`,
    `API_KEY_SECRET=${randomBytes(32).toString("hex")}`, `MACHINE_ID_SALT=${randomBytes(32).toString("hex")}`,
    "DATA_DIR=/app/data", "LOG_LEVEL=WARN", "NODE_EXTRA_CA_CERTS=/smoke-certs/cert.pem",
    "NO_PROXY=*", "HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=",
  ].join("\n"), { mode: 0o600 });
  docker(["network", "create", "--internal", network], { quiet: true }); networkCreated = true;
  docker(["run", "-d", "--name", upstream, "--network", network,
    "--network-alias", "upstream", "--network-alias", "maas.qianwenaiapi.com", "--network-alias", "token-plan.maas.qianwenaiapi.com",
    "-p", `127.0.0.1:${controlPort}:8081`, "-v", `${fixtureRoot}:/fixture:ro`, "-v", `${dir}:/smoke-certs:ro`,
    "-e", "SMOKE_CERT_DIR=/smoke-certs", "--entrypoint", "node", image, "--import", "/fixture/tests/fixtures/release-smoke/container-register.mjs", "/fixture/tests/fixtures/release-smoke/upstream.mjs"], { quiet: true }); owned.push(upstream);
  let fixtureReady = false;
  for (let i = 0; i < 100; i++) {
    const result = spawnSync("docker", ["exec", upstream, "node", "-e", "fetch('http://127.0.0.1:8081').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { stdio: "ignore" });
    if (result.status === 0) { fixtureReady = true; break; }
    await sleep(100);
  }
  if (!fixtureReady) throw new Error("fake upstream readiness timeout");
  docker(["volume", "create", dataVolume], { quiet: true }); volumeCreated = true;
  docker(["run", "-d", "--name", app, "--network", network, "-p", `127.0.0.1:${port}:8008`,
    "--env-file", path.join(dir, "smoke.env"), "-v", `${dataVolume}:/app/data`, "-v", `${fixtureRoot}:/fixture:ro`, "-v", `${dir}:/smoke-certs:ro`, image], { quiet: true }); owned.push(app);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const result = spawnSync("docker", ["exec", app, "node", "-e", "fetch('http://127.0.0.1:8008/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { stdio: "ignore" });
    if (result.status === 0) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) throw new Error("candidate readiness timeout");
  docker(["exec", app, "node", "-e", "const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,['/fixture/tests/fixtures/release-smoke/verify.mjs'],{env:{...process.env,SMOKE_URL:'http://127.0.0.1:8008',SMOKE_CONTROL_URL:'http://upstream:8081',SMOKE_PASSWORD:process.env.INITIAL_PASSWORD},stdio:'inherit'});process.exit(r.status??1)"]);
  // Execute low-level cancellation tests inside the SAME runtime image, resolving
  // the engine/packages against /app, with source-only glue explicitly supplied
  // as a supplemental test fixture (the compiled HTTP smoke above uses none).
  docker(["exec", "-e", "SMOKE_CERT_DIR=/smoke-certs", app, "node", "--import", "/fixture/tests/fixtures/release-smoke/container-register.mjs", "/fixture/tests/fixtures/release-smoke/cancellation.mjs"]);
  // Stop only the owned app so SQLite is checkpointed before the read-only
  // persistence assertion; do not snapshot a live production main DB file.
  docker(["stop", "--time", "30", app], { quiet: true });
  docker(["run", "--rm", "--volumes-from", `${app}:ro`, "-v", `${fixtureRoot}:/fixture:ro`, "--entrypoint", "node", image, "/fixture/tests/fixtures/release-smoke/read-db.mjs"]);
  const report = { image, revision, buildInfo: info, fingerprintComplete, realUpstreamVerified: false, approvalsComplete: false, passed: "isolated-smoke-only" };
  console.log(JSON.stringify(report));
} finally { cleanup(); }
