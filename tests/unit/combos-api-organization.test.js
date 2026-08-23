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
