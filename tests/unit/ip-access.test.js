import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateIpAccess,
  getTrustedClientIp,
  matchesIpRule,
  normalizeIpRules,
} from "@/lib/auth/ipAccess.js";

const originalPeerToken = process.env.SPRING_MOUSE_PEER_TOKEN;

afterEach(() => {
  if (originalPeerToken === undefined) delete process.env.SPRING_MOUSE_PEER_TOKEN;
  else process.env.SPRING_MOUSE_PEER_TOKEN = originalPeerToken;
});

describe("IP access rules", () => {
  it("matches IPv4 and IPv6 CIDR rules", () => {
    expect(matchesIpRule("203.0.113.17", "203.0.113.0/24")).toBe(true);
    expect(matchesIpRule("203.0.114.17", "203.0.113.0/24")).toBe(false);
    expect(matchesIpRule("2001:db8:4::12", "2001:db8::/32")).toBe(true);
    expect(matchesIpRule("2001:db9::12", "2001:db8::/32")).toBe(false);
  });

  it("normalizes, de-duplicates, and rejects malformed rules", () => {
    expect(normalizeIpRules([" 203.0.113.10 ", "203.0.113.10", "2001:DB8::/32"], "IP allowlist"))
      .toEqual(["203.0.113.10", "2001:db8::/32"]);
    expect(() => normalizeIpRules(["203.0.113.999"], "IP allowlist")).toThrow("Invalid IP allowlist entry");
    expect(() => normalizeIpRules("203.0.113.10", "IP allowlist")).toThrow("IP allowlist must be an array");
  });

  it("uses either allowlist or blocklist mode, never both", () => {
    const settings = {
      ipAccessEnabled: true,
      ipAllowlist: ["203.0.113.0/24"],
      ipBlocklist: ["203.0.113.17"],
    };
    expect(evaluateIpAccess("203.0.113.17", { ...settings, ipAccessMode: "allowlist" }))
      .toMatchObject({ allowed: true, reason: "allowed" });
    expect(evaluateIpAccess("198.51.100.1", { ...settings, ipAccessMode: "allowlist" }))
      .toMatchObject({ allowed: false, reason: "not-allowlisted" });
    expect(evaluateIpAccess("203.0.113.17", { ...settings, ipAccessMode: "blocklist" }))
      .toMatchObject({ allowed: false, reason: "blocklist" });
    expect(evaluateIpAccess("198.51.100.1", { ...settings, ipAccessMode: "blocklist" }))
      .toMatchObject({ allowed: true, reason: "allowed" });
    expect(evaluateIpAccess("198.51.100.1", { ...settings, ipAccessMode: "allowlist", ipAllowlist: [] }))
      .toMatchObject({ allowed: false, reason: "not-allowlisted" });
  });

  it("keeps loopback available and fails closed when no trustworthy IP is available", () => {
    const settings = { ipAccessEnabled: true, ipAllowlist: ["203.0.113.0/24"], ipBlocklist: [] };
    expect(evaluateIpAccess("127.0.0.1", settings)).toMatchObject({ allowed: true, reason: "loopback" });
    expect(evaluateIpAccess(null, settings)).toMatchObject({ allowed: false, reason: "unavailable" });
  });

  it("only accepts the client IP stamped by the custom server", () => {
    process.env.SPRING_MOUSE_PEER_TOKEN = "test-peer-token";
    const trustedRequest = {
      headers: new Headers({
        "x-9r-peer-token": "test-peer-token",
        "x-9r-real-ip": "203.0.113.20",
      }),
    };
    const spoofedRequest = {
      headers: new Headers({
        "x-9r-peer-token": "wrong-token",
        "x-9r-real-ip": "203.0.113.20",
      }),
    };

    expect(getTrustedClientIp(trustedRequest)).toBe("203.0.113.20");
    expect(getTrustedClientIp(spoofedRequest)).toBeNull();
  });
});
