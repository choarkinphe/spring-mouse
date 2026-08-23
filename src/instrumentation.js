export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
  initConsoleLogCapture();

  // This hook runs when the production Next.js server starts, rather than on
  // the first rendered page. That makes the persisted tunnel start promptly
  // after a Docker redeploy.
  const { bootstrapApp } = await import("./shared/services/bootstrap.js");
  bootstrapApp();
}
