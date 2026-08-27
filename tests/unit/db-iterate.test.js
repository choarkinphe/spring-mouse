import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

const tempFiles = [];
const adapters = [];

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-mouse-${name}-`));
  tempFiles.push(dir);
  return path.join(dir, "data.sqlite");
}

async function expectLazyIteration(createAdapter, name) {
  const db = await createAdapter(tempDbPath(name));
  adapters.push(db);
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO items(value) VALUES(?)", ["first"]);
  db.run("INSERT INTO items(value) VALUES(?)", ["second"]);

  const rows = db.iterate("SELECT id, value FROM items ORDER BY id");
  expect(Array.isArray(rows)).toBe(false);
  expect([...rows]).toEqual([
    { id: 1, value: "first" },
    { id: 2, value: "second" },
  ]);
}

afterEach(() => {
  while (adapters.length) adapters.pop().close();
  while (tempFiles.length) fs.rmSync(tempFiles.pop(), { recursive: true, force: true });
});

describe("SQLite adapter row iteration", () => {
  it("streams rows with node:sqlite", async () => {
    await expectLazyIteration(createNodeSqliteAdapter, "node-sqlite");
  });

  it("streams rows with sql.js", async () => {
    await expectLazyIteration(createSqlJsAdapter, "sqljs");
  });
});
