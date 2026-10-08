import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function buildInfo(root, revision = process.env.APP_BUILD_VERSION || "dev") {
  const require = createRequire(path.join(root, "package.json"));
  const lock = fs.readFileSync(path.join(root, "package-lock.json"));
  const version = (name) => JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
  return {
    revision,
    buildId: revision,
    appVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
    node: process.version,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    next: version("next"),
    undici: version("undici"),
    lockfileSha256: createHash("sha256").update(lock).digest("hex"),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  fs.writeFileSync(path.join(root, "build-info.json"), `${JSON.stringify(buildInfo(root), null, 2)}\n`);
}
