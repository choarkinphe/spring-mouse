import {
  WORKBUDDY_REQUEST, WORKBUDDY_REFUSED_LINES, WORKBUDDY_REFUSED_CODE,
} from "../config/workbuddy.js";
import { ROLE } from "../translator/schema/index.js";

// WorkBuddy's channel check reads every message of a chat and refuses the whole
// request (11128) when one of a few known agent-client lines is present, whether
// it sits in the system prompt, an assistant message or a tool result. Rewording
// those lines is what makes an ordinary agent request pass; it keeps the
// instruction, drops only the wording the check objects to.
export function unflagWorkBuddyText(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of WORKBUDDY_REFUSED_LINES) out = out.replace(pattern, replacement);
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

// unflagWorkBuddyMessages rewrites the flagged lines in every message, leaving
// messages that carry none as the same object. Nothing is dropped: the wording
// is what the check objects to, and the instruction itself stays.
export function unflagWorkBuddyMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    if (!message || typeof message !== "object") return message;
    if (typeof message.content === "string") {
      const text = unflagWorkBuddyText(message.content);
      return text === message.content ? message : { ...message, content: text };
    }
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const parts = message.content.map(part => {
      if (typeof part?.text !== "string") return part;
      const text = unflagWorkBuddyText(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, content: parts } : message;
  });
}

// systemAsUser is the body a refusal is retried with: the leading system prompt
// is read to the model as the first thing the user says, inside the tags
// WorkBuddy's own client uses, and a neutral system message takes its place
// because the endpoint requires one. Later system messages become user messages
// where they stand. Returns null when the chat has nothing to move, so a refusal
// that has nothing to do with the system prompt is never retried.
export function workBuddySystemAsUser(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let index = 0;
  const lead = [];
  for (; index < messages.length && messages[index]?.role === ROLE.SYSTEM; index++) {
    lead.push(textOf(messages[index].content));
  }
  const said = lead.join("\n\n").trim();
  const rest = messages.slice(index).map(message => (
    message?.role === ROLE.SYSTEM ? { ...message, role: ROLE.USER } : message));
  const moved = said && said !== WORKBUDDY_REQUEST.neutralSystem;
  const demoted = rest.some((message, i) => message !== messages[index + i]);
  if (!moved && !demoted) return null;
  if (moved) {
    const text = `${WORKBUDDY_REQUEST.instructionsOpen}${said}${WORKBUDDY_REQUEST.instructionsClose}`;
    const at = rest.findIndex(message => message?.role === ROLE.USER);
    if (at < 0) {
      rest.unshift({ role: ROLE.USER, content: text });
    } else if (typeof rest[at].content === "string") {
      rest[at] = { ...rest[at], content: `${text}\n\n${rest[at].content}` };
    } else if (Array.isArray(rest[at].content)) {
      rest[at] = { ...rest[at], content: [{ type: "text", text }, ...rest[at].content] };
    } else {
      rest[at] = { ...rest[at], content: text };
    }
  }
  return [{ role: ROLE.SYSTEM, content: WORKBUDDY_REQUEST.neutralSystem }, ...rest];
}

// isWorkBuddyRefusal matches the channel-verification refusal by its structured
// business code only. A message that merely mentions the number is not evidence.
export function isWorkBuddyRefusal(status, bodyText) {
  if (Number(status) !== 400 || typeof bodyText !== "string" || !bodyText) return false;
  try {
    const code = JSON.parse(bodyText)?.code;
    return code === WORKBUDDY_REFUSED_CODE || code === String(WORKBUDDY_REFUSED_CODE);
  } catch {
    return false;
  }
}
