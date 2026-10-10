import { describe, expect, test } from "bun:test";

import {
  executeSupermemoryTool,
  type MemoryToolClient,
} from "./memory-tool.js";
import type { ResolvedTags } from "./tags.js";

const tags: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: ["legacy_user"],
  projectReads: ["legacy_project"],
  allReads: ["legacy_user", "legacy_project"],
};

function client(overrides: Partial<MemoryToolClient>): MemoryToolClient {
  const unsupported = async () => {
    throw new Error("not used in this test");
  };
  return {
    addMemory: unsupported,
    searchMemoriesScoped: unsupported,
    searchMemoriesMany: unsupported,
    getProfileScoped: unsupported,
    listMemoriesScoped: unsupported,
    deleteMemory: unsupported,
    ...overrides,
  } as MemoryToolClient;
}

describe("shared supermemory tool", () => {
  test("refuses to run without an API key", async () => {
    const result = JSON.parse(
      await executeSupermemoryTool({ mode: "search", query: "x" }, tags, {
        configured: false,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("SUPERMEMORY_API_KEY");
  });

  test("add redacts private content, tags the scope, and reports saves", async () => {
    const calls: unknown[] = [];
    let saved = 0;
    const result = JSON.parse(
      await executeSupermemoryTool(
        {
          mode: "add",
          content: "Use bun <private>token abc</private> for builds",
          scope: "user",
          type: "preference",
        },
        tags,
        {
          configured: true,
          onSaved: () => {
            saved += 1;
          },
          memoryClient: client({
            addMemory: async (content, containerTag, metadata) => {
              calls.push({ content, containerTag, metadata });
              return { success: true, id: "mem_1" };
            },
          } as Partial<MemoryToolClient>),
        },
      ),
    );

    expect(result).toMatchObject({ success: true, id: "mem_1", scope: "user" });
    expect(saved).toBe(1);
    expect(calls[0]).toMatchObject({
      content: "Use bun [REDACTED] for builds",
      containerTag: tags.canonical,
      metadata: { sm_scope: "personal", sm_capture_mode: "tool", type: "preference" },
    });
  });

  test("search normalizes result shapes and marks memories forgettable", async () => {
    const result = JSON.parse(
      await executeSupermemoryTool({ mode: "search", query: "build" }, tags, {
        configured: true,
        memoryClient: client({
          searchMemoriesMany: async () => ({
            success: true,
            results: [
              { id: "m1", memory: "Build with bun", similarity: 0.91 },
              {
                content: "Deploy notes",
                title: "Release",
                filepath: "docs/release.md",
                score: 0.7,
              },
            ],
          }),
        } as Partial<MemoryToolClient>),
      }),
    );

    expect(result.count).toBe(2);
    expect(result.results[0]).toEqual({
      id: "m1",
      content: "Build with bun",
      similarity: 91,
      forgettable: true,
    });
    expect(result.results[1]).toEqual({
      content: "Release: Deploy notes (docs/release.md)",
      similarity: 70,
      title: "Release",
      filepath: "docs/release.md",
      forgettable: false,
    });
  });

  test("forget requires a memory id and searches every read container", async () => {
    const missing = JSON.parse(
      await executeSupermemoryTool({ mode: "forget" }, tags, {
        configured: true,
        memoryClient: client({}),
      }),
    );
    expect(missing.success).toBe(false);

    let containers: string[] = [];
    const result = JSON.parse(
      await executeSupermemoryTool(
        { mode: "forget", memoryId: "m1", scope: "user" },
        tags,
        {
          configured: true,
          memoryClient: client({
            deleteMemory: async (_id, containerTags) => {
              containers = containerTags ?? [];
              return { success: true };
            },
          } as Partial<MemoryToolClient>),
        },
      ),
    );
    expect(result.success).toBe(true);
    expect(containers).toEqual([tags.canonical, "legacy_user"]);
  });
});
