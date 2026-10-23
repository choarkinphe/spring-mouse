import { CODEX_SSE_TOOL_OUTPUT_DONE_TYPES } from "../config/runtimeConfig.js";
import { RESPONSES_ITEM } from "../translator/schema/index.js";

// Some Codex turns send complete tool arguments without any delta events.
export function completedCodexToolText(chunk) {
  let text;
  switch (chunk?.type) {
    case CODEX_SSE_TOOL_OUTPUT_DONE_TYPES.FUNCTION_ARGUMENTS:
      text = chunk.arguments;
      break;
    case CODEX_SSE_TOOL_OUTPUT_DONE_TYPES.CUSTOM_INPUT:
      text = chunk.input;
      break;
    case CODEX_SSE_TOOL_OUTPUT_DONE_TYPES.ITEM:
      if (chunk.item?.type === RESPONSES_ITEM.FUNCTION_CALL) text = chunk.item.arguments;
      else if (chunk.item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) text = chunk.item.input;
      break;
  }
  return typeof text === "string" ? text : "";
}
