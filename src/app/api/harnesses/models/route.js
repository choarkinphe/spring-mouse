import { NextResponse } from "next/server";
import { getCustomModels } from "@/lib/db/index.js";
import { fetchModelsDevCatalog, parseModelsDevCatalog } from "@/shared/utils/modelCatalog";
import { buildHarnessModelHints } from "@/shared/utils/harnessModels";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const [catalog, synced] = await Promise.all([
    fetchModelsDevCatalog({
      fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }),
    }),
    getCustomModels(),
  ]);
  const claude = parseModelsDevCatalog(catalog, "anthropic");
  const codex = parseModelsDevCatalog(catalog, "openai");
  const models = buildHarnessModelHints({
    claude,
    codex,
    local: [...synced, ...["claude", "codex", "openai"].flatMap(getModelsByProviderId)],
  });
  const sources = {
    "claude-desktop": claude.length ? "catalog" : "local",
    "claude-code": claude.length ? "catalog" : "local",
    codex: codex.length ? "catalog" : "local",
  };
  return NextResponse.json({ models, sources }, { headers: { "Cache-Control": "no-store" } });
}
