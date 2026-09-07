import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

const tempDirs = [];
const adapters = [];

afterEach(() => {
  while (adapters.length > 0) adapters.pop().close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("sql.js custom model durability", () => {
  it("flushes a custom-model write before another adapter reopens the database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-"));
    const file = path.join(dir, "data.sqlite");
    tempDirs.push(dir);

    const writer = await createSqlJsAdapter(file);
    adapters.push(writer);
    writer.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))");
    writer.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)", [
      "customModels",
      "cx|manual-model|llm",
      JSON.stringify({ providerAlias: "cx", id: "manual-model", type: "llm" }),
    ]);
    writer.flush();

    const reader = await createSqlJsAdapter(file);
    adapters.push(reader);
    const row = reader.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [
      "customModels",
      "cx|manual-model|llm",
    ]);

    expect(JSON.parse(row.value)).toMatchObject({ providerAlias: "cx", id: "manual-model" });
  });
});
