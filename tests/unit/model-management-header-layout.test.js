import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const source = fs.readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ProviderDetailClient.js", import.meta.url), "utf8");
const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
const elements = [];
const parents = new Map();
function visit(node, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXElement") {
    elements.push(node);
    parents.set(node, parent);
    parent = node;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, parent));
    else if (value && typeof value === "object") visit(value, parent);
  }
}
visit(ast);
const attr = (node, name) => node.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name)?.value;
const byTestId = (id) => elements.find((node) => attr(node, "data-testid")?.value === id);
const classes = (node) => attr(node, "className")?.value || "";
const header = byTestId("model-management-header");
const identity = byTestId("model-management-identity");
const actions = byTestId("model-management-actions");
const status = byTestId("model-management-directory-status");

// The status copy must not compete with channel identity inside the flex row.
describe("model management header layout", () => {
  it("places directory status outside the identity/action flex row", () => {
    expect(header).toBeDefined();
    expect(status).toBeDefined();
    expect(parents.get(status)).toBe(parents.get(header));
    expect(status.start).toBeGreaterThan(header.end);
    expect(parents.get(identity)).toBe(header);
    expect(parents.get(actions)).toBe(header);
  });

  it("allows whole regions to wrap instead of squeezing the title to single characters", () => {
    expect(classes(header)).toContain("flex-wrap");
    expect(classes(identity)).toContain("flex-[1_1_24rem]");
    expect(classes(identity)).toContain("min-w-0");
    expect(classes(actions)).toContain("flex-wrap");
    expect(classes(actions)).toContain("max-w-full");
    expect(classes(actions).split(" ")).not.toContain("shrink-0");
  });

  it("keeps the credential link and connection counts from wrapping character by character", () => {
    const links = elements.filter((node) => node.openingElement.name.name === "a" && node.start > identity.start && node.end < identity.end);
    expect(links.some((node) => classes(node).includes("whitespace-nowrap"))).toBe(true);
    const counts = elements.find((node) => node.openingElement.name.name === "p" && source.slice(node.start, node.end).includes("connections.length"));
    expect(classes(counts)).toContain("whitespace-nowrap");
  });

  it("constrains the multi-account selector to its available width", () => {
    const selector = elements.find((node) => attr(node, "aria-label")?.value === "模型目录连接");
    expect(classes(selector)).toContain("max-w-full");
    expect(classes(selector)).toContain("min-w-0");
  });
});
