import http from "node:http";
import { isAbsolute } from "node:path";

// Administrator-configured Unix socket only: credentials/DB rows cannot choose
// a host, executable, or endpoint. Tokens are never sent to the native helper.
export function readQoderSocketIdentity(region, { socket = process.env.QODER_IDENTITY_SOCKET } = {}) {
  if (!socket || !isAbsolute(socket) || !["global", "cn"].includes(region)) throw new Error("Qoder native identity socket is not configured");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(new Error("Qoder native identity unavailable")); else resolve(value);
    };
    const request = http.request({ socketPath: socket, path: "/identity", method: "POST",
      headers: { "Content-Type": "application/json" } }, response => {
      let raw = "";
      response.on("data", chunk => {
        raw += chunk.toString("utf8");
        if (raw.length > 32768) { finish(true); request.destroy(); }
      });
      response.once("end", () => {
        if (response.statusCode !== 200) { finish(true); return; }
        try {
          const identity = JSON.parse(raw).identity;
          const result = {};
          for (const [field, header] of [["machineToken", "Cosy-MachineToken"], ["machineType", "Cosy-MachineType"], ["machineCode", "Cosy-MachineCode"], ["machineId", "Cosy-MachineId"]]) {
            const value = identity?.[field];
            if (typeof value !== "string" || !value.trim() || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value)) throw new Error();
            result[header] = value;
          }
          finish(false, result);
        } catch { finish(true); }
      });
      response.once("error", () => finish(true));
    });
    const deadline = setTimeout(() => { finish(true); request.destroy(); }, 30000);
    request.once("error", () => finish(true));
    request.end(JSON.stringify({ region }));
  });
}
