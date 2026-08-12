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

function successfulMemoryClient(memories: Array<{ summary?: string }> = []) {
  return {
    listMemoriesScoped: async () => ({
      success: true,
      memories,
      pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
    }),
    addMemory: async () => ({ success: true as const, id: "memory-1" }),
  };
}

describe("native compaction integration", () => {
  test("bounds and deduplicates memory context", () => {
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

  test("adds project memory context without replacing OpenCode's prompt", async () => {
    const output = { context: ["existing plugin context"], prompt: "native prompt" };
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => [] } },
      },
      tags,
      { memoryClient: successfulMemoryClient([{ summary: "Uses Bun" }]) },
    );

    await hook.compacting({ sessionID: "session-1" }, output);
    await hook.compacting({ sessionID: "session-1" }, output);

    expect(output.prompt).toBe("native prompt");
    expect(output.context).toHaveLength(2);
    expect(output.context[1]).toContain("[SUPERMEMORY COMPACTION CONTEXT]");
    expect(output.context[1]).toContain("Uses Bun");
  });

  test("allows native compaction to continue when memory lookup fails", async () => {
    const output = { context: [] as string[] };
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => [] } },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          listMemoriesScoped: async () => {
            throw new Error("network unavailable");
          },
        },
      },
    );

    await expect(
      hook.compacting({ sessionID: "session-1" }, output),
    ).resolves.toBeUndefined();
    expect(output.context[0]).toContain("[SUPERMEMORY COMPACTION CONTEXT]");
  });

  test("captures the exact new summary instead of an older summary", async () => {
    const oldSummary = "old ".repeat(30);
    const newSummary = "new ".repeat(30);
    const writes: string[] = [];
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: {
          session: {
            messages: async () => ({
              data: [
                summaryMessage("summary-old", oldSummary),
                summaryMessage("summary-new", newSummary),
              ],
            }),
          },
        },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          addMemory: async (content: string) => {
            writes.push(content);
            return { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.compacting({ sessionID: "session-1" }, { context: [] });
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: summaryMessage("summary-new", newSummary).info,
        },
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(newSummary.trim());
    expect(writes[0]).not.toContain(oldSummary.trim());
  });

  test("waits for the expected summary instead of capturing a stale one", async () => {
    const oldSummary = summaryMessage("summary-old", "old ".repeat(30));
    const newSummary = summaryMessage("summary-new", "new ".repeat(30));
    let messages = [oldSummary];
    const writes: string[] = [];
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => ({ data: messages }) } },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          addMemory: async (content: string) => {
            writes.push(content);
            return { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.compacting({ sessionID: "session-1" }, { context: [] });
    await hook.event({
      event: { type: "message.updated", properties: { info: newSummary.info } },
    });
    expect(writes).toHaveLength(0);

    messages = [oldSummary, newSummary];
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });
    expect(writes[0]).toContain("new ".repeat(30).trim());
  });

  test("retries summary capture on idle after a transient write failure", async () => {
    const summary = summaryMessage("summary-new", "summary ".repeat(20));
    let attempts = 0;
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: {
          session: { messages: async () => ({ data: [summary] }) },
        },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          addMemory: async () => {
            attempts += 1;
            return attempts === 1
              ? { success: false as const, error: "temporary failure" }
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
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    expect(attempts).toBe(2);
  });

  test("does not capture summaries when the native hook did not run", async () => {
    let writes = 0;
    const summary = summaryMessage("summary-new", "summary ".repeat(20));
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: { session: { messages: async () => ({ data: [summary] }) } },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          addMemory: async () => {
            writes += 1;
            return { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.event({
      event: { type: "message.updated", properties: { info: summary.info } },
    });

    expect(writes).toBe(0);
  });

  test("does not save or retry failed compaction output", async () => {
    let writes = 0;
    const failedSummary = {
      ...summaryMessage("summary-failed", "partial ".repeat(30)),
      info: {
        ...summaryMessage("summary-failed", "partial").info,
        finish: "error",
        error: { name: "ContextOverflowError" },
      },
    };
    const hook = createCompactionHook(
      {
        directory: "/repo",
        client: {
          session: { messages: async () => ({ data: [failedSummary] }) },
        },
      },
      tags,
      {
        memoryClient: {
          ...successfulMemoryClient(),
          addMemory: async () => {
            writes += 1;
            return { success: true as const, id: "memory-1" };
          },
        },
      },
    );

    await hook.compacting({ sessionID: "session-1" }, { context: [] });
    await hook.event({
      event: {
        type: "message.updated",
        properties: { info: failedSummary.info },
      },
    });
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    expect(writes).toBe(0);
  });
});
