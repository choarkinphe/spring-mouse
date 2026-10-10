import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { REQUEST_SIZE_DIAGNOSTICS as CONFIG, REQUEST_SIZE_IMAGE_TYPES } from "../config/requestSizeDiagnostics.js";

const hash = (value) => value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 16) : null;
const uuid = (value) => /^[a-f0-9-]{36}$/i.test(value || "") ? value : null;
const bytes = (value) => typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;

export function requestSizeShape(serialized, body = {}) {
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  let images = 0;
  let imageStringBytes = 0;
  let textStringBytes = bytes(body.input);
  let blocks = 0;
  let inspectedItems = 0;
  for (const item of items) {
    if (inspectedItems >= CONFIG.maxItems) break;
    inspectedItems++;
    const content = item?.content;
    textStringBytes += bytes(content);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (blocks >= CONFIG.maxBlocks) break;
      blocks++;
      textStringBytes += bytes(block?.text);
      if (REQUEST_SIZE_IMAGE_TYPES.has(block?.type)) {
        images++;
        imageStringBytes += bytes(typeof block.image_url === "string" ? block.image_url : block.image_url?.url)
          + bytes(block.source?.data) + bytes(block.source?.url);
      }
    }
  }
  return {
    requestBytes: Buffer.byteLength(serialized, "utf8"),
    requestChars: serialized.length,
    inputItems: items.length,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    images, imageStringBytes, textStringBytes,
    instructionsChars: typeof body.instructions === "string" ? body.instructions.length : 0,
    instructionsBytes: bytes(body.instructions),
    sampled: inspectedItems < items.length || blocks >= CONFIG.maxBlocks,
  };
}

export function createRequestSizeDiagnostics({ provider, model, connectionId, requestId, urlIndex = 0, retry = 0, transport = "http", serialized, body, log, now = Date.now }) {
  if (!CONFIG.providers.includes(provider)) return null;
  try {
    const start = now();
    const record = {
      sendId: randomUUID(), requestId: uuid(requestId),
      accountHash: hash(connectionId), providerHash: hash(provider), modelHash: hash(model),
      urlIndex, retry, transport, ...requestSizeShape(serialized, body),
    };
    const emit = (phase, status = null, failure = null) => {
      try {
        log?.errorLine?.("", "🔬", `REQUEST-SIZE | ${JSON.stringify({
          ...record, phase, status, failure, elapsedMs: Math.max(0, now() - start),
        })}`);
      } catch { /* diagnostic logging must never affect dispatch */ }
    };
    emit("send");
    return {
      response(status) { emit("response_headers", Number.isInteger(status) ? status : null); },
      error(error) { emit("fetch_error", null, error?.name === "AbortError" ? "aborted" : "transport_error"); },
    };
  } catch { return null; }
}
