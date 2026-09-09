import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { transform } from "lightningcss";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Tailwind source isolation", () => {
  it("compiles source utilities without scanning malformed classes in generated files", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "spring-mouse-tailwind-"));
    const stylesheet = path.join(fixture, "src/app/globals.css");
    const source = await readFile(path.join(projectRoot, "src/app/globals.css"), "utf8");
    await mkdir(path.dirname(stylesheet), { recursive: true });
    await mkdir(path.join(fixture, "tmp/build"), { recursive: true });
    await symlink(path.join(projectRoot, "node_modules"), path.join(fixture, "node_modules"), "dir");
    await writeFile(stylesheet, source);
    await writeFile(path.join(fixture, "src/Card.js"), '<div className="flex shadow-[var(--shadow-soft)]" />');
    // Simulate a cache/output file containing the control character from the
    // reported build error. Only src/ should ever contribute utilities.
    await writeFile(path.join(fixture, "tmp/build/cache.txt"), `shadow-[var(--\u000esoft)] z-[9876]`);

    const result = await postcss([tailwindcss({ base: fixture, optimize: false })]).process(source, { from: stylesheet });
    expect(() => transform({ filename: stylesheet, code: Buffer.from(result.css) })).not.toThrow();
    expect(result.css.includes("--tw-shadow: var(--shadow-soft)")).toBe(true);
    expect(result.css.includes("z-index: 9876")).toBe(false);
    expect(result.css.includes("\u000e")).toBe(false);
  });
});
