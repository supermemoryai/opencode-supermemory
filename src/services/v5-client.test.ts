import { describe, expect, test } from "bun:test";

import { V5Client } from "./v5-client.js";

function clientWithDocument(metadata: Record<string, unknown>) {
  const client = new V5Client("sm_test", "http://127.0.0.1:9", {
    update: async () => ({}),
  }, 5_000);
  (client as unknown as { sdk: unknown }).sdk = {
    list: async () => ({
      documents: [
        { id: "doc_1", title: "Bun", summary: null, system: { status: "done", createdAt: "2026-10-01T00:00:00Z" } },
      ],
      pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
    }),
    documents: {
      get: async () => ({ id: "doc_1", content: "Use bun for builds", metadata }),
    },
  };
  return client;
}

const projectScope = {
  containerTags: ["repo_test__0123456789abcdef"],
  filters: { AND: [{ key: "sm_scope", value: "project", filterType: "metadata" as const }] },
  limit: 20,
  order: "desc" as const,
  sort: "createdAt" as const,
  includeContent: true,
};

describe("V5Client document list", () => {
  test("hydrates content when the read omits reserved sm_* keys", async () => {
    const result = await clientWithDocument({ type: "preference" }).memories.list(projectScope);
    expect(result.memories[0]).toMatchObject({ id: "doc_1", content: "Use bun for builds" });
  });

  test("skips content when the document states another scope", async () => {
    const result = await clientWithDocument({ sm_scope: "personal" }).memories.list(projectScope);
    expect(result.memories[0]?.content).toBeUndefined();
  });
});
