import { describe, expect, test } from "bun:test";

import { SupermemoryClient } from "./client.js";

const canonicalTag = "configured-shared-team-container";
const legacyTag = "opencode_user_test";

const expectedScopeFilters = {
  AND: [
    {
      key: "agent_scope",
      value: "personal",
      filterType: "metadata",
    },
  ],
};

function createClient() {
  const searchCalls: unknown[] = [];
  const profileCalls: unknown[] = [];
  const listCalls: unknown[] = [];
  const client = new SupermemoryClient();

  (client as unknown as { client: unknown }).client = {
    search: {
      memories: async (request: unknown) => {
        searchCalls.push(request);
        return { results: [], total: 0, timing: 0 };
      },
    },
    profile: async (request: unknown) => {
      profileCalls.push(request);
      return { profile: { static: [], dynamic: [] } };
    },
    memories: {
      list: async (request: unknown) => {
        listCalls.push(request);
        return {
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        };
      },
    },
  };

  return { client, searchCalls, profileCalls, listCalls };
}

describe("canonical memory scope filters", () => {
  test("uses agent_scope for an arbitrary configured canonical tag and leaves legacy searches unfiltered", async () => {
    const { client, searchCalls } = createClient();

    await client.searchMemoriesScoped(
      "test query",
      canonicalTag,
      [canonicalTag, legacyTag],
      "personal",
    );

    expect(searchCalls).toEqual([
      expect.objectContaining({
        containerTag: canonicalTag,
        filters: expectedScopeFilters,
      }),
      expect.objectContaining({
        containerTag: legacyTag,
        filters: undefined,
      }),
    ]);
  });

  test("uses agent_scope for an arbitrary configured canonical tag and leaves legacy profiles unfiltered", async () => {
    const { client, profileCalls } = createClient();

    await client.getProfileScoped(
      canonicalTag,
      [canonicalTag, legacyTag],
      "personal",
      "test query",
    );

    expect(profileCalls).toEqual([
      expect.objectContaining({
        containerTag: canonicalTag,
        q: "test query",
        filters: expectedScopeFilters,
      }),
      expect.objectContaining({
        containerTag: legacyTag,
        q: "test query",
        filters: undefined,
      }),
    ]);
  });

  test("uses agent_scope for an arbitrary configured canonical tag and leaves legacy lists unfiltered", async () => {
    const { client, listCalls } = createClient();

    await client.listMemoriesScoped(
      canonicalTag,
      [canonicalTag, legacyTag],
      "personal",
    );

    expect(listCalls).toEqual([
      expect.objectContaining({
        containerTags: [canonicalTag],
        filters: expectedScopeFilters,
      }),
      expect.objectContaining({
        containerTags: [legacyTag],
        filters: undefined,
      }),
    ]);
  });
});
