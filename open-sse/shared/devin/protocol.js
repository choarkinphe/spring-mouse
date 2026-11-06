// Protocol implementation informed by CLIProxyAPI (MIT), pinned commit
// c2f402b45643f0740d70b9010fd7d8d0aab7ef65. No external code is executed.
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { DEVIN } from "../../config/devin.js";
import { runWithAbortDeadline } from "../../utils/abortable.js";
import { decodeProtobuf, encodeBytesField as b, protobufNumber } from "./protobuf.js";

export class DevinProtocolError extends Error {
  constructor(message, code = "devin_protocol_error", status = 502) {
    super(message);
    this.name = "DevinProtocolError";
    this.code = code;
    this.status = status;
  }
}
export function generateDevinFingerprint(seed = "") {
  if (!seed) return randomBytes(DEVIN.fingerprintHexLength / 2).toString("hex");
  let fingerprint = "";
  for (let i = 0; fingerprint.length < DEVIN.fingerprintHexLength; i++) {
    fingerprint += createHash("sha256").update(`${seed}-${i}`).digest("hex");
  }
  return fingerprint.slice(0, DEVIN.fingerprintHexLength);
}
export function normalizeDevinSessionToken(raw) {
  const token = String(raw || "").trim();
  return token.startsWith(DEVIN.rawJwtPrefix) ? `${DEVIN.sessionTokenPrefix}${token}` : token;
}
export function buildDevinClientMetadata({ sessionToken, deviceSeed = "", osName = process.platform === "win32" ? "windows" : process.platform } = {}) {
  sessionToken = normalizeDevinSessionToken(sessionToken);
  if (!sessionToken) throw new Error("Devin session token is required");
  return Buffer.concat([
    b(1, DEVIN.clientName), b(2, DEVIN.clientVersion), b(3, sessionToken),
    b(4, DEVIN.locale), b(5, osName), b(7, DEVIN.clientVersion),
    b(12, DEVIN.extensionName), b(28, DEVIN.extensionName),
  ]);
}
export function buildDevinHeaders(sessionToken, { unary = false } = {}) {
  sessionToken = normalizeDevinSessionToken(sessionToken);
  if (!sessionToken) throw new Error("Devin session token is required");
  const headers = {
    Authorization: `Basic ${sessionToken}`,
    "Content-Type": DEVIN.contentType,
    "Connect-Protocol-Version": "1",
    Accept: "*/*",
    "User-Agent": "",
  };
  if (!unary) headers["Sentry-Trace"] = `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-1`;
  return headers;
}
export function wrapConnectEnvelope(payload, flag = DEVIN.flags.data) {
  const bytes = Buffer.from(payload);
  if (!Number.isInteger(flag) || flag < 0 || flag > 3) throw new DevinProtocolError("Invalid Connect frame flag");
  if (bytes.length > DEVIN.maxFrameBytes) throw new DevinProtocolError("Connect frame exceeds size limit");
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/** Split-safe bounded Connect reader. Requires an EOS trailer, even if a stop
 * reason was already seen. Cancel/abort releases the original upstream body. */
export async function* readConnectFrames(body, { signal, maxFrameBytes = DEVIN.maxFrameBytes, maxDecompressedBytes = DEVIN.maxDecompressedBytes } = {}) {
  if (!body) throw new DevinProtocolError("Missing Devin response body");
  const reader = body.getReader();
  let chunk = new Uint8Array(0);
  let offset = 0;
  const cancel = reason => { try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { /* closed */ } };
  const onAbort = () => cancel(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const exact = async size => {
    const output = Buffer.alloc(size);
    let written = 0;
    while (written < size) {
      if (signal?.aborted) {
        const error = new Error("Devin request aborted", { cause: signal.reason });
        error.name = "AbortError";
        throw error;
      }
      if (offset === chunk.length) {
        const next = await runWithAbortDeadline(() => reader.read(), { signal });
        if (next.done) throw new DevinProtocolError("Devin stream ended before EOS trailer (unexpected EOF)", "stream_truncated");
        chunk = next.value;
        offset = 0;
        if (!chunk.length) continue;
      }
      const count = Math.min(size - written, chunk.length - offset);
      output.set(chunk.subarray(offset, offset + count), written);
      written += count;
      offset += count;
    }
    return output;
  };
  try {
    while (true) {
      const header = await exact(5);
      const flag = header[0];
      if (flag > 3) throw new DevinProtocolError(`Invalid Connect frame flag: ${flag}`);
      const size = header.readUInt32BE(1);
      if (size > maxFrameBytes) throw new DevinProtocolError("Connect frame exceeds size limit");
      let payload = await exact(size);
      if (flag & DEVIN.flags.compressed) {
        try { payload = gunzipSync(payload, { maxOutputLength: maxDecompressedBytes }); }
        catch (error) { throw new DevinProtocolError(`Invalid or oversized Connect gzip frame: ${error.message}`); }
      }
      if (payload.length > maxDecompressedBytes) throw new DevinProtocolError("Decompressed Connect frame exceeds size limit");
      yield { flag, payload };
      if (flag & DEVIN.flags.end) return;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cancel();
    try { reader.releaseLock(); } catch { /* an aborted read may still be pending */ }
  }
}

export function parseDevinTrailer(payload) {
  let trailer;
  try { trailer = JSON.parse(Buffer.from(payload).toString("utf8")); }
  catch { throw new DevinProtocolError("Malformed Devin Connect EOS trailer"); }
  if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) throw new DevinProtocolError("Invalid Devin Connect EOS trailer");
  if (trailer.error != null) {
    const { code = "unknown", message = "Unknown Devin upstream error" } = trailer.error;
    let status = DEVIN.trailerStatuses[code] || 502;
    if (code === "invalid_argument" && /internal error/i.test(message)) status = 502;
    if (code === "permission_denied" && /high demand/i.test(message)) status = 429;
    if (code === "failed_precondition" && /quota|credit|acu|exhausted|limit/i.test(message)) status = 429;
    throw new DevinProtocolError(`Devin upstream error (${code}): ${message}`, code, status);
  }
  return trailer;
}

const text = value => value.toString("utf8");
function parseTool(bytes) {
  const tool = {};
  for (const field of decodeProtobuf(bytes)) {
    if (field.wireType === 2) {
      const key = { 1: "id", 2: "name", 3: "arguments", 4: "invalidJson", 5: "invalidJsonError" }[field.number];
      if (key) {
        tool[key] = (tool[key] || "") + text(field.value);
        // Argument strings may split in the middle of a UTF-8 code point across
        // protobuf frames. Keep raw bytes for the per-call streaming decoder.
        if (key === "arguments" || key === "invalidJson") {
          const bytesKey = `${key}Bytes`;
          tool[bytesKey] = tool[bytesKey] ? Buffer.concat([tool[bytesKey], field.value]) : field.value;
        }
      }
    } else if (field.number === 6 && field.wireType === 0 && field.value !== 0n) {
      throw new DevinProtocolError("Devin custom tool calls are not supported", "unsupported_tool_type");
    }
  }
  return tool;
}
function parseUsage(bytes) {
  const usage = {};
  for (const field of decodeProtobuf(bytes)) {
    if (field.wireType === 0) {
      const key = { 2: "input", 3: "output", 4: "cacheWrite", 5: "cached", 6: "status" }[field.number];
      if (key) usage[key] = (usage[key] || 0) + protobufNumber(field.value);
    }
    if (field.number === 9 && field.wireType === 2) usage.model = text(field.value);
  }
  return usage;
}
function parseDimensionGroup(bytes) {
  const fields = decodeProtobuf(bytes);
  if (!fields.some(f => f.number === 1 && f.wireType === 2 && /^Token Usage$/i.test(text(f.value)))) return null;
  const usage = {};
  for (const field of fields.filter(f => f.number === 2 && f.wireType === 2)) {
    const metric = decodeProtobuf(field.value);
    const key = metric.find(f => f.number === 5 && f.wireType === 2);
    const data = metric.find(f => f.number === 4 && f.wireType === 2);
    if (!key || !data) continue;
    const value = decodeProtobuf(data.value).find(f => f.number === 2 && f.wireType === 5);
    const name = { input_tokens: "input", output_tokens: "output", cached_input_tokens: "cached" }[text(key.value)];
    if (name && value) {
      const number = value.value.readFloatLE();
      if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) throw new DevinProtocolError("Invalid Devin usage metric");
      usage[name] = Math.trunc(number);
    }
  }
  return usage;
}
export function parseDevinFrame(payload) {
  const result = { contentBytes: [], thinkingBytes: [], signatures: [], tools: [], usage: {}, dimensionUsage: {} };
  for (const field of decodeProtobuf(payload)) {
    const { number, wireType, value } = field;
    if (wireType === 0) {
      if (number === 5) result.stopReason = protobufNumber(value);
      if (number === 4) result.deltaTokens = protobufNumber(value);
    }
    if (wireType !== 2) continue;
    if (number === 1) result.outputId = text(value);
    if (number === 3) result.contentBytes.push(value);
    if (number === 6) result.tools.push(parseTool(value));
    if (number === 7) Object.assign(result.usage, parseUsage(value));
    if (number === 9) result.thinkingBytes.push(value);
    if (number === 10) result.signatures.push(value);
    if (number === 21) result.signatureType = text(value);
    if (number === 28) Object.assign(result.dimensionUsage, parseDimensionGroup(value));
  }
  result.contentBytes = Buffer.concat(result.contentBytes);
  result.thinkingBytes = Buffer.concat(result.thinkingBytes);
  result.signature = Buffer.concat(result.signatures);
  delete result.signatures;
  return result;
}
