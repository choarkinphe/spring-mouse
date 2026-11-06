import http from "node:http";
import { generatePKCE, generateState } from "./pkce.js";
import devin, { DevinExchangeError } from "../providers/devin.js";
import { createProviderConnection } from "@/models";

// Match Magpie's ten-minute sign-in window; retain terminal diagnostics long
// enough for a user returning from an external browser to inspect the result.
export const DEVIN_SESSION_TTL_MS = 600_000;
const RESULT_TTL_MS = 600_000;
// Keep sessions stable across Next dev module reloads. Never serialize this map.
const key = Symbol.for("spring-mouse.devin-oauth-sessions");
const sessions = globalThis[key] ||= new Map();

export class DevinOAuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function stopListener(session) {
  session.server?.close();
  session.server?.closeIdleConnections?.();
  session.server = null;
}

function removeSession(id, session) {
  clearTimeout(session.timer);
  session.codeVerifier = null;
  session.abort.abort();
  stopListener(session);
  sessions.delete(id);
}

function getSession(id) {
  const session = typeof id === "string" ? sessions.get(id) : null;
  if (!session) throw new DevinOAuthError("Devin login session not found; restart authorization", 404);
  if (Date.now() >= session.expiresAt) {
    removeSession(id, session);
    throw new DevinOAuthError("Devin login session expired; restart authorization", 410);
  }
  return session;
}

function finishSession(id, session, status, error) {
  session.status = status;
  session.error = error;
  session.codeVerifier = null;
  stopListener(session);
  clearTimeout(session.timer);
  session.expiresAt = Date.now() + RESULT_TTL_MS;
  session.timer = setTimeout(() => removeSession(id, session), RESULT_TTL_MS);
  session.timer.unref?.();
}

function rejectCallback(id, session, message) {
  finishSession(id, session, "error", message);
  throw new DevinOAuthError(message);
}

function validateCode(code) {
  return typeof code === "string" && code.length > 0 && code.length <= 8192 && !/\s/.test(code);
}

// This runs both for loopback callbacks and manual-code submissions. Claim the
// session synchronously before the first await so a code can only be used once.
async function exchangeAndSave(id, session, code) {
  if (session.status !== "pending") throw new DevinOAuthError("Devin login session already consumed", 409);
  if (!validateCode(code)) rejectCallback(id, session, "Invalid Devin authorization code");
  session.status = "exchanging";
  const verifier = session.codeVerifier;
  session.codeVerifier = null;
  let stage = "token_exchange";
  try {
    const options = { signal: session.abort.signal };
    const tokens = await devin.exchangeToken(devin.config, code, session.redirectUri, verifier, session.state, options);
    stage = "account_status";
    const profile = await devin.postExchange(tokens, options);
    // Cancellation/expiry while a network request is in flight must not save.
    if (sessions.get(id) !== session || session.abort.signal.aborted) {
      throw new DevinOAuthError("Devin login cancelled or expired", 410);
    }
    getSession(id);
    stage = "save_connection";
    const connection = await createProviderConnection({
      provider: "devin",
      authType: "oauth",
      ...devin.mapTokens(tokens, profile),
      testStatus: "active",
    });
    if (sessions.get(id) === session) finishSession(id, session, "done");
    // Only non-secret connection identifiers ever leave this module.
    return { id: connection.id, provider: "devin" };
  } catch (error) {
    const stageMessage = {
      token_exchange: "Devin token exchange failed; restart authorization and try again",
      account_status: "Devin account validation failed; restart authorization and try again",
      save_connection: "Devin account could not be saved; retry authorization",
    };
    const message = error instanceof DevinOAuthError || error instanceof DevinExchangeError ? error.message : stageMessage[stage];
    console.warn(`[Devin OAuth] ${stage} failed (HTTP ${error.status || 502})`);
    if (sessions.get(id) === session) finishSession(id, session, "error", message);
    throw new DevinOAuthError(message, error instanceof DevinOAuthError || error instanceof DevinExchangeError ? error.status : 502);
  }
}

async function handleCallback(id, session, req, res) {
  let status = 200;
  let message = "Devin connected. You can close this window and return to Spring Mouse.";
  try {
    const expected = new URL(session.redirectUri);
    if (req.method !== "GET") throw new DevinOAuthError("Method not allowed", 405);
    if (req.headers.host !== expected.host || (req.headers.origin && req.headers.origin !== expected.origin)) {
      throw new DevinOAuthError("Cross-origin callback rejected", 403);
    }
    if (req.url.length > 16_384) throw new DevinOAuthError("Invalid callback", 400);
    const url = new URL(req.url, expected.origin);
    if (url.pathname !== "/callback") throw new DevinOAuthError("Not found", 404);
    getSession(id);
    if (session.status !== "pending") throw new DevinOAuthError("Devin login session already consumed", 409);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== session.state) {
      rejectCallback(id, session, "Devin callback state mismatch; restart authorization");
    }
    if (url.searchParams.has("error")) rejectCallback(id, session, "Devin authorization denied; restart authorization");
    if (url.searchParams.getAll("code").length !== 1) rejectCallback(id, session, "Invalid Devin authorization code");
    await exchangeAndSave(id, session, url.searchParams.get("code"));
  } catch (error) {
    status = error instanceof DevinOAuthError ? error.status : 500;
    // Only our own controlled errors are rendered; never callback input or raw
    // upstream diagnostics. Log stage/status without codes, state or credentials.
    console.warn(`[Devin OAuth] callback rejected (HTTP ${status}): ${error instanceof DevinOAuthError ? error.message : "internal error"}`);
    message = error instanceof DevinOAuthError ? error.message : "Devin authorization was not completed. Return to Spring Mouse and try again.";
  }
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><html><head><title>Devin authorization</title></head><body><p>${message}</p></body></html>`);
}

export async function beginDevinSession({ mode = "manual" } = {}) {
  if (!["local", "manual"].includes(mode)) throw new DevinOAuthError("Invalid Devin login mode");
  if (sessions.size >= 20) throw new DevinOAuthError("Too many pending Devin logins; wait or cancel an existing login", 429);
  const { codeVerifier, codeChallenge, state } = generatePKCE(48);
  const id = generateState();
  const session = {
    codeVerifier, state, status: "pending", mode, redirectUri: null,
    expiresAt: Date.now() + DEVIN_SESSION_TTL_MS,
    abort: new AbortController(), server: null, timer: null,
  };
  sessions.set(id, session);
  session.timer = setTimeout(() => removeSession(id, session), DEVIN_SESSION_TTL_MS);
  session.timer.unref?.();
  try {
    if (mode === "local") {
      const server = http.createServer((req, res) => { void handleCallback(id, session, req, res); });
      session.server = server;
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      // A cancelled begin request must not leave a listener behind.
      if (sessions.get(id) !== session) {
        stopListener(session);
        throw new DevinOAuthError("Devin login cancelled", 410);
      }
      session.redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      server.unref?.();
    }
    return {
      state: id, // opaque polling capability, NOT the upstream callback state
      authUrl: devin.buildAuthUrl(devin.config, session.redirectUri, state, codeChallenge),
      mode, expiresIn: DEVIN_SESSION_TTL_MS / 1000,
    };
  } catch {
    removeSession(id, session);
    throw new DevinOAuthError("Could not start Devin callback; use manual authorization", 503);
  }
}

export function pollDevinSession(id) {
  const session = getSession(id);
  const result = { status: session.status };
  if (session.status === "error") result.error = session.error;
  // Terminal statuses are single-consumption; all secrets are already erased.
  if (["done", "error"].includes(session.status)) removeSession(id, session);
  return result;
}

export async function completeDevinSession(id, input) {
  const session = getSession(id);
  if (session.status !== "pending") throw new DevinOAuthError("Devin login session already consumed", 409);
  if (session.mode !== "manual") throw new DevinOAuthError("Use the browser callback or restart in manual-code mode");
  const code = typeof input === "string" ? input.trim() : "";
  // Headless Devin shows a raw code; do not accept tokens or arbitrary URLs.
  if (code.includes("://") || code.includes("?")) rejectCallback(id, session, "Paste only the Devin authorization code");
  return exchangeAndSave(id, session, code);
}

export function cancelDevinSession(id) {
  const session = typeof id === "string" ? sessions.get(id) : null;
  if (session) removeSession(id, session);
}
