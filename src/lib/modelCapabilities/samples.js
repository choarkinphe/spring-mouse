import { randomBytes, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROLE, OPENAI_BLOCK } from "open-sse/translator/schema/index.js";
import { FORMATS } from "open-sse/translator/formats.js";

const COLORS = [
  { name: "red", rgb: [240, 20, 20] },
  { name: "blue", rgb: [20, 40, 240] },
  { name: "green", rgb: [20, 180, 20] },
  { name: "yellow", rgb: [240, 220, 20] },
];
export const probeNonce = () => randomBytes(6).toString("hex");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
export function makeImageSample() {
  const first = randomInt(COLORS.length);
  const second = (first + 1 + randomInt(COLORS.length - 1)) % COLORS.length;
  const colors = [COLORS[first], COLORS[second]];
  const width = 128, height = 64;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    colors[x < width / 2 ? 0 : 1].rgb.forEach((byte, index) => { pixels[offset + index] = byte; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
  return { data: image.toString("base64"), expected: colors.map((color) => color.name) };
}

export function makePdfSample(nonce) {
  const stream = `BT /F1 24 Tf 40 100 Td (Document code: ${nonce}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

export function makeContextSample(targetTokens) {
  const expected = [probeNonce(), probeNonce(), probeNonce()];
  const bytes = Math.max(64, Math.floor(targetTokens * 1.3));
  const padding = randomBytes(bytes).toString("hex");
  const half = Math.floor(padding.length / 2);
  const text = `BEGIN_CODE=${expected[0]}\n${padding.slice(0, half)}\nMIDDLE_CODE=${expected[1]}\n${padding.slice(half)}\nEND_CODE=${expected[2]}\nReturn the three codes BEGIN_CODE, MIDDLE_CODE, END_CODE in order, separated by commas.`;
  // Random hex is intentionally less compressible than repeated filler. This is
  // an estimate only; upstream usage calibrates the next step when available.
  return { text, expected, estimatedInputTokens: Math.ceil(text.length / 2) };
}

export async function makeCapabilityProbe(key, { contextTokens = 4096 } = {}) {
  const nonce = probeNonce();
  const base = { sourceFormat: FORMATS.OPENAI, body: { stream: false, messages: [{ role: ROLE.USER, content: `Reply with exactly ${nonce}` }] }, expected: [nonce] };
  const content = (prompt, block) => [{ type: OPENAI_BLOCK.TEXT, text: prompt }, block];
  if (key === "tools") {
    base.body.messages[0].content = `Call capability_echo with code ${nonce}. Do not answer in plain text.`;
    base.body.tools = [{ type: OPENAI_BLOCK.FUNCTION, function: { name: "capability_echo", description: "Echo the supplied code", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } } }];
    base.body.tool_choice = { type: OPENAI_BLOCK.FUNCTION, function: { name: "capability_echo" } };
  } else if (key === "vision") {
    const sample = makeImageSample();
    base.expected = sample.expected;
    base.marker = sample.data.slice(0, 32);
    base.body.messages[0].content = content("Name the solid colors on the left and right, in that order. Reply with two English color words separated by a comma.", { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: `data:image/png;base64,${sample.data}` } });
  } else if (key === "pdf") {
    const data = makePdfSample(nonce);
    base.marker = data.slice(0, 32);
    base.body.messages[0].content = content("Return only the document code printed in this PDF.", { type: OPENAI_BLOCK.FILE, file: { filename: "capability.pdf", file_data: `data:application/pdf;base64,${data}` } });
  } else if (key === "contextWindow") {
    const sample = makeContextSample(contextTokens);
    base.expected = sample.expected;
    base.estimatedInputTokens = sample.estimatedInputTokens;
    base.body.messages[0].content = sample.text;
    base.marker = sample.expected[1];
  } else if (key === "audioInput" || key === "videoInput") {
    const audio = key === "audioInput";
    const data = (await readFile(path.join(process.cwd(), "src/lib/modelCapabilities/fixtures", audio ? "speech.wav" : "sequence.mp4"))).toString("base64");
    base.expected = audio ? ["violet", "lantern", "seven"] : ["red", "blue", "green"];
    base.marker = data.slice(0, 32);
    base.sourceFormat = FORMATS.GEMINI;
    base.body = { stream: false, contents: [{ role: "user", parts: [
      { text: audio ? "Transcribe the secret words spoken in this recording. Reply in English." : "List the three full-screen colors in this video in chronological order, in English." },
      { inlineData: { mimeType: audio ? "audio/wav" : "video/mp4", data } },
    ] }] };
  } else if (key === "reasoning") {
    base.body.messages[0].content = "Compute 173 times 287 and briefly explain your approach.";
    base.body.reasoning_effort = "low";
    base.expected = [];
  } else if (key === "structuredOutput") {
    base.body.messages[0].content = `Return a JSON object with exactly one property code equal to ${nonce}.`;
    base.body.response_format = { type: "json_schema", json_schema: { name: "capability_echo", strict: true, schema: { type: "object", properties: { code: { type: "string", enum: [nonce] } }, required: ["code"], additionalProperties: false } } };
  }
  return base;
}
