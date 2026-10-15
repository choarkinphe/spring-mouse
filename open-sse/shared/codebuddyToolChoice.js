import { OPENAI_BLOCK, OPENAI_TOOL_CHOICE } from "../translator/schema/index.js";

// CodeBuddy's gateway decodes tool_choice as a string, rejecting OpenAI's
// named-function object with HTTP 400 / 11101. Requiring the sole selected tool
// preserves the caller's forced name instead of weakening it to "auto".
export function normalizeCodeBuddyToolChoice(body) {
  const choice = body?.tool_choice;
  if (choice?.type !== OPENAI_BLOCK.FUNCTION || !choice.function?.name || !Array.isArray(body.tools)) return body;
  const tools = body.tools.filter(tool => tool?.type === OPENAI_BLOCK.FUNCTION && tool.function?.name === choice.function.name);
  // Leave invalid/unknown names to validation rather than invoking another tool.
  if (tools.length === 0) return body;
  return { ...body, tools, tool_choice: OPENAI_TOOL_CHOICE.REQUIRED };
}
