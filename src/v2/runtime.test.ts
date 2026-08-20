import { afterEach, describe, expect, test } from "bun:test";

import type { Message } from "@opencode-ai/ai";
import type { Context as PluginContext } from "@opencode-ai/plugin/promise/plugin";

import plugin from "./index.js";
import {
  EventDeduper,
  SUPERMEMORY_RECALL_INPUT,
  V2Runtime,
  buildV2RecallDirective,
  detectMemoryKeyword,
  setupV2,
  type V2RuntimeDependencies,
} from "./runtime.js";
import type { ResolvedTags } from "../services/tags.js";
import type { SupermemoryToolArgs } from "../services/memory-tool.js";
import { SupermemoryPlugin } from "../index.js";

const TAGS: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: ["personal"],
  projectReads: ["project"],
  allReads: ["personal", "project"],
};

const BASE_CONFIG = {
  autoRecallEveryPrompt: true,
  captureEveryNTurns: 2,
  compactionEnabled: true,
  keywordPatterns: ["remember"],
  maxProjectMemories: 10,
};

interface AddedTool {
  name: string;
  input?: {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  };
  options?: { permission?: string; codemode?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<{
    content?: string;
  }>;
}

interface FakeContext {
  ctx: PluginContext;
  tools: AddedTool[];
  contextHooks: Array<(input: { sessionID: string; messages: Message[] }) => unknown>;
  getCalls: string[];
  subscriptions: { count: number; signal?: AbortSignal };
  disposed: { count: number };
}

class NeverEndingEvents implements AsyncIterable<never> {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<never>>(() => undefined),
    };
  }
}

class PushEvents implements AsyncIterable<unknown> {
  #values: unknown[] = [];
  #waiters: Array<(value: IteratorResult<unknown>) => void> = [];

  push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function fakeContext(options?: {
  directory?: string | ((sessionID: string) => string);
  events?: AsyncIterable<unknown>;
  dispose?: () => Promise<void>;
  transformGate?: Promise<void>;
}): FakeContext {
  const tools: AddedTool[] = [];
  const contextHooks: FakeContext["contextHooks"] = [];
  const getCalls: string[] = [];
  const subscriptions: FakeContext["subscriptions"] = { count: 0 };
  const disposed = { count: 0 };
  const dispose = async () => {
    disposed.count += 1;
    await options?.dispose?.();
  };

  const ctx = {
    tool: {
      transform: async (callback: (draft: { add: (tool: AddedTool) => void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        await options?.transformGate;
        return { dispose };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        getCalls.push(sessionID);
        const directory =
          typeof options?.directory === "function"
            ? options.directory(sessionID)
            : options?.directory ?? "/workspace/project";
        return {
          id: sessionID,
          location: { directory },
        };
      },
      hook: async (
        name: string,
        callback: (input: { sessionID: string; messages: Message[] }) => unknown,
      ) => {
        expect(name).toBe("context");
        contextHooks.push(callback);
        return { dispose };
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        subscriptions.count += 1;
        subscriptions.signal = signal;
        return options?.events ?? new NeverEndingEvents();
      },
    },
  } as unknown as PluginContext;

  return { ctx, tools, contextHooks, getCalls, subscriptions, disposed };
}

function message(id: string, role: "user" | "assistant", text: string): Message {
  return {
    id,
    role,
    content: [{ type: "text", text }],
  } as Message;
}

function textParts(value: Message): string[] {
  return value.content
    .filter((part): part is typeof part & { type: "text"; text: string } =>
      part.type === "text",
    )
    .map((part) => part.text);
}

function memoryClient(overrides: Record<string, unknown> = {}) {
  return {
    addMemory: async () => ({ success: true, id: "memory-1" }),
    ingestConversation: async () => ({ success: true, id: "capture-1" }),
    getProfileScoped: async () => ({
      success: true,
      profile: { static: ["prefers tests"], dynamic: [] },
    }),
    searchMemoriesScoped: async () => ({ success: true, results: [] }),
    searchMemoriesMany: async () => ({ success: true, results: [] }),
    listMemoriesScoped: async () => ({
      success: true,
      memories: [],
      pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
    }),
    deleteMemory: async () => ({ success: true }),
    ...overrides,
  } as unknown as V2RuntimeDependencies["memoryClient"];
}

function dependencies(
  overrides: Partial<V2RuntimeDependencies> = {},
): Partial<V2RuntimeDependencies> {
  return {
    configured: true,
    config: BASE_CONFIG,
    memoryClient: memoryClient(),
    executeTool: (async (args) => JSON.stringify({ success: true, args })) as V2RuntimeDependencies["executeTool"],
    resolveTags: () => TAGS,
    logger: () => undefined,
    getUpdateNotice: async () => null,
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("OpenCode V2 entrypoint and tools", () => {
  test("exports the exact V2 plugin schema", () => {
    expect(plugin.id).toBe("supermemory.opencode");
    expect(typeof plugin.setup).toBe("function");
    expect(Object.keys(plugin).sort()).toEqual(["id", "setup"]);
  });

  test("keeps the V1 root plugin export loadable", () => {
    expect(typeof SupermemoryPlugin).toBe("function");
  });

  test("registers both tools and confines recall to search", async () => {
    const fake = fakeContext();
    const seen: SupermemoryToolArgs[] = [];
    const cleanup = await setupV2(
      fake.ctx,
      dependencies({
        configured: false,
        executeTool: (async (args) => {
          seen.push(args);
          return JSON.stringify({ success: true, mode: args.mode });
        }) as V2RuntimeDependencies["executeTool"],
      }),
    );
    cleanups.push(cleanup);

    expect(fake.tools.map((tool) => tool.name)).toEqual([
      "supermemory",
      "supermemory_recall",
    ]);
    expect(fake.tools[0]?.options).toEqual({
      codemode: false,
      permission: "supermemory",
    });
    expect(fake.tools[1]?.options).toEqual({
      codemode: false,
      permission: "supermemory_recall",
    });
    expect(fake.tools[1]?.input).toBe(SUPERMEMORY_RECALL_INPUT);
    expect(Object.keys(fake.tools[1]?.input?.properties ?? {}).sort()).toEqual([
      "limit",
      "mode",
      "query",
      "scope",
    ]);
    expect(fake.tools[1]?.input?.required).toEqual(["query"]);

    const rejected = await fake.tools[1]!.execute(
      { mode: "add", content: "no" },
      { sessionID: "session-1" },
    );
    expect(JSON.parse(rejected.content ?? "{}")).toMatchObject({
      success: false,
      error: "supermemory_recall only supports search mode",
    });
    expect(seen).toHaveLength(0);

    await fake.tools[1]!.execute(
      { query: "architecture" },
      { sessionID: "session-1" },
    );
    expect(seen).toEqual([{ mode: "search", query: "architecture" }]);
    expect(fake.getCalls).toEqual(["session-1"]);
  });

  test("isolates session directories and tags", async () => {
    const fake = fakeContext({
      directory: (sessionID) => `/repo/${sessionID}`,
    });
    const seen: Array<{ sessionTag: string; query?: string }> = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        resolveTags: (directory) => ({
          ...TAGS,
          canonical: `tag:${directory}`,
          user: `tag:${directory}`,
          project: `tag:${directory}`,
        }),
        executeTool: (async (args, tags) => {
          seen.push({ sessionTag: tags.canonical, query: args.query });
          return JSON.stringify({ success: true });
        }) as V2RuntimeDependencies["executeTool"],
      }),
    );

    await runtime.executeTool({ mode: "search", query: "one" }, "one");
    await runtime.executeTool({ mode: "search", query: "two" }, "two");
    await runtime.executeTool({ mode: "search", query: "again" }, "one");

    expect(seen).toEqual([
      { sessionTag: "tag:/repo/one", query: "one" },
      { sessionTag: "tag:/repo/two", query: "two" },
      { sessionTag: "tag:/repo/one", query: "again" },
    ]);
    expect(fake.getCalls).toEqual(["one", "two"]);
    expect(runtime.trackedSessionCount).toBe(2);
  });
});

describe("V2 context hook", () => {
  test("injects initial context once and per-dispatch recall/nudges", async () => {
    const fake = fakeContext({ directory: "/repo/actual" });
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({ getUpdateNotice: async () => "[UPDATE AVAILABLE]" }),
    );
    const first = message("user-1", "user", "Please remember this preference");

    await runtime.handleContext({ sessionID: "session-1", messages: [first] });
    const firstParts = textParts(first);
    expect(firstParts[0]).toContain("[SUPERMEMORY]");
    expect(firstParts[0]).toContain("[UPDATE AVAILABLE]");
    expect(firstParts).toContain("Please remember this preference");
    expect(firstParts.some((text) => text.includes("[MEMORY TRIGGER DETECTED]"))).toBe(true);
    expect(firstParts.some((text) => text.includes("`supermemory_recall` tool"))).toBe(true);
    expect(firstParts.some((text) => text.includes("`supermemory` tool with `mode: \"search\"`"))).toBe(false);
    expect(fake.getCalls).toEqual(["session-1"]);

    await runtime.handleContext({ sessionID: "session-1", messages: [first] });
    expect(textParts(first)).toEqual(firstParts);

    const second = message("user-2", "user", "What did we decide?");
    await runtime.handleContext({
      sessionID: "session-1",
      messages: [first, second],
    });
    const secondParts = textParts(second);
    expect(secondParts.some((text) => text.includes("`supermemory_recall` tool"))).toBe(true);
    expect(secondParts.some((text) => text.includes("[SUPERMEMORY]"))).toBe(false);
  });

  test("keeps dispatch alive when memory context lookup fails", async () => {
    const fake = fakeContext();
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        getUpdateNotice: async () => "[UPDATE AVAILABLE]",
        memoryClient: memoryClient({
          getProfileScoped: async () => {
            throw new Error("offline");
          },
        }),
      }),
    );
    const user = message("user-1", "user", "hello");

    await expect(
      runtime.handleContext({ sessionID: "session-1", messages: [user] }),
    ).resolves.toBeUndefined();
    expect(textParts(user).some((text) => text.includes("supermemory_recall"))).toBe(true);
    expect(textParts(user).some((text) => text.includes("[UPDATE AVAILABLE]"))).toBe(false);
  });

  test("ignores memory keywords inside code", () => {
    expect(detectMemoryKeyword("remember this", ["remember"])).toBe(true);
    expect(detectMemoryKeyword("```ts\nremember(this)\n```", ["remember"])).toBe(false);
    expect(buildV2RecallDirective()).toContain("`supermemory_recall` tool");
    expect(
      buildV2RecallDirective("Call `supermemory` now, then use `supermemory` again."),
    ).toBe(
      "Call `supermemory_recall` now, then use `supermemory_recall` again.",
    );
  });

  test("distinguishes identical no-ID user dispatches", async () => {
    const fake = fakeContext();
    const runtime = new V2Runtime(fake.ctx, dependencies());
    const first = message("", "user", "same question");
    await runtime.handleContext({ sessionID: "session-1", messages: [first] });
    const second = message("", "user", "same question");
    await runtime.handleContext({
      sessionID: "session-1",
      messages: [first, second],
    });

    expect(textParts(first).filter((text) => text.includes("supermemory_recall"))).toHaveLength(1);
    expect(textParts(second).filter((text) => text.includes("supermemory_recall"))).toHaveLength(1);
  });

  test("does not allocate session caches while unconfigured", async () => {
    const fake = fakeContext();
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({ configured: false }),
    );
    const user = message("user-1", "user", "remember this");

    await runtime.handleContext({ sessionID: "session-1", messages: [user] });
    expect(runtime.trackedSessionCount).toBe(0);
    expect(textParts(user)).toEqual(["remember this"]);
    expect(fake.getCalls).toHaveLength(0);
  });
});

describe("V2 automatic capture", () => {
  test("captures completed turns at cadence and the session-end remainder", async () => {
    const fake = fakeContext();
    const ingests: Array<{
      messages: Array<{ role: string; content: string }>;
      metadata: Record<string, unknown>;
      customId?: string;
    }> = [];
    const client = memoryClient({
      ingestConversation: async (
        _conversationId: string,
        messages: Array<{ role: string; content: string }>,
        _tags: string[],
        metadata: Record<string, unknown>,
        options: { customId?: string },
      ) => {
        ingests.push({ messages, metadata, customId: options.customId });
        return { success: true, id: `capture-${ingests.length}` };
      },
    });
    const runtime = new V2Runtime(fake.ctx, dependencies({ memoryClient: client }));

    const history: Message[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      history.push(message(`user-${turn}`, "user", `question ${turn}`));
      await runtime.handleContext({ sessionID: "session-1", messages: history });
      await runtime.handleEvent({
        id: `text-${turn}`,
        type: "session.text.ended",
        data: {
          sessionID: "session-1",
          assistantMessageID: `assistant-${turn}`,
          ordinal: 0,
          text: `answer ${turn}`,
        },
      });
      if (turn === 1) {
        await runtime.handleEvent({
          id: "tool-called-1",
          type: "session.tool.called",
          data: {
            sessionID: "session-1",
            assistantMessageID: "assistant-1",
            id: "tool-1",
            input: { path: "package.json" },
          },
        });
        await runtime.handleEvent({
          id: "tool-success-1",
          type: "session.tool.success",
          data: {
            sessionID: "session-1",
            assistantMessageID: "assistant-1",
            id: "tool-1",
            content: [{ type: "text", text: "tool output" }],
          },
        });
        await runtime.handleEvent({
          id: "text-1-second",
          type: "session.text.ended",
          data: {
            sessionID: "session-1",
            assistantMessageID: "assistant-1",
            ordinal: 1,
            text: "answer 1 continued",
          },
        });
      }
      history.push(message(`assistant-${turn}`, "assistant", `answer ${turn}`));
      await runtime.handleEvent({
        id: `success-${turn}`,
        type: "session.execution.succeeded",
        data: { sessionID: "session-1" },
      });
    }

    expect(ingests).toHaveLength(1);
    expect(runtime.completedCaptureCount).toBe(1);
    expect(ingests[0]?.messages.map((item) => item.content)).toEqual([
      "question 1",
      "answer 1\nanswer 1 continued",
      "question 2",
      "answer 2",
    ]);
    expect(JSON.stringify(ingests[0]?.messages)).not.toContain("supermemory_recall");

    await runtime.handleEvent({
      id: "delete-1",
      type: "session.deleted",
      data: { sessionID: "session-1" },
    });
    expect(ingests).toHaveLength(2);
    expect(ingests[1]?.messages.map((item) => item.content)).toEqual([
      "question 3",
      "answer 3",
    ]);
    expect(ingests[1]?.metadata.captureReason).toBe("session_end");
    expect(ingests[0]?.customId).not.toBe(ingests[1]?.customId);
    expect(runtime.trackedSessionCount).toBe(0);
    expect(runtime.completedCaptureCount).toBe(0);

    await runtime.handleEvent({
      id: "delete-1",
      type: "session.deleted",
      data: { sessionID: "session-1" },
    });
    expect(ingests).toHaveLength(2);
  });

  test("does not complete failed turns and redacts private spans", async () => {
    const fake = fakeContext();
    const ingests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        config: { ...BASE_CONFIG, captureEveryNTurns: 0 },
        memoryClient: memoryClient({
          ingestConversation: async (
            _id: string,
            messages: Array<{ role: string; content: string }>,
          ) => {
            ingests.push(messages);
            return { success: true, id: "capture" };
          },
        }),
      }),
    );

    const safe = message(
      "user-safe",
      "user",
      "keep this <private>secret</private> preference",
    );
    await runtime.handleContext({ sessionID: "session-1", messages: [safe] });
    await runtime.handleEvent({
      id: "text-safe",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-safe",
        ordinal: 0,
        text: "done",
      },
    });
    await runtime.handleEvent({
      id: "success-safe",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });

    const failed = message("user-failed", "user", "do not capture this failed turn");
    await runtime.handleContext({
      sessionID: "session-1",
      messages: [safe, message("assistant-safe", "assistant", "done"), failed],
    });
    await runtime.handleEvent({
      id: "text-failed",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-failed",
        ordinal: 0,
        text: "partial",
      },
    });
    await runtime.handleEvent({
      id: "failed",
      type: "session.execution.failed",
      data: { sessionID: "session-1", error: {} },
    });
    await runtime.handleEvent({
      id: "delete",
      type: "session.deleted",
      data: { sessionID: "session-1" },
    });

    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.map((item) => item.content)).toEqual([
      "keep this [REDACTED] preference",
      "done",
    ]);
  });

  test("flushes only completed turns on shutdown interruption", async () => {
    const fake = fakeContext();
    const ingests: Array<{
      messages: Array<{ role: string; content: string }>;
      reason: unknown;
    }> = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        config: { ...BASE_CONFIG, captureEveryNTurns: 2 },
        memoryClient: memoryClient({
          ingestConversation: async (
            _id: string,
            messages: Array<{ role: string; content: string }>,
            _tags: string[],
            metadata: Record<string, unknown>,
          ) => {
            ingests.push({ messages, reason: metadata.captureReason });
            return { success: true, id: "capture" };
          },
        }),
      }),
    );

    const userOne = message("user-1", "user", "completed question");
    await runtime.handleContext({ sessionID: "session-1", messages: [userOne] });
    await runtime.handleEvent({
      id: "text-1",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        ordinal: 0,
        text: "completed answer",
      },
    });
    await runtime.handleEvent({
      id: "success-1",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });

    const userTwo = message("user-2", "user", "interrupted question");
    await runtime.handleContext({
      sessionID: "session-1",
      messages: [
        userOne,
        message("assistant-1", "assistant", "completed answer"),
        userTwo,
      ],
    });
    await runtime.handleEvent({
      id: "text-2",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-2",
        ordinal: 0,
        text: "partial answer",
      },
    });
    await runtime.handleEvent({
      id: "shutdown",
      type: "session.execution.interrupted",
      data: { sessionID: "session-1", reason: "shutdown" },
    });

    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.reason).toBe("session_end");
    expect(ingests[0]?.messages.map((item) => item.content)).toEqual([
      "completed question",
      "completed answer",
    ]);
  });
});

describe("V2 native compaction", () => {
  test("injects bounded context and saves the event summary exactly once", async () => {
    const fake = fakeContext();
    const additions: Array<{
      content: string;
      metadata: Record<string, unknown>;
      customId?: string;
    }> = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        memoryClient: memoryClient({
          listMemoriesScoped: async () => ({
            success: true,
            memories: [{ id: "1", summary: "Use Bun" }],
            pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
          }),
          addMemory: async (
            content: string,
            _tag: string,
            metadata: Record<string, unknown>,
            options: { customId?: string },
          ) => {
            additions.push({ content, metadata, customId: options.customId });
            return { success: true, id: "summary" };
          },
        }),
      }),
    );

    await runtime.handleEvent({
      id: "compact-start",
      type: "session.compaction.started",
      data: { sessionID: "session-1", reason: "auto" },
    });
    const user = message("user-1", "user", "compact now");
    await runtime.handleContext({ sessionID: "session-1", messages: [user] });
    expect(textParts(user).some((text) => text.includes("[SUPERMEMORY COMPACTION CONTEXT]"))).toBe(true);
    expect(textParts(user).some((text) => text.includes("Use Bun"))).toBe(true);

    const ended = {
      id: "compact-ended",
      type: "session.compaction.ended",
      data: {
        sessionID: "session-1",
        reason: "auto",
        text: `The complete compacted session summary ${"with retained context ".repeat(5)}`,
      },
    };
    await runtime.handleEvent(ended);
    await runtime.handleEvent(ended);

    expect(additions).toHaveLength(1);
    expect(additions[0]?.content).toBe(
      `[Session Summary]\nThe complete compacted session summary ${"with retained context ".repeat(5).trimEnd()}`,
    );
    expect(additions[0]?.metadata.sm_capture_mode).toBe("compaction");
    expect(additions[0]?.customId).toMatch(/^opencode:compaction:/);
  });

  test("retries failed summary writes on the next session event", async () => {
    const fake = fakeContext();
    const customIds: Array<string | undefined> = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        memoryClient: memoryClient({
          addMemory: async (
            _content: string,
            _tag: string,
            _metadata: Record<string, unknown>,
            options: { customId?: string },
          ) => {
            customIds.push(options.customId);
            return customIds.length === 1
              ? { success: false, error: "temporary" }
              : { success: true, id: "saved" };
          },
        }),
      }),
    );

    await runtime.handleEvent({
      id: "compact-ended",
      type: "session.compaction.ended",
      data: { sessionID: "session-1", text: "summary ".repeat(20) },
    });
    await runtime.handleEvent({
      id: "next-event",
      type: "session.execution.failed",
      data: { sessionID: "session-1", error: {} },
    });

    expect(customIds).toHaveLength(2);
    expect(customIds[0]).toBe(customIds[1]);
  });

  test("does not save anything for a failed compaction", async () => {
    const fake = fakeContext();
    let additions = 0;
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        memoryClient: memoryClient({
          addMemory: async () => {
            additions += 1;
            return { success: true, id: "unexpected" };
          },
        }),
      }),
    );
    await runtime.handleEvent({
      id: "compact-failed",
      type: "session.compaction.failed",
      data: { sessionID: "session-1", error: {} },
    });
    expect(additions).toBe(0);
  });

  test("preserves the V1 short-summary skip", async () => {
    const fake = fakeContext();
    let additions = 0;
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        memoryClient: memoryClient({
          addMemory: async () => {
            additions += 1;
            return { success: true, id: "unexpected" };
          },
        }),
      }),
    );
    await runtime.handleEvent({
      id: "compact-short",
      type: "session.compaction.ended",
      data: { sessionID: "session-1", text: "too short" },
    });
    expect(additions).toBe(0);
  });
});

describe("V2 lifecycle hardening", () => {
  test("bounds event IDs while deduplicating recent events", () => {
    const deduper = new EventDeduper(2);
    expect(deduper.hasSeen("a")).toBe(false);
    expect(deduper.hasSeen("a")).toBe(true);
    expect(deduper.hasSeen("b")).toBe(false);
    expect(deduper.hasSeen("c")).toBe(false);
    expect(deduper.hasSeen("a")).toBe(false);
  });

  test("a duplicate setup retires only the prior generation", async () => {
    const first = fakeContext();
    let staleToolCalls = 0;
    const cleanupFirst = await setupV2(
      first.ctx,
      dependencies({
        configured: false,
        executeTool: (async () => {
          staleToolCalls += 1;
          return "unexpected";
        }) as V2RuntimeDependencies["executeTool"],
      }),
    );
    const second = fakeContext();
    const cleanupSecond = await setupV2(
      second.ctx,
      dependencies({ configured: false }),
    );
    cleanups.push(cleanupFirst, cleanupSecond);

    expect(first.disposed.count).toBe(2);
    expect(second.disposed.count).toBe(0);
    const staleResult = await first.tools[0]!.execute({}, { sessionID: "stale" });
    expect(JSON.parse(staleResult.content ?? "{}").success).toBe(false);
    expect(staleToolCalls).toBe(0);
    cleanupFirst();
    expect(second.disposed.count).toBe(0);
    cleanupSecond();
    expect(second.disposed.count).toBe(2);
  });

  test("disposes a registration that resolves after a duplicate setup wins", async () => {
    let releaseTransform!: () => void;
    const transformGate = new Promise<void>((resolve) => {
      releaseTransform = resolve;
    });
    const first = fakeContext({ transformGate });
    const firstSetup = setupV2(
      first.ctx,
      dependencies({ configured: false }),
    );
    await Promise.resolve();

    const second = fakeContext();
    const cleanupSecond = await setupV2(
      second.ctx,
      dependencies({ configured: false }),
    );
    releaseTransform();
    const cleanupFirst = await firstSetup;
    cleanups.push(cleanupFirst, cleanupSecond);

    expect(first.disposed.count).toBe(1);
    expect(first.contextHooks).toHaveLength(0);
    expect(first.subscriptions.count).toBe(0);
    expect(second.disposed.count).toBe(0);
  });

  test("cleanup does not await an event stream or registration disposal", async () => {
    const fake = fakeContext({
      events: new NeverEndingEvents(),
      dispose: () => new Promise<void>(() => undefined),
    });
    const cleanup = await setupV2(fake.ctx, dependencies());
    const start = performance.now();
    cleanup();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    expect(fake.subscriptions.count).toBe(1);
    expect(fake.subscriptions.signal?.aborted).toBe(true);
  });

  test("cleanup starts a completed remainder flush without waiting for it", async () => {
    const fake = fakeContext();
    let ingestStarted = 0;
    let markIngestStarted!: () => void;
    const ingestStart = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    let finishIngest!: () => void;
    const ingestGate = new Promise<void>((resolve) => {
      finishIngest = resolve;
    });
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        config: { ...BASE_CONFIG, captureEveryNTurns: 0 },
        memoryClient: memoryClient({
          ingestConversation: async () => {
            ingestStarted += 1;
            markIngestStarted();
            await ingestGate;
            return { success: true, id: "capture" };
          },
        }),
      }),
    );
    await runtime.register();
    await runtime.handleContext({
      sessionID: "session-1",
      messages: [message("user-1", "user", "completed question")],
    });
    await runtime.handleEvent({
      id: "text-1",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        ordinal: 0,
        text: "completed answer",
      },
    });
    await runtime.handleEvent({
      id: "success-1",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });

    const start = performance.now();
    runtime.cleanup();
    expect(performance.now() - start).toBeLessThan(50);
    await ingestStart;
    expect(ingestStarted).toBe(1);
    finishIngest();
  });

  test("cleanup serializes behind an active cadence write and flushes the remainder", async () => {
    const fake = fakeContext();
    let releaseFirstIngest!: () => void;
    let activeCadenceStarted!: () => void;
    const activeCadenceStart = new Promise<void>((resolve) => {
      activeCadenceStarted = resolve;
    });
    let sessionEndStarted!: () => void;
    const sessionEndStart = new Promise<void>((resolve) => {
      sessionEndStarted = resolve;
    });
    const activeCadenceGate = new Promise<void>((resolve) => {
      releaseFirstIngest = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const reasons: unknown[] = [];
    const runtime = new V2Runtime(
      fake.ctx,
      dependencies({
        config: { ...BASE_CONFIG, captureEveryNTurns: 2 },
        memoryClient: memoryClient({
          ingestConversation: async (
            _id: string,
            _messages: Array<{ role: string; content: string }>,
            _tags: string[],
            metadata: Record<string, unknown>,
          ) => {
            reasons.push(metadata.captureReason);
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            if (reasons.length === 2) {
              activeCadenceStarted();
              await activeCadenceGate;
            }
            concurrent -= 1;
            if (metadata.captureReason === "session_end") {
              sessionEndStarted();
            }
            if (reasons.length === 1) {
              return { success: false, error: "retry cadence" };
            }
            return { success: true, id: `capture-${reasons.length}` };
          },
        }),
      }),
    );

    const history: Message[] = [];
    history.push(message("user-1", "user", "question 1"));
    await runtime.handleContext({ sessionID: "session-1", messages: history });
    await runtime.handleEvent({
      id: "text-1",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        ordinal: 0,
        text: "answer 1",
      },
    });
    history.push(message("assistant-1", "assistant", "answer 1"));
    await runtime.handleEvent({
      id: "success-1",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });

    history.push(message("user-2", "user", "question 2"));
    await runtime.handleContext({ sessionID: "session-1", messages: history });
    await runtime.handleEvent({
      id: "text-2",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-2",
        ordinal: 0,
        text: "answer 2",
      },
    });
    history.push(message("assistant-2", "assistant", "answer 2"));
    await runtime.handleEvent({
      id: "success-2",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });

    history.push(message("user-3", "user", "question 3"));
    await runtime.handleContext({ sessionID: "session-1", messages: history });
    await runtime.handleEvent({
      id: "text-3",
      type: "session.text.ended",
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-3",
        ordinal: 0,
        text: "answer 3",
      },
    });
    const thirdSuccess = runtime.handleEvent({
      id: "success-3",
      type: "session.execution.succeeded",
      data: { sessionID: "session-1" },
    });
    await activeCadenceStart;

    const cleanupStart = performance.now();
    runtime.cleanup();
    expect(performance.now() - cleanupStart).toBeLessThan(50);
    expect(reasons).toEqual(["cadence", "cadence"]);
    expect(maxConcurrent).toBe(1);

    releaseFirstIngest();
    await thirdSuccess;
    await sessionEndStart;

    expect(reasons).toEqual(["cadence", "cadence", "session_end"]);
    expect(maxConcurrent).toBe(1);
  });

  test("stale context callbacks do no work", async () => {
    const first = fakeContext();
    const cleanupFirst = await setupV2(first.ctx, dependencies());
    const second = fakeContext();
    const cleanupSecond = await setupV2(second.ctx, dependencies());
    cleanups.push(cleanupFirst, cleanupSecond);

    const user = message("user-1", "user", "remember this");
    await first.contextHooks[0]?.({ sessionID: "stale", messages: [user] });
    expect(textParts(user)).toEqual(["remember this"]);
    expect(first.getCalls).toHaveLength(0);
  });

  test("stale event subscriptions do no work", async () => {
    const events = new PushEvents();
    let staleIngests = 0;
    const first = fakeContext({ events });
    const cleanupFirst = await setupV2(
      first.ctx,
      dependencies({
        memoryClient: memoryClient({
          ingestConversation: async () => {
            staleIngests += 1;
            return { success: true, id: "unexpected" };
          },
        }),
      }),
    );
    const second = fakeContext();
    const cleanupSecond = await setupV2(second.ctx, dependencies());
    cleanups.push(cleanupFirst, cleanupSecond);

    events.push({
      id: "stale-success",
      type: "session.execution.succeeded",
      data: { sessionID: "stale" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(staleIngests).toBe(0);
    expect(first.getCalls).toHaveLength(0);
  });
});
