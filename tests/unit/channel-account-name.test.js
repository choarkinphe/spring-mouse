import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Exercise the list's actual label resolver without mounting its dashboard dependencies.
const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/components/ChannelManagement.js", import.meta.url), "utf8");
const resolver = source.match(/function getConnectionName\(connection\) \{([\s\S]*?)\n\}/);
if (!resolver) throw new Error("ChannelManagement account name resolver not found");
const getConnectionName = new Function("connection", resolver[1]);

describe("channel account name", () => {
  it("shows the saved name rather than the upstream nickname", () => {
    expect(getConnectionName({ name: " 我的账号 ", displayName: "nick3376130998", email: "qoder-user-fixture" })).toBe("我的账号");
  });

  it("reflects a rename while upstream identity remains unchanged", () => {
    const connection = { name: "旧名称", displayName: "upstream-nickname" };
    expect(getConnectionName(connection)).toBe("旧名称");
    expect(getConnectionName({ ...connection, name: "新名称" })).toBe("新名称");
  });

  it.each([undefined, null, "", "   "])("falls back to upstream nickname for empty name %s", (name) => {
    expect(getConnectionName({ name, displayName: " 上游昵称 ", email: "account@example.com" })).toBe("上游昵称");
  });

  it("falls back to email then the unnamed label", () => {
    expect(getConnectionName({ name: " ", displayName: " ", email: " account@example.com " })).toBe("account@example.com");
    expect(getConnectionName({})).toBe("未命名配置");
  });
});
