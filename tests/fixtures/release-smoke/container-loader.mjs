import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:///app/open-sse/")) {
    const target = new URL(specifier, context.parentURL).pathname;
    if (target.startsWith("/app/src/")) return { url: pathToFileURL(target.replace("/app/src/", "/fixture/src/")).href, shortCircuit: true };
  }
  if (specifier.includes("open-sse/") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
    const target = new URL(specifier, context.parentURL).pathname;
    return { url: pathToFileURL(`/app/open-sse/${target.split("open-sse/")[1]}`).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const target = `/fixture/src/${specifier.slice(2)}`;
    return { url: pathToFileURL(/\.[a-z]+$/i.test(target) ? target : `${target}.js`).href, shortCircuit: true };
  }
  if (specifier.startsWith("open-sse/")) return { url: pathToFileURL(`/app/${specifier}`).href, shortCircuit: true };
  // Use packages from the candidate image, not host node_modules. Source-only
  // helper imports are supplemental; compiled HTTP routes are tested separately.
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:")) {
    try { return await nextResolve(specifier, { ...context, parentURL: "file:///app/package.json" }); } catch { /* native module */ }
  }
  return nextResolve(specifier, context);
}
