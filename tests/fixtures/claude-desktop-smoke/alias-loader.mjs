// Node module-resolution hook mapping the app's path aliases to the repo.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const srcUrl = pathToFileURL(path.join(repoRoot, "src") + "/").href;
const sseUrl = pathToFileURL(path.join(repoRoot, "open-sse") + "/").href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "open-sse") return nextResolve(sseUrl, context);
  if (specifier.startsWith("open-sse/")) return nextResolve(sseUrl + specifier.slice("open-sse/".length), context);
  if (specifier.startsWith("@/")) {
    const target = srcUrl + specifier.slice(2);
    return nextResolve(path.extname(target) ? target : `${target}.js`, context);
  }
  return nextResolve(specifier, context);
}
