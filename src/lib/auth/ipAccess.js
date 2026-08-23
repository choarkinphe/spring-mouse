import { isIP } from "node:net";
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_RULES_PER_LIST = 100;

export function normalizeIp(value) {
  let ip = String(value || "").trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

function ipv4ToBigInt(ip) {
  return ip.split(".").reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip) {
  let value = ip;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = normalizeIp(value.slice(separator + 1));
    if (!ipv4 || isIP(ipv4) !== 4) return null;
    const packed = ipv4ToBigInt(ipv4);
    const high = ((packed >> 16n) & 0xffffn).toString(16);
    const low = (packed & 0xffffn).toString(16);
    value = `${value.slice(0, separator)}:${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n);
}

function ipToBigInt(ip) {
  return isIP(ip) === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
}

function parseRule(value) {
  const raw = String(value || "").trim();
  const parts = raw.split("/");
  if (parts.length > 2 || !parts[0]) return null;
  const ip = normalizeIp(parts[0]);
  if (!ip) return null;
  const family = isIP(ip);
  const bits = family === 4 ? 32 : 128;
  const prefix = parts.length === 1 ? bits : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits || (parts.length === 2 && String(prefix) !== parts[1])) return null;
  return { ip, prefix, bits, value: prefix === bits ? ip : `${ip}/${prefix}` };
}

export function normalizeIpRules(value, fieldName = "IP rules") {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  if (value.length > MAX_RULES_PER_LIST) throw new Error(`${fieldName} can contain at most ${MAX_RULES_PER_LIST} entries`);

  const rules = [];
  const seen = new Set();
  for (const candidate of value) {
    const rule = parseRule(candidate);
    if (!rule) throw new Error(`Invalid ${fieldName} entry: ${String(candidate)}`);
    if (!seen.has(rule.value)) {
      seen.add(rule.value);
      rules.push(rule.value);
    }
  }
  return rules;
}

export function matchesIpRule(ip, rule) {
  const candidate = normalizeIp(ip);
  const parsed = parseRule(rule);
  if (!candidate || !parsed || isIP(candidate) !== isIP(parsed.ip)) return false;
  const candidateValue = ipToBigInt(candidate);
  const networkValue = ipToBigInt(parsed.ip);
  if (candidateValue === null || networkValue === null) return false;
  if (parsed.prefix === 0) return true;
  const shift = BigInt(parsed.bits - parsed.prefix);
  return (candidateValue >> shift) === (networkValue >> shift);
}

export function isLoopbackIp(ip) {
  const normalized = normalizeIp(ip);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function getTrustedClientIp(request) {
  if (!hasTrustedPeerHeaders(request)) return null;
  return normalizeIp(request.headers.get("x-9r-real-ip"));
}

export function evaluateIpAccess(ip, settings = {}) {
  if (settings.ipAccessEnabled !== true) return { allowed: true, reason: "disabled" };
  if (!ip) return { allowed: false, reason: "unavailable" };
  if (isLoopbackIp(ip)) return { allowed: true, reason: "loopback" };

  if (settings.ipAccessMode === "blocklist") {
    const blocklist = Array.isArray(settings.ipBlocklist) ? settings.ipBlocklist : [];
    return blocklist.some((rule) => matchesIpRule(ip, rule))
      ? { allowed: false, reason: "blocklist" }
      : { allowed: true, reason: "allowed" };
  }

  const allowlist = Array.isArray(settings.ipAllowlist) ? settings.ipAllowlist : [];
  return allowlist.some((rule) => matchesIpRule(ip, rule))
    ? { allowed: true, reason: "allowed" }
    : { allowed: false, reason: "not-allowlisted" };
}
