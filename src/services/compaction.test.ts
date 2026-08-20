import { describe, expect, test } from "bun:test";

import { createCompactionHook, fitProjectMemories } from "./compaction.js";
import type { ResolvedTags } from "./tags.js";

const tags: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: [],
  projectReads: ["legacy-project"],
  allReads: ["legacy-project"],
};

function summaryMessage(id: string, text: string) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "session-1",
      summary: true,
      finish: "stop",
    },
    parts: [{ type: "text", text }],
  };
}

function memoryClient(memories: Array<{ summary?: string }> = []) {
  return {
    listMemoriesScoped: async () => ({ memories }),
    addMemory: async () => ({ success: true as const, id: "memory-1" }),
  };
}

describe("native V1 compaction integration", () => {
  test("bounds and deduplicates project-memory context", () => {
    const memories = fitProjectMemories([
      "same memory",
      "same memory",
      "x".repeat(20_000),
      "y".repeat(20_000),
    ]);

    expect(memories.filter((memory) => memory === "same memory")).toHaveLength(1);
    expect(memories.every((memory) => memory.length <= 2_000)).toBe(true);
    expect(memories.reduce((total, memory) => total + memory.length, 0)).toBeLessThanOrEqual(12_000);
  });

  test("adds context once without replacing the native prompt", async () => {
    const output = { context: ["existing"], prompt: "native prompt" };
    const hook = createCompactionHook(
      { directory: "/repo", client: { session: { messages: async () => [] } } },
      tags,
      { memoryClient: memoryClient([{ summary: "Uses Bun" }]) },
    );

    await hook.compacting({ sessionID: "session-1" }, output);
    await hook.compacting({ sessionID: "session-1" }, output);

    expect(output.prompt).toBe("native prompt");
    expect(output.context).toHaveLength(2);
    expect(output.context[1]).toContain("[SUPERMEMORY COMPACTION CONTEXT]");
    expect(output.context[1]).toContain("Uses Bun");
  });

  test("captures the expected summary and retries transient writes", async () => {
    const summary = summaryMessage("summary-new", "summary ".repeat(20));
    let attempts = 0;
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => ({ data: [summary] }) } },
      },
      tags,
      {
        memoryClient: {
          ...memoryClient(),
          addMemory: async () => {
            attempts += 1;
            return attempts === 1
              ? { success: false as const, error: "temporary" }
              : { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.compacting({ sessionID: "session-1" }, { context: [] });
    await hook.event({
      event: { type: "message.updated", properties: { info: summary.info } },
    });
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    expect(attempts).toBe(2);
  });

  test("does not save failed compaction output", async () => {
    const failed = {
      ...summaryMessage("summary-failed", "partial ".repeat(20)),
      info: {
        ...summaryMessage("summary-failed", "partial").info,
        finish: "error",
        error: { name: "ContextOverflowError" },
      },
    };
    let writes = 0;
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => ({ data: [failed] }) } },
      },
      tags,
      {
        memoryClient: {
          ...memoryClient(),
          addMemory: async () => {
            writes += 1;
            return { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.compacting({ sessionID: "session-1" }, { context: [] });
    await hook.event({
      event: { type: "message.updated", properties: { info: failed.info } },
    });
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    expect(writes).toBe(0);
  });
});
