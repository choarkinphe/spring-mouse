// Adapted from magpie-community/plugins packages/devin/index.mjs,
// pinned 749e9dd12a5401cc11a701b7598c7ce32fcd7259. MIT License.
// Copyright (c) 2026 magpie-community contributors
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { randomUUID } from "node:crypto";
import { DEVIN } from "../../config/devin.js";
import { ROLE } from "../../translator/schema/roles.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK, OPENAI_TOOL_CHOICE } from "../../translator/schema/blocks.js";
import { encodeBytesField as b, encodeVarintField as v, encodeDoubleField as d } from "./protobuf.js";
import { buildDevinClientMetadata, DevinProtocolError } from "./protocol.js";

const join = (...parts) => parts.filter(Boolean).join("\n\n");
const marked = part => !!part?.cache_control && typeof part.cache_control === "object";
const isClaude = uid => /claude|MODEL_PRIVATE_[23]/i.test(uid);
const sigTypes = new Map();
export function rememberDevinSignatureType(signature, type) {
  if (!signature || !type) return;
  sigTypes.delete(signature); sigTypes.set(signature, type);
  if (sigTypes.size > 512) sigTypes.delete(sigTypes.keys().next().value);
}
export function encodeDevinToolId(id) {
  return DEVIN.safeToolId.test(id) && !id.startsWith(DEVIN.toolIdPrefix) ? id : DEVIN.toolIdPrefix + Buffer.from(id).toString("base64url");
}
export function decodeDevinToolId(id) {
  if (typeof id !== "string" || !id.startsWith(DEVIN.toolIdPrefix) || !DEVIN.safeToolId.test(id)) return id;
  const raw = Buffer.from(id.slice(DEVIN.toolIdPrefix.length), "base64url").toString();
  return raw && encodeDevinToolId(raw) === id ? raw : id;
}
function invalid(message) { throw new DevinProtocolError(message, "invalid_request", 400); }
function objectRoot(schema, root = schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) return schema;
  if (schema.type === "object" && !("anyOf" in schema) && !("oneOf" in schema) && !("allOf" in schema)) return schema;
  const output = { ...schema, type: "object" };
  const properties = { ...(schema.properties || {}) };
  let required = [...(Array.isArray(schema.required) ? schema.required : [])];
  const resolve = branch => {
    if (!branch || typeof branch !== "object") return null;
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(branch.$ref || "");
    return match ? root?.$defs?.[match[1]] || root?.definitions?.[match[1]] || null : branch;
  };
  for (const branch of schema.allOf || []) {
    const value = resolve(branch);
    if (value?.properties) for (const [key, prop] of Object.entries(value.properties)) properties[key] ??= prop;
    if (Array.isArray(value?.required)) required.push(...value.required);
  }
  const alternatives = [ ...(schema.anyOf || []), ...(schema.oneOf || []) ].map(resolve).filter(Boolean).map(branch => ["anyOf", "oneOf", "allOf"].some(key => key in branch) ? objectRoot(branch, root, depth + 1) : branch).filter(branch => branch.type === "object" || branch.properties);
  const common = alternatives.length ? (alternatives[0].required || []).filter(name => alternatives.every(branch => (branch.required || []).includes(name))) : [];
  required.push(...common);
  const alternativeProperties = new Map();
  for (const branch of alternatives) for (const [key, prop] of Object.entries(branch.properties || {})) {
    if (key in properties) continue;
    const values = alternativeProperties.get(key) || [];
    if (!values.some(value => JSON.stringify(value) === JSON.stringify(prop))) values.push(prop);
    alternativeProperties.set(key, values);
  }
  for (const [key, values] of alternativeProperties) properties[key] = values.length === 1 ? values[0] : { anyOf: values };
  output.properties = properties;
  if (required.length) output.required = [...new Set(required)]; else delete output.required;
  delete output.anyOf; delete output.oneOf; delete output.allOf;
  return output;
}
function geminiSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 32) return schema;
  const out = { ...schema };
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) if (out[key] && typeof out[key] === "object") out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, value]) => [name, geminiSchema(value, depth + 1)]));
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) if (Array.isArray(out[key])) out[key] = out[key].map(value => geminiSchema(value, depth + 1));
  for (const key of ["additionalProperties", "not", "if", "then", "else", "contains"]) if (out[key] && typeof out[key] === "object") out[key] = geminiSchema(out[key], depth + 1);
  if (Array.isArray(out.type)) {
    const types = [...new Set(out.type.filter(type => typeof type === "string"))];
    const nonNull = types.filter(type => type !== "null");
    if (nonNull.length < types.length && nonNull.length) out.nullable = true;
    if (nonNull.length === 1) out.type = nonNull[0];
    else if (nonNull.length > 1) { delete out.type; out.anyOf = [...(out.anyOf || []), ...nonNull.map(type => ({ type, ...(type === "array" ? { items: {} } : {}) }))]; }
    else delete out.type;
  }
  if (depth > 0 && out.type && Array.isArray(out.anyOf)) {
    const union = out.anyOf.filter(value => value?.type !== "null");
    if (union.length < out.anyOf.length) out.nullable = true;
    delete out.anyOf;
    if (union.length === 1 && (!union[0].type || union[0].type === out.type)) {
      for (const [key, value] of Object.entries(union[0])) if (!(key in out)) out[key] = value;
    } else if (union.length) {
      if (!Array.isArray(out.oneOf)) out.oneOf = union;
      else out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), { oneOf: union }];
    }
  }
  if (!out.type && Array.isArray(out.enum)) {
    const values = out.enum.filter(value => value !== null);
    if (values.length < out.enum.length) out.nullable = true;
    const kinds = new Set(values.map(value => Number.isInteger(value) ? "integer" : typeof value));
    const type = kinds.size === 1 ? [...kinds][0] : kinds.size === 2 && kinds.has("integer") && kinds.has("number") ? "number" : "";
    if (["string", "integer", "number", "boolean"].includes(type)) { out.type = type; out.enum = values; } else delete out.enum;
  }
  if (!out.type && out.properties) out.type = "object";
  if (out.type === "array" || (!out.type && "items" in out)) { out.type = "array"; out.items = Array.isArray(out.items) ? (out.items.length === 1 ? geminiSchema(out.items[0], depth + 1) : {}) : out.items && typeof out.items === "object" ? geminiSchema(out.items, depth + 1) : {}; }
  return out;
}
export function resolveDevinModelUid(model, body = {}) {
  return String(model || body.model || DEVIN.defaultModel).replace(/^devin\//i, "").trim();
}
const textOf = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p?.type === OPENAI_BLOCK.TEXT).map(p => p.text || "").filter(Boolean).join("\n\n") : "";
const reasoningOf = message => typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
function argsOf(args) {
  if (args && typeof args === "object") return JSON.stringify(args);
  try { const value = JSON.parse(args || "{}"); return JSON.stringify(value && typeof value === "object" ? value : {}); }
  catch { return "{}"; }
}
function inlineImage(part) {
  if (part?.type === OPENAI_BLOCK.IMAGE_URL) {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const match = typeof url === "string" && /^data:([^,]*),(.*)$/s.exec(url);
    return match && match[2] ? { data: match[2], type: match[1].replace(/;base64$/, "") || "image/png" } : null;
  }
  if (part?.type === CLAUDE_BLOCK.IMAGE && part.source?.type === "base64" && part.source.data) return { data: part.source.data, type: part.source.media_type || "image/png" };
  const inline = part?.inlineData || part?.inline_data;
  return inline?.data ? { data: inline.data, type: inline.mimeType || inline.mime_type || "image/png" } : null;
}
function formatInstruction(format) {
  if (format?.type === "json_object") return DEVIN.jsonObjectInstruction;
  if (format?.type !== "json_schema") return "";
  const schema = format.json_schema ? format.json_schema.schema : format.schema;
  return schema == null ? DEVIN.jsonObjectInstruction : DEVIN.jsonSchemaInstruction + JSON.stringify(schema) + ".";
}
function toolsFor(tools, uid, native = false) {
  let result = (tools || []).filter(tool => native ? tool.name : (!tool.type || tool.type === OPENAI_BLOCK.FUNCTION) && tool.function?.name).map(tool => {
    const definition = native ? tool : tool.function;
    let schema = objectRoot(native ? definition.input_schema : definition.parameters);
    if (/gemini/i.test(uid)) schema = geminiSchema(schema);
    return { name: definition.name, description: definition.description || "", schema };
  });
  if (result.length > DEVIN.maxToolCalls) invalid("Too many Devin tool definitions");
  return result;
}
const descriptions = tools => {
  const described = tools.filter(tool => tool.description);
  return described.length ? "<tool_descriptions>\n" + described.map(tool => `<tool name="${tool.name}">\n${tool.description.trim()}\n</tool>\n`).join("") + "</tool_descriptions>" : "";
};
function toolInstructions(choice, parallel) {
  const result = [];
  // GetChatMessage has no native enforcement field. As with structured output,
  // these constraints are instructions, never claimed as strict wire guarantees.
  if (choice === OPENAI_TOOL_CHOICE.REQUIRED || choice?.type === "any") result.push("You must call at least one of the provided tools before responding.");
  const name = choice?.function?.name || (choice?.type === "tool" ? choice.name : "");
  if (name) result.push(`You must call the provided tool ${JSON.stringify(name)} before responding. Do not call other tools.`);
  if (parallel === false || choice?.disable_parallel_tool_use === true) result.push("Call at most one tool at a time. Wait for its result before making another tool call.");
  return result.join("\n");
}
function encodeRequest(prompts, tools, body, uid, sessionToken, deviceSeed) {
  const max = body.max_completion_tokens || body.max_tokens || DEVIN.defaultMaxTokens;
  if (!Number.isSafeInteger(max) || max < 1) invalid("Invalid Devin max tokens");
  const sampling = value => value === 0 ? DEVIN.minimumSampling : value;
  const temperature = body.temperature ?? DEVIN.completion.temperature;
  const topP = body.top_p ?? 0.95;
  if (!Number.isFinite(temperature) || temperature < 0 || !Number.isFinite(topP) || topP < 0 || topP > 1) invalid("Invalid Devin sampling");
  const fields = [b(1, buildDevinClientMetadata({ sessionToken, deviceSeed }))];
  for (const prompt of prompts) {
    const part = [b(1, randomUUID()), v(2, prompt.role)];
    if (prompt.text) part.push(b(3, prompt.text));
    for (const call of prompt.calls || []) part.push(b(6, Buffer.concat([b(1, call.id || ""), b(2, call.name || ""), b(3, call.args)])));
    if (prompt.callId) part.push(b(7, prompt.callId));
    if (prompt.cache) part.push(b(8, v(1, 1)));
    for (const image of prompt.images || []) part.push(b(10, Buffer.concat([b(1, image.data), b(2, image.type)])));
    if (prompt.thinking?.text) part.push(b(11, prompt.thinking.text));
    if (prompt.thinking?.signature) {
      part.push(b(12, prompt.thinking.signature));
      if (prompt.thinking.type) part.push(b(18, prompt.thinking.type));
    }
    fields.push(b(3, Buffer.concat(part)));
  }
  fields.push(v(7, 5), b(8, Buffer.concat([v(1, 1), v(2, max), v(3, 400), d(5, sampling(temperature)), v(7, 40), d(8, sampling(topP))])));
  const offered = new Set();
  const add = tool => {
    offered.add(tool.name);
    const description = tool.description ? `Described under <tool name="${tool.name}"> in <tool_descriptions>, in the instructions.` : tool.name;
    fields.push(b(10, Buffer.concat([b(1, tool.name), b(2, description), b(3, JSON.stringify(tool.schema && typeof tool.schema === "object" ? tool.schema : { type: "object", properties: {} }))])));
  };
  tools.forEach(add);
  for (const prompt of prompts) for (const call of prompt.calls || []) if (!offered.has(call.name)) add({ name: call.name });
  fields.push(b(21, uid));
  const wire = Buffer.concat(fields);
  if (wire.length > DEVIN.maxFrameBytes) invalid("Devin request exceeds Connect frame size limit");
  return wire;
}
function joinSplitCalls(messages) {
  const result = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (message.role === ROLE.ASSISTANT && previous?.role === ROLE.ASSISTANT && previous.tool_calls?.length) {
      result[result.length - 1] = { ...previous, content: join(textOf(previous.content), textOf(message.content)), reasoning_content: join(reasoningOf(previous), reasoningOf(message)), tool_calls: [...previous.tool_calls, ...(message.tool_calls || [])] };
    } else result.push(message);
  }
  return result;
}

export function buildDevinChatRequest({ model, body, sessionToken, deviceSeed = "" }) {
  if (body?._devinNative) return buildDevinMessagesRequest({ model, body: body._devinNative, sessionToken, deviceSeed });
  if (!body || !Array.isArray(body.messages)) invalid("Devin requires a messages array");
  const uid = resolveDevinModelUid(model, body);
  const prompts = [];
  const system = [];
  const results = new Map();
  let pending = [];
  const answer = () => { for (const call of pending) prompts.push({ role: DEVIN.source.tool, callId: call.id, text: DEVIN.noResult }); pending = []; };
  const settle = () => { for (const result of results.values()) { if (result.count && result.seen === result.count) result.prompt.text = result.text; result.prompt.text ||= "(no output)"; } results.clear(); };
  for (const message of joinSplitCalls(body.messages)) {
    if ([ROLE.SYSTEM, ROLE.DEVELOPER].includes(message.role)) { system.push(textOf(message.content)); continue; }
    if (message.role !== ROLE.TOOL && message.role !== ROLE.USER) settle();
    if (message.role === ROLE.ASSISTANT) {
      const calls = (message.tool_calls || []).map(call => ({ id: decodeDevinToolId(call.id), name: call.function?.name, args: argsOf(call.function?.arguments) }));
      const text = textOf(message.content);
      if (!text && !calls.length) continue;
      answer();
      const reasoning = reasoningOf(message);
      let thinking;
      if (!isClaude(uid) && reasoning) thinking = { text: reasoning };
      else if (isClaude(uid) && message.reasoning_signature) thinking = { text: reasoning, signature: message.reasoning_signature, type: message.reasoning_signature_type || sigTypes.get(message.reasoning_signature) || "anthropic" };
      prompts.push({ role: DEVIN.source.assistant, text, calls, thinking, cache: marked(message) });
      pending = [...calls];
      continue;
    }
    if (message.role === ROLE.TOOL) {
      const id = decodeDevinToolId(message.tool_call_id);
      const index = pending.findIndex(call => call.id === id);
      if (index < 0) continue;
      const prompt = { role: DEVIN.source.tool, callId: id, text: textOf(message.content), images: Array.isArray(message.content) ? message.content.map(inlineImage).filter(Boolean) : [], cache: marked(message) };
      const note = DEVIN.toolImageNote.exec(prompt.text);
      results.set(message.tool_call_id, { prompt, count: note ? Number(note[2] || 1) : 0, text: note ? prompt.text.slice(0, note.index) : prompt.text, seen: 0 });
      prompts.push(prompt); pending.splice(index, 1);
      continue;
    }
    if (message.role !== ROLE.USER) continue;
    const texts = [];
    const images = [];
    let target = null;
    if (typeof message.content === "string") texts.push(message.content);
    else for (const part of message.content || []) {
      if (part.type === OPENAI_BLOCK.TEXT) {
        target = null;
        if (part.text?.startsWith(DEVIN.toolImageFrom)) for (const [id, result] of results) {
          if (result.seen < result.count && (part.text === `${DEVIN.toolImageFrom}tool call ${id}:]` || part.text.endsWith(` (tool call ${id}):]`))) { target = result; break; }
        }
        if (!target && part.text) texts.push(part.text);
      } else {
        const image = inlineImage(part);
        if (target) { if (image) target.prompt.images.push(image); if (++target.seen === target.count) target = null; }
        else if (image) images.push(image);
      }
    }
    settle();
    const text = join(...texts);
    if (!text && !images.length) continue;
    answer(); prompts.push({ role: DEVIN.source.user, text, images, cache: marked(message) || (Array.isArray(message.content) && message.content.some(marked)) });
  }
  settle(); answer();
  system.push(formatInstruction(body.response_format), toolInstructions(body.tool_choice, body.parallel_tool_calls));
  let tools = toolsFor(body.tools, uid);
  if (body.tool_choice === OPENAI_TOOL_CHOICE.NONE) tools = [];
  const instructions = join(join(...system), descriptions(tools));
  if (!prompts.length || (prompts.at(-1).role === DEVIN.source.assistant && !prompts.at(-1).calls?.length)) prompts.push({ role: DEVIN.source.user, text: "Please proceed with the task." });
  if (instructions) {
    let index = prompts.findIndex(prompt => prompt.role === DEVIN.source.user);
    if (index < 0) { prompts.unshift({ role: DEVIN.source.user, text: "" }); index = 0; }
    prompts[index].text = join(instructions, prompts[index].text);
  }
  return encodeRequest(prompts, tools, body, uid, sessionToken, deviceSeed);
}

export function buildDevinMessagesRequest({ model, body, sessionToken, deviceSeed = "" }) {
  const uid = resolveDevinModelUid(model, body);
  const prompts = [];
  let pending = [];
  const notices = [];
  const answer = () => { for (const call of pending) prompts.push({ role: DEVIN.source.tool, callId: call.id, text: DEVIN.noResult }); pending = []; prompts.push(...notices.splice(0)); };
  const turns = [];
  for (const message of body.messages || []) {
    const blocks = typeof message.content === "string" ? [{ type: CLAUDE_BLOCK.TEXT, text: message.content }] : message.content || [];
    if (turns.at(-1)?.role === message.role) turns.at(-1).blocks.push(...blocks);
    else turns.push({ role: message.role, blocks: [...blocks] });
  }
  for (const turn of turns) {
    if (turn.role === ROLE.ASSISTANT) {
      const own = [];
      const calls = [];
      let thought;
      let cache = false;
      const take = prompt => { if (thought) { prompt.thinking = thought; thought = null; } return prompt; };
      for (const block of turn.blocks) {
        if (block.type === CLAUDE_BLOCK.THINKING) {
          if (thought) own.push(take({ role: DEVIN.source.assistant, text: "" }));
          if (!isClaude(uid)) thought = block.thinking ? { text: block.thinking } : null;
          else if (block.signature) thought = { text: block.thinking || "", signature: block.signature, type: sigTypes.get(block.signature) || "anthropic" };
        } else if (block.type === CLAUDE_BLOCK.TEXT) {
          if (block.text) own.push(take({ role: DEVIN.source.assistant, text: block.text, cache: marked(block) }));
          else if (marked(block) && own.length) own.at(-1).cache = true;
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) { calls.push({ id: decodeDevinToolId(block.id), name: block.name, args: JSON.stringify(block.input || {}) }); cache ||= marked(block); }
      }
      if (calls.length) { if (!own.length || (thought && own.at(-1).thinking)) own.push({ role: DEVIN.source.assistant, text: "" }); take(own.at(-1)); own.at(-1).calls = calls; own.at(-1).cache ||= cache; }
      else if (thought && own.length && !own.at(-1).thinking) take(own.at(-1));
      if (own.length) { answer(); prompts.push(...own); pending = [...calls]; }
      continue;
    }
    let held = [];
    let words;
    for (const block of turn.blocks) {
      if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
        const id = decodeDevinToolId(block.tool_use_id);
        const index = pending.findIndex(call => call.id === id);
        if (index < 0) continue;
        const inner = typeof block.content === "string" ? [{ type: OPENAI_BLOCK.TEXT, text: block.content }] : block.content || [];
        const text = textOf(inner) || "(no output)";
        prompts.push({ role: DEVIN.source.tool, callId: id, text: block.is_error ? `Error: ${text}` : text, images: inner.map(inlineImage).filter(Boolean), cache: marked(block) || marked(inner.at(-1)) });
        pending.splice(index, 1); if (!pending.length) answer();
      } else if (block.type === CLAUDE_BLOCK.TEXT) {
        if (!block.text) { if (marked(block) && words) words.cache = true; continue; }
        if (turn.role !== ROLE.SYSTEM) answer();
        words = { role: DEVIN.source.user, text: block.text, images: held, cache: marked(block) }; held = [];
        if (turn.role === ROLE.SYSTEM && pending.length) notices.push(words); else prompts.push(words);
      } else {
        const image = inlineImage(block);
        if (image) { if (words) { words.images.push(image); words.cache ||= marked(block); } else held.push(image); }
      }
    }
    if (held.length) { answer(); prompts.push({ role: DEVIN.source.user, images: held }); }
  }
  answer();
  if (!prompts.length || (prompts.at(-1).role === DEVIN.source.assistant && !prompts.at(-1).calls?.length)) prompts.push({ role: DEVIN.source.user, text: "Please proceed with the task." });
  let tools = toolsFor(body.tools, uid, true);
  if (body.tool_choice?.type === "none") tools = [];
  const system = [];
  const described = descriptions(tools); if (described) system.push({ role: DEVIN.source.user, text: described });
  for (const block of typeof body.system === "string" ? [{ text: body.system }] : body.system || []) if (block.text) system.push({ role: DEVIN.source.user, text: block.text, cache: marked(block) });
  const instruction = join(body.output_config?.format ? formatInstruction({ type: "json_schema", schema: body.output_config.format.schema }) : "", toolInstructions(body.tool_choice, body.parallel_tool_calls));
  if (instruction) system.push({ role: DEVIN.source.user, text: instruction });
  const first = prompts.findIndex(prompt => prompt.role === DEVIN.source.user);
  prompts.splice(first < 0 ? 0 : first, 0, ...system);
  return encodeRequest(prompts, tools, body, uid, sessionToken, deviceSeed);
}
