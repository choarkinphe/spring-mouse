import { describe, expect, it } from "vitest";
import { OFFICIAL_MODEL_CATALOG } from "@/shared/config/officialModelCatalog.js";
import {
  parseDeepgramModels,
  parseFalModelPage,
  parseOfficialCatalogModels,
} from "@/shared/utils/officialModelCatalogShapes.js";

// Documentation-derived fixtures only: no API keys, live calls, or user DB.
const falPage = (extra = {}) => ({
  models: [{ endpoint_id: "fal-ai/flux/dev", metadata: { display_name: "FLUX.1 [dev]", category: "text-to-image" } }],
  next_cursor: null,
  has_more: false,
  ...extra,
});
const deepgramList = (extra = {}) => ({
  stt: [{ name: "nova-3", canonical_name: "nova-3", uuid: "stt-version-uuid", languages: ["en"] }],
  tts: [{ name: "zeus", canonical_name: "aura-2-zeus-en", uuid: "tts-version-uuid" }],
  ...extra,
});

describe("verified official catalog configuration", () => {
  it.each([
    ["xiaomi-mimo", "https://api.xiaomimimo.com/v1/models", "bearer", "account"],
    ["fal-ai", "https://api.fal.ai/v1/models", "none", "public"],
    ["deepgram", "https://api.deepgram.com/v1/models", "token", "account"],
    ["elevenlabs", "https://api.elevenlabs.io/v1/models", "xi-api-key", "account"],
  ])("pins the documented %s endpoint and auth scheme", (provider, url, auth, scope) => {
    expect(OFFICIAL_MODEL_CATALOG[provider]).toMatchObject({ url, auth, scope });
  });

  it("requires fal pagination and the two provider-specific payload shapes", () => {
    expect(OFFICIAL_MODEL_CATALOG["fal-ai"]).toMatchObject({ shape: "fal", pagination: "fal-cursor" });
    expect(OFFICIAL_MODEL_CATALOG.deepgram.shape).toBe("deepgram");
  });

  it.each(["xiaomi-tokenplan", "glm", "glm-cn", "kimi", "kimi-coding", "qianwen-token-plan", "fish-audio", "bfl", "runway", "recraft"])(
    "does not guess a model directory for %s", (provider) => {
      expect(OFFICIAL_MODEL_CATALOG).not.toHaveProperty(provider);
    },
  );

  it("retains established public directories without sending credentials", () => {
    for (const provider of ["venice", "kilocode", "kilo-gateway", "cline", "sambanova", "opencode"]) {
      expect(OFFICIAL_MODEL_CATALOG[provider]).toMatchObject({ auth: "none", scope: "public" });
    }
    expect(OFFICIAL_MODEL_CATALOG.opencode.filter).toBe("opencode-free");
  });
});

describe("fal official model page", () => {
  it("uses endpoint_id and metadata display name, preserving metadata", () => {
    expect(parseFalModelPage(falPage())).toEqual({
      models: [{ endpoint_id: "fal-ai/flux/dev", id: "fal-ai/flux/dev", name: "FLUX.1 [dev]", metadata: { display_name: "FLUX.1 [dev]", category: "text-to-image" } }],
      nextCursor: null,
    });
  });

  it("returns the opaque next cursor instead of declaring a first page complete", () => {
    expect(parseFalModelPage(falPage({ next_cursor: "Mg==", has_more: true })).nextCursor).toBe("Mg==");
  });

  it("accepts terminal pages with an omitted optional cursor and empty lists", () => {
    expect(parseFalModelPage({ models: [], has_more: false })).toEqual({ models: [], nextCursor: null });
  });

  it("uses endpoint_id as the display name when optional metadata is absent", () => {
    expect(parseFalModelPage(falPage({ models: [{ endpoint_id: "fal-ai/flux/dev" }] })).models[0].name).toBe("fal-ai/flux/dev");
  });

  it.each([
    ["null payload", null], ["array payload", []], ["missing models", { has_more: false }],
    ["missing has_more", { models: [] }], ["invalid has_more", falPage({ has_more: "false" })],
    ["missing advancing cursor", falPage({ has_more: true })],
    ["contradictory terminal cursor", falPage({ next_cursor: "Mg==" })],
    ["numeric cursor", falPage({ next_cursor: 2, has_more: true })],
    ["blank cursor", falPage({ next_cursor: "", has_more: true })],
    ["padded cursor", falPage({ next_cursor: " Mg== ", has_more: true })],
    ["null entry", falPage({ models: [null] })],
    ["wrong identifier", falPage({ models: [{ id: "not-endpoint-id", name: "display" }] })],
    ["unrelated model_id fallback", falPage({ models: [{ model_id: "not-endpoint-id" }] })],
    ["unrelated slug fallback", falPage({ models: [{ slug: "not-endpoint-id" }] })],
    ["numeric identifier", falPage({ models: [{ endpoint_id: 123 }] })],
    ["blank identifier", falPage({ models: [{ endpoint_id: " " }] })],
    ["padded identifier", falPage({ models: [{ endpoint_id: " fal-ai/flux/dev" }] })],
    ["partial malformed list", falPage({ models: [{ endpoint_id: "valid" }, {}] })],
  ])("rejects %s rather than claiming official success", (_label, data) => {
    expect(() => parseFalModelPage(data)).toThrow("Upstream returned an invalid model list");
  });
});

describe("Deepgram official model shape", () => {
  it("combines both collections and uses canonical identifiers, not UUIDs or TTS voice names", () => {
    const models = parseDeepgramModels(deepgramList());
    expect(models.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: "nova-3", name: "nova-3", kind: "stt" },
      { id: "aura-2-zeus-en", name: "zeus", kind: "tts" },
    ]);
    expect(models[0].languages).toEqual(["en"]);
  });

  it("supports optional collections and an explicitly empty official list", () => {
    expect(parseDeepgramModels({ stt: [] })).toEqual([]);
    expect(parseDeepgramModels({ tts: [] })).toEqual([]);
    expect(parseDeepgramModels({ stt: [], tts: [] })).toEqual([]);
  });

  it("deduplicates versions of the same canonical model without mutating the response", () => {
    const data = deepgramList();
    data.stt.push({ ...data.stt[0], uuid: "another-version" });
    const before = structuredClone(data);
    expect(parseDeepgramModels(data)).toHaveLength(2);
    expect(data).toEqual(before);
  });

  it.each([
    ["null payload", null], ["absent collections", {}], ["generic data list", { data: [] }],
    ["null collection", deepgramList({ tts: null })],
    ["object collection", deepgramList({ stt: {} })],
    ["null entry", deepgramList({ stt: [null] })],
    ["display name only", deepgramList({ tts: [{ name: "zeus", uuid: "voice-uuid" }] })],
    ["wrong id fallback", deepgramList({ stt: [{ id: "nova-3" }] })],
    ["unrelated slug fallback", deepgramList({ stt: [{ slug: "nova-3" }] })],
    ["unrelated model_id fallback", deepgramList({ tts: [{ model_id: "voice-id" }] })],
    ["management error code", deepgramList({ err_code: "INVALID_AUTH" })],
    ["management error message", deepgramList({ err_msg: "Invalid authentication" })],
    ["blank canonical identifier", deepgramList({ stt: [{ canonical_name: " " }] })],
    ["numeric canonical identifier", deepgramList({ stt: [{ canonical_name: 3 }] })],
    ["partial malformed list", deepgramList({ stt: [{ canonical_name: "nova-3" }, {}] })],
  ])("rejects %s instead of mixing voices or incomplete data into the catalog", (_label, data) => {
    expect(() => parseDeepgramModels(data)).toThrow("Upstream returned an invalid model list");
  });
});

describe("catalog parser integration", () => {
  it("dispatches special shapes and retains ElevenLabs model_id array support", () => {
    expect(parseOfficialCatalogModels(falPage(), "fal")).toEqual(parseFalModelPage(falPage()).models);
    expect(parseOfficialCatalogModels(deepgramList(), "deepgram")).toEqual(parseDeepgramModels(deepgramList()));
    expect(parseOfficialCatalogModels([{ model_id: "eleven_multilingual_v2", name: "Multilingual v2" }])).toEqual([
      { model_id: "eleven_multilingual_v2", id: "eleven_multilingual_v2", name: "Multilingual v2" },
    ]);
  });

  it.each([
    ["fal", falPage], ["deepgram", deepgramList],
  ])("keeps business-error checks for %s", (shape, fixture) => {
    for (const failure of [{ error: { message: "private diagnostic" } }, { warning: "stale" }, { success: false }, { code: 401 }]) {
      expect(() => parseOfficialCatalogModels(fixture(failure), shape)).toThrow("Upstream returned an invalid model list");
    }
  });
});
