// Responses tool-call identifiers are independent of server-generated item IDs.
export const RESPONSES_CALL_ID = Object.freeze({
  maxLength: 64,
  replacementPrefix: "call_sm_",
});
