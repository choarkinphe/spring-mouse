import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const overview = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/UsageOverview.js", import.meta.url), "utf8");
const filter = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/UsageTimeFilter.js", import.meta.url), "utf8");

describe("cost dashboard drawer integration", () => {
  it("keeps the cost dashboard closed by default and opens from the filter action", () => {
    expect(overview).toContain("const [costsOpen, setCostsOpen] = useState(false)");
    expect(overview).toMatch(/actions=\{showBreakdowns[\s\S]*?onClick=\{\(\) => setCostsOpen\(true\)\}[\s\S]*?成本看板/);
    expect(filter).toContain("{actions && <div");
  });

  it("only mounts account accounting inside the open drawer and preserves scope", () => {
    expect(overview).toMatch(/<Drawer isOpen=\{costsOpen\}[\s\S]*?title="成本看板" width="3xl"[\s\S]*?\{costsOpen && <AccountCostsPanel timeRange=\{timeRange\} apiKeyId=\{apiKeyId\} \/>\}[\s\S]*?<\/Drawer>/);
    expect(overview.match(/<AccountCostsPanel /g)).toHaveLength(1);
    expect(overview).toContain("onClose={() => setCostsOpen(false)}");
  });

  it("lazy loads accounting instead of adding a report request to the main board", () => {
    expect(overview).toContain('dynamic(() => import("./components/AccountCostsPanel")');
    expect(overview).not.toContain('import AccountCostsPanel from');
  });
});
