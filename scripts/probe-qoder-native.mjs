// One-shot check: no HTTP server, no credentials, no identity values on stdout.
import { runOfficialNative } from "../runtime/qoder-native-identity.mjs";
import { mkdir } from "node:fs/promises";
const cwd = process.env.QODER_NATIVE_STATE_DIR || "/tmp/qoder-native-state";
await mkdir(cwd, { recursive: true, mode: 0o700 });
const started = Date.now();
try {
  const identity = await runOfficialNative({ binary: process.argv[2], cwd, region: "global" });
  console.log(JSON.stringify({ nativeIdentityVerified: true, version: "1.1.82", elapsedMs: Date.now() - started,
    fields: Object.keys(identity), secretsPrinted: false }));
} catch {
  console.log(JSON.stringify({ nativeIdentityVerified: false, elapsedMs: Date.now() - started, secretsPrinted: false }));
  process.exitCode = 1;
}
