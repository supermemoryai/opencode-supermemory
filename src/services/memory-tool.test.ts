import { describe, expect, test } from "bun:test";

import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import {
  executeSupermemoryTool,
  formatSearchResults,
  type MemoryToolClient,
  type SupermemoryToolArgs,
} from "./memory-tool.js";
import type { ResolvedTags } from "./tags.js";

const tags: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test-project",
  personalReads: ["personal-legacy"],
  projectReads: ["project-legacy"],
  allReads: ["personal-legacy", "project-legacy"],
};

const successfulClient: MemoryToolClient = {
  addMemory: async () => ({
    success: true as const,
    id: "memory-1",
    status: "queued",
  }),
  searchMemoriesScoped: async () => ({ success: true, results: [] }),
  searchMemoriesMany: async () => ({ success: true, results: [] }),
  getProfileScoped: async () => ({
    success: true,
    profile: { static: [], dynamic: [] },
  }),
  listMemoriesScoped: async () => ({
    success: true,
    memories: [],
    pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
  }),
  deleteMemory: async () => ({ success: true as const }),
};

function createClient(
  overrides: Partial<MemoryToolClient> = {},
): MemoryToolClient {
  return { ...successfulClient, ...overrides };
}

function execute(
  args: SupermemoryToolArgs,
  memoryClient: MemoryToolClient = successfulClient,
  configured = true,
): Promise<string> {
  return executeSupermemoryTool(args, tags, { memoryClient, configured });
}

describe("shared supermemory tool", () => {
  test("preserves the configuration gate and default help response", async () => {
    expect(await execute({}, successfulClient, false)).toBe(
      JSON.stringify({
        success: false,
        error:
          "SUPERMEMORY_API_KEY not set. Set it in your environment to use Supermemory.",
      }),
    );

    expect(await execute({})).toBe(
      JSON.stringify({
        success: true,
        message: "Supermemory Usage Guide",
        commands: [
          {
            command: "add",
            description: "Store a new memory",
            args: ["content", "type?", "scope?"],
          },
          {
            command: "search",
            description: "Search memories",
            args: ["query", "scope?"],
          },
          {
            command: "profile",
            description: "View user profile",
            args: ["query?"],
          },
          {
            command: "list",
            description: "List recent memories",
            args: ["scope?", "limit?"],
          },
          {
            command: "forget",
            description: "Remove a memory",
            args: ["memoryId", "scope?"],
          },
        ],
        scopes: {
          user: "Personal preferences and knowledge for this project",
          project: "Project-specific knowledge (default)",
        },
        types: [
          "project-config",
          "architecture",
          "error-solution",
          "preference",
          "learned-pattern",
          "conversation",
        ],
      }),
    );
  });

  test("validates and sanitizes add requests without changing metadata", async () => {
    const calls: Array<Parameters<MemoryToolClient["addMemory"]>> = [];
    const memoryClient = createClient({
      addMemory: async (...args) => {
        calls.push(args);
        return { success: true as const, id: "added-1", status: "queued" };
      },
    });

    expect(await execute({ mode: "add" }, memoryClient)).toBe(
      JSON.stringify({
        success: false,
        error: "content parameter is required for add mode",
      }),
    );
    expect(
      await execute(
        { mode: "add", content: "<private>secret</private>" },
        memoryClient,
      ),
    ).toBe(
      JSON.stringify({
        success: false,
        error: "Cannot store fully private content",
      }),
    );

    expect(
      await execute(
        {
          mode: "add",
          content: "Use <private>secret</private> pnpm",
          type: "project-config",
        },
        memoryClient,
      ),
    ).toBe(
      JSON.stringify({
        success: true,
        message: "Memory added to project scope",
        id: "added-1",
        scope: "project",
        type: "project-config",
      }),
    );

    expect(calls).toEqual([
      [
        "Use [REDACTED] pnpm",
        tags.canonical,
        {
          type: "project-config",
          project: tags.projectName,
          sm_project_id: tags.projectId,
          sm_scope: "project",
          sm_capture_mode: "tool",
        },
        { entityContext: AGENT_ENTITY_CONTEXT },
      ],
    ]);
  });

  test("routes searches by scope and preserves result formatting", async () => {
    const scopedCalls: unknown[][] = [];
    const manyCalls: unknown[][] = [];
    const memoryClient = createClient({
      searchMemoriesScoped: async (...args) => {
        scopedCalls.push(args);
        return {
          success: true,
          results: [
            { id: "memory-1", memory: "remembered", similarity: 0.876 },
            { id: "chunk-1", chunk: "chunk only", similarity: 0.123 },
          ],
        };
      },
      searchMemoriesMany: async (...args) => {
        manyCalls.push(args);
        return { success: true, results: [] };
      },
    });

    expect(
      JSON.parse(
        await execute(
          { mode: "search", query: "query", scope: "user", limit: 1 },
          memoryClient,
        ),
      ),
    ).toEqual({
      success: true,
      query: "query",
      scope: "user",
      count: 2,
      results: [
        {
          id: "memory-1",
          content: "remembered",
          similarity: 88,
          forgettable: true,
        },
      ],
    });
    await execute(
      { mode: "search", query: "project", scope: "project" },
      memoryClient,
    );
    await execute({ mode: "search", query: "all" }, memoryClient);

    expect(scopedCalls).toEqual([
      ["query", tags.canonical, tags.personalReads, "personal"],
      ["project", tags.canonical, tags.projectReads, "project"],
    ]);
    expect(manyCalls).toEqual([["all", tags.allReads]]);
    expect(await execute({ mode: "search" }, memoryClient)).toBe(
      JSON.stringify({
        success: false,
        error: "query parameter is required for search mode",
      }),
    );
  });

  test("marks chunk-only search results as non-forgettable", () => {
    expect(
      JSON.parse(
        formatSearchResults("query", undefined, {
          results: [{ id: "chunk-1", chunk: "chunk only", similarity: 0.5 }],
        }),
      ),
    ).toEqual({
      success: true,
      query: "query",
      count: 1,
      results: [
        {
          content: "chunk only",
          similarity: 50,
          forgettable: false,
        },
      ],
    });
  });

  test("preserves profile, list, and forget defaults and payloads", async () => {
    const profileCalls: unknown[][] = [];
    const listCalls: unknown[][] = [];
    const deleteCalls: unknown[][] = [];
    const memoryClient = createClient({
      getProfileScoped: async (...args) => {
        profileCalls.push(args);
        return {
          success: true,
          profile: { static: ["static"], dynamic: ["dynamic"] },
        };
      },
      listMemoriesScoped: async (...args) => {
        listCalls.push(args);
        return {
          success: true,
          memories: [
            {
              id: "memory-1",
              summary: "summary",
              content: "raw content",
              createdAt: "2026-08-20T00:00:00.000Z",
              metadata: { type: "project-config" },
            },
          ],
          pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
        };
      },
      deleteMemory: async (...args) => {
        deleteCalls.push(args);
        return { success: true as const };
      },
    });

    expect(
      JSON.parse(
        await execute(
          { mode: "profile", query: "profile query" },
          memoryClient,
        ),
      ),
    ).toEqual({
      success: true,
      profile: { static: ["static"], dynamic: ["dynamic"] },
    });
    expect(JSON.parse(await execute({ mode: "list" }, memoryClient))).toEqual({
      success: true,
      scope: "project",
      count: 1,
      memories: [
        {
          id: "memory-1",
          content: "summary",
          createdAt: "2026-08-20T00:00:00.000Z",
          metadata: { type: "project-config" },
        },
      ],
    });
    expect(
      await execute(
        { mode: "forget", memoryId: "memory-1", scope: "user" },
        memoryClient,
      ),
    ).toBe(
      JSON.stringify({
        success: true,
        message: "Memory memory-1 removed from user scope",
      }),
    );

    expect(profileCalls).toEqual([
      [tags.canonical, tags.personalReads, "personal", "profile query"],
    ]);
    expect(listCalls).toEqual([
      [tags.canonical, tags.projectReads, "project", 20],
    ]);
    expect(deleteCalls).toEqual([
      ["memory-1", [tags.canonical, ...tags.personalReads]],
    ]);
    expect(await execute({ mode: "forget" }, memoryClient)).toBe(
      JSON.stringify({
        success: false,
        error: "memoryId parameter is required for forget mode",
      }),
    );
  });

  test("preserves client failure fallbacks and thrown errors", async () => {
    expect(
      await execute(
        { mode: "search", query: "query" },
        createClient({
          searchMemoriesMany: async () => ({
            success: false,
            results: [],
          }),
        }),
      ),
    ).toBe(
      JSON.stringify({
        success: false,
        error: "Failed to search memories",
      }),
    );

    expect(
      await execute(
        { mode: "list" },
        createClient({
          listMemoriesScoped: async () => {
            throw new Error("network failed");
          },
        }),
      ),
    ).toBe(JSON.stringify({ success: false, error: "network failed" }));

    expect(await execute({ mode: "unsupported" })).toBe(
      JSON.stringify({ success: false, error: "Unknown mode: unsupported" }),
    );
  });
});
