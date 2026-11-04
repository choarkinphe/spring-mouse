import { mkdir, writeFile, readFile, rename, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { QODER_NATIVE, nativeDigest, extractOfficialNative } from "../runtime/qoder-native-identity.mjs";

const destination = resolve(process.argv[2] || "");
const arch = process.argv[3] || process.arch;
if (!process.argv[2] || !QODER_NATIVE.binaries[arch]) throw new Error("Supply output directory and x64/arm64 architecture");
await mkdir(destination, { recursive: true, mode: 0o700 });
const target = join(destination, `runtime-info-linux-${arch}`);
let existing;
try { existing = await readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing && nativeDigest(existing) === QODER_NATIVE.binaries[arch].sha256) {
  await chmod(target, 0o700);
  console.log(`Verified existing Qoder ${QODER_NATIVE.version} helper for ${arch}`);
} else {
  // Never import or execute the downloaded bundle. Verify its pinned digest,
  // extract only the official embedded bytes, and atomically install them.
  const response = await fetch(QODER_NATIVE.bundleUrl, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official Qoder artifact download failed: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 50 * 1024 * 1024) throw new Error("Qoder artifact exceeds size limit");
  const binary = extractOfficialNative(body, arch);
  const temporary = join(destination, `.runtime-info-${randomUUID()}`);
  await writeFile(temporary, binary, { mode: 0o700, flag: "wx" });
  await rename(temporary, target);
  console.log(`Installed verified Qoder ${QODER_NATIVE.version} helper for ${arch}`);
}
