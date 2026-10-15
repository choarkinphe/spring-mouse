import { CODEX_HOSTED_HISTORY as HISTORY } from "../config/codexHostedHistory.js";

// Restore schema for replay, never permission to perform another hosted search.
// Preserve the historical result, citations and encrypted content verbatim.
export function normalizeCodexHostedHistory(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const searchHistoryItems = input.reduce((count, item) =>
    count + (item?.type === HISTORY.searchItemType ? 1 : 0), 0);
  const searchDeclared = tools.some((tool) => HISTORY.searchToolTypes.includes(tool?.type));
  const noTools = body?.tools == null || (Array.isArray(body.tools) && tools.length === 0);
  const disabled = body?.tool_choice === HISTORY.disabledChoice;
  const defaultChoice = body?.tool_choice == null || body.tool_choice === HISTORY.defaultChoice;
  // Adding search to an active tool set would grant new authority; disabling all
  // tools would break function calls. Only repair turns that already allow none.
  const declarationRestored = searchHistoryItems > 0 && !searchDeclared
    && (disabled || (noTools && defaultChoice))
    && (body.tools == null || Array.isArray(body.tools));
  if (declarationRestored) {
    body.tools = [...tools, { type: HISTORY.searchToolType }];
    body.tool_choice = HISTORY.disabledChoice;
  }
  // Counts/booleans only. Never include content, tool names, URLs or ciphertext.
  return {
    inputItems: input.length,
    searchHistoryItems,
    toolCountBefore: tools.length,
    searchDeclaredBefore: searchDeclared,
    declarationRestored,
    toolsDisabled: disabled || declarationRestored,
  };
}
