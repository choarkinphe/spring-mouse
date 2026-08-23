import initializeApp from "./initializeApp.js";

// Skip during Next.js build/prerender — bootstrap would download cloudflared, init DNS, etc.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

// Server-only singleton: guard via global so the instrumentation hook, page
// imports, and HMR cannot start the background services more than once.
export function bootstrapApp() {
  if (typeof window !== "undefined" || isBuildPhase || global.__appBootstrapped) return;
  global.__appBootstrapped = true;
  initializeApp().catch((e) => console.error("[Bootstrap] init failed:", e.message));
}

bootstrapApp();
