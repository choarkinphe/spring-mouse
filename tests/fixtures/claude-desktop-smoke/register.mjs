// Resolve the app's path aliases (`@/` -> src/, `open-sse/` -> open-sse/) for a
// plain `node` process, matching tests/vitest.config.js. Used by the seed script
// so it can import the real DB layer without Next's bundler.
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
