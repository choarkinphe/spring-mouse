// Check if running in Node.js environment (has fs module)
const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
const ENV_LOGGING_DEFAULT = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOG_FILE_DUMPS === "true";
const LOGGING_SETTING_CACHE_MS = 1000;
const ACTIVE_MARKER_FILE = ".active.json";
const MARKER_TOUCH_INTERVAL_MS = 30_000;
const PROCESS_STARTED_AT = typeof process !== "undefined" && process.uptime
  ? Math.round(Date.now() - process.uptime() * 1000)
  : Date.now();

let fs = null;
let path = null;
let LOGS_DIR = null;
let loggingSettingCache = { value: null, expiresAt: 0 };

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    LOGS_DIR = path.join(typeof process !== "undefined" && process.cwd ? process.cwd() : ".", "logs");
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

async function isLoggingEnabled() {
  if (!isNode) return false;
  if (loggingSettingCache.expiresAt > Date.now()) return loggingSettingCache.value;

  let enabled = ENV_LOGGING_DEFAULT;
  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    if (typeof settings?.enableRequestLogFileDumps === "boolean") {
      enabled = settings.enableRequestLogFileDumps;
    }
  } catch {
    // Standalone open-sse consumers may not provide Spring Mouse's settings DB.
  }

  loggingSettingCache = { value: enabled, expiresAt: Date.now() + LOGGING_SETTING_CACHE_MS };
  return enabled;
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);
    
    fs.mkdirSync(sessionPath, { recursive: true });
    fs.writeFileSync(path.join(sessionPath, ACTIVE_MARKER_FILE), JSON.stringify({
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      createdAt: new Date().toISOString(),
    }));

    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return false;

  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Keep request logs useful without persisting credentials in plaintext.
function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  const masked = { ...headers };
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];

  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey))) {
      const value = String(masked[key] ?? "");
      masked[key] = value.length > 20 ? `${value.slice(0, 10)}...${value.slice(-5)}` : "***";
    }
  }
  return masked;
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {},
    close() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  if (!(await isLoggingEnabled())) return createNoOpLogger();

  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
  if (!sessionPath) return createNoOpLogger();

  let writable = true;
  let lastMarkerTouch = Date.now();
  const markerPath = path.join(sessionPath, ACTIVE_MARKER_FILE);

  const close = () => {
    if (!writable) return;
    writable = false;
    try { fs.unlinkSync(markerPath); } catch {}
  };

  const markActivity = () => {
    if (!writable || Date.now() - lastMarkerTouch < MARKER_TOUCH_INTERVAL_MS) return;
    lastMarkerTouch = Date.now();
    try {
      const now = new Date();
      fs.utimesSync(markerPath, now, now);
    } catch {
      close();
    }
  };

  const writeJson = (filename, data) => {
    if (!writable) return;
    markActivity();
    if (!writable) return;
    if (!writeJsonFile(sessionPath, filename, data)) close();
  };

  const append = (filename, chunk) => {
    if (!writable) return;
    markActivity();
    if (!writable) return;
    try {
      fs.appendFileSync(path.join(sessionPath, filename), chunk);
    } catch {
      // The directory may have been removed externally. Disable this logger
      // after the first failure so every streaming chunk does not throw again.
      close();
    }
  };

  return {
    get sessionPath() { return sessionPath; },

    logClientRawRequest(endpoint, body, headers = {}) {
      writeJson("1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body,
      });
    },

    logRawRequest(body, headers = {}) {
      writeJson("2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body,
      });
    },

    logOpenAIRequest(body) {
      writeJson("3_req_openai.json", { timestamp: new Date().toISOString(), body });
    },

    logTargetRequest(url, headers, body) {
      writeJson("4_req_target.json", {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body,
      });
    },

    logProviderResponse(status, statusText, headers, body) {
      writeJson("5_res_provider.json", {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: headers ? (typeof headers.entries === "function" ? Object.fromEntries(headers.entries()) : headers) : {},
        body,
      });
    },

    appendProviderChunk(chunk) {
      append("5_res_provider.txt", chunk);
    },

    appendOpenAIChunk(chunk) {
      append("6_res_openai.txt", chunk);
    },

    logConvertedResponse(body) {
      writeJson("7_res_client.json", { timestamp: new Date().toISOString(), body });
      close();
    },

    appendConvertedChunk(chunk) {
      append("7_res_client.txt", chunk);
    },

    logError(error, requestBody = null) {
      writeJson("6_error.json", {
        timestamp: new Date().toISOString(),
        error: error?.message || String(error),
        stack: error?.stack,
        requestBody,
      });
      close();
    },

    close,
  };
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url,
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody
    };
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
