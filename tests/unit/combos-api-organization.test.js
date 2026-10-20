import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-combo-organization-api-"));

let POST;
let PUT;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/combos/route.js"));
  ({ PUT } = await import("@/app/api/combos/[id]/route.js"));
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("nested combo capability API", () => {
  it("POST/PUT accept multi-level vision and partial updates without model-name inference", async () => {
    const create = async (name, models, capabilities = { vision: true }) => {
      const response = await POST(jsonRequest("http://localhost/api/combos", { name, models, capabilities }));
      expect(response.status).toBe(201);
      return response.json();
    };
    await create("vision-child", ["openai/gpt-4o"]);
    await create("vision-middle", ["vision-child"]);
    const parent = await create("vision-parent", [{ model: "vision-middle", autoTier: "strong" }]);
    const update = (patch) => PUT(jsonRequest(`http://localhost/api/combos/${parent.id}`, patch), { params: Promise.resolve({ id: parent.id }) });
    expect((await update({ groupName: "nested", capabilities: { vision: true } })).status).toBe(200);
    expect((await update({ models: ["vision-child"] })).status).toBe(200);
    // Stale persisted parent must not make a new self-cycle pass validation.
    expect((await update({ models: ["vision-parent"] })).status).toBe(400);
    expect((await update({ name: "renamed-parent", models: ["vision-parent"] })).status).toBe(400);
    expect((await update({ models: ["missing-child"] })).status).toBe(400);
    await create("gpt-4o", ["openai/gpt-4o"], { vision: false });
    expect((await update({ models: ["gpt-4o"] })).status).toBe(400);
    const rejected = await POST(jsonRequest("http://localhost/api/combos", {
      name: "false-parent", models: ["gpt-4o"], capabilities: { vision: true },
    }));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("视觉");
    // A qualified actual model is unaffected by a colliding combo name.
    expect((await update({ models: ["openai/gpt-4o"] })).status).toBe(200);
  });
});

describe("combo organization API", () => {
  it("persists grouping and sort order, and accepts null to clear a group", async () => {
    const createResponse = await POST(jsonRequest("http://localhost/api/combos", {
      name: "organized-route",
      models: ["provider/model"],
      groupName: "生产",
      sortOrder: 10,
    }));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.groupName).toBe("生产");
    expect(created.sortOrder).toBe(10);

    const updateResponse = await PUT(jsonRequest(`http://localhost/api/combos/${created.id}`, {
      groupName: null,
      sortOrder: -5,
    }), { params: Promise.resolve({ id: created.id }) });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      id: created.id,
      groupName: null,
      sortOrder: -5,
    });
  });
});
