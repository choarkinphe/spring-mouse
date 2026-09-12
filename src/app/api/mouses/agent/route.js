import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// The agent is one dependency-free file, so a node never has to be handed an
// artifact: it pulls its runtime from the same Spring it is about to connect to.
// That also means the two ends of the protocol cannot drift apart — whatever
// Spring serves here is exactly what its tunnel implementation expects.
//
// Standalone tracing follows imports, not `fs` reads, so next.config.mjs lists
// the script in outputFileTracingIncludes and the production image copies it
// explicitly as a fallback. The candidates below cover a dev checkout, that
// image layout, and any deployment that starts the server from elsewhere.
const AGENT_CANDIDATES = [
  process.env.MOUSE_AGENT_PATH,
  path.join(process.cwd(), "mouse", "agent.mjs"),
  "/app/mouse/agent.mjs",
].filter(Boolean);
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

function readDeclaredVersion(source) {
  const match = /const AGENT_VERSION = "([^"]+)"/.exec(source);
  return match ? match[1] : "unknown";
}

async function loadAgentSource() {
  let lastError = null;
  for (const candidate of AGENT_CANDIDATES) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  lastError.message = `${lastError.message} (tried ${AGENT_CANDIDATES.join(", ")})`;
  throw lastError;
}

export async function GET() {
  try {
    const source = await loadAgentSource();
    return new NextResponse(source, {
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/javascript; charset=utf-8",
        // Lets an operator confirm which build a node is running without
        // shelling into it.
        "X-Agent-Version": readDeclaredVersion(source),
      },
    });
  } catch (error) {
    console.error("[API] Failed to read the mouse agent script:", error);
    return NextResponse.json({ error: "Mouse agent script is unavailable" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
