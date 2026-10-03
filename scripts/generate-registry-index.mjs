// Regenerate static imports without re-enabling explicitly disabled providers.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = fileURLToPath(new URL("../open-sse/providers/registry/", import.meta.url));
const target = path.join(dir, "index.js");
const previous = readFileSync(target, "utf8");
const disabled = new Set([...previous.matchAll(/^\/\/\s*import\s+\w+\s+from\s+["']\.\/([^"']+)["']/gm)].map((m) => m[1]));
const existing = [...previous.matchAll(/^import\s+(\w+)\s+from\s+["']\.\/([^"']+)["'];/gm)];
const known = new Set(existing.map((m) => m[2]));
const missing = readdirSync(dir).filter((file) => file.endsWith(".js") && file !== "index.js" && !disabled.has(file) && !known.has(file)).sort();
let next = Math.max(-1, ...existing.map((m) => Number(m[1].replace(/^p/, ""))).filter(Number.isFinite)) + 1;
const additions = missing.map((file) => ({ name: `p${next++}`, file }));
const output = previous
  .replace(/\nexport default \[/, `${additions.map(({ name, file }) => `\nimport ${name} from "./${file}";`).join("")}\n\nexport default [`)
  .replace(/\n\];\s*$/, `${additions.map(({ name }) => `\n  ${name},`).join("")}\n];\n`);
if (additions.length) writeFileSync(target, output);
console.log(`Added ${additions.length} registry imports; kept ${disabled.size} disabled.`);
