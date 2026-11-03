import { FORMATS } from "../translator/formats.js";

// A route's sticky account is not ownership evidence for a server-side response
// or conversation. Reject before fallback until state has an account-bound map.
export function getResponsesStateError(body, sourceFormat) {
  if (body?.previous_response_id != null && body.previous_response_id !== "") {
    return "Server-side previous_response_id continuation is not supported by this gateway; send the complete conversation history in input instead.";
  }
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES && body?.input === undefined) return null;
  if (body?.conversation != null && body.conversation !== "") {
    return "Server-side conversation continuation is not supported by this gateway; send the complete conversation history in input instead.";
  }
  return null;
}
