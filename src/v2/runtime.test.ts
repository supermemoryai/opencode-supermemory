import { describe, expect, test } from "bun:test";

import { MAX_CAPTURE_ATTEMPTS } from "../services/capture.js";
import { COMPACTION_CONTEXT_MARKER } from "../services/compaction-prompt.js";
import { executeSupermemoryTool } from "../services/memory-tool.js";
import { DEFAULT_RECALL_DIRECTIVE } from "../services/recall.js";
import type { ResolvedTags } from "../services/tags.js";
import {
  applyInjection,
  buildTranscriptTurns,
  buildV2RecallDirective,
  isSameDirectory,
  mergeTurns,
  setupV2,
  SUPERMEMORY_RECALL_TOOL_NAME,
  SUPERMEMORY_TOOL_NAME,
  V2Runtime,
  type RequestMessage,
  type TranscriptMessage,
  type V2Context,
  type V2Event,
  type V2RuntimeDependencies,
} from "./runtime.js";

const tags: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: [],
  projectReads: [],
  allReads: [],
};

function user(id: string, text: string): TranscriptMessage {
  return { id, type: "user", text };
}

function assistant(
  id: string,
  text: string,
  finish: string = "stop",
): TranscriptMessage {
  return { id, type: "assistant", finish, content: [{ type: "text", text }] };
}

function request(id: string, text: string): RequestMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as RequestMessage;
}

function texts(message: RequestMessage): string[] {
  return (message.content as Array<{ type: string; text?: string }>).map(
    (part) => part.text ?? "",
  );
}

describe("OpenCode 2 transcript capture", () => {
  test("groups completed turns and protects private content", () => {
    const turns = buildTranscriptTurns([
      { id: "sys", type: "system", text: "injected" },
      user("u1", "real prompt"),
      assistant("a1", "calling a tool", "tool-calls"),
      assistant("a2", "real answer"),
      user("u2", "<private>secret prompt</private>"),
      assistant("a3", "secret answer"),
      user("u3", "token <private>secret</private>"),
      assistant("a4", "safe answer"),
      user("u4", "still streaming"),
    ]);

    expect(turns.map((turn) => turn.id)).toEqual(["u1", "u2", "u3"]);
    expect(turns[0]?.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "assistant", content: "calling a tool" },
      { role: "assistant", content: "real answer" },
    ]);
    expect(turns[1]?.messages).toEqual([]);
    expect(turns[2]?.messages[0]).toEqual({
      role: "user",
      content: "token [REDACTED]",
    });
  });

  test("keeps turn positions stable when the transcript is compacted", () => {
    const existing = mergeTurns(
      [],
      new Map(),
      buildTranscriptTurns([user("u1", "one"), assistant("a1", "1")]),
    );
    const index = new Map([["u1", 0]]);
    mergeTurns(
      existing,
      index,
      buildTranscriptTurns([user("u2", "two"), assistant("a2", "2")]),
    );
    expect(existing.map((turn) => turn.id)).toEqual(["u1", "u2"]);
  });
});

describe("OpenCode 2 request injection", () => {
  test("points the advisory directive at the recall helper", () => {
    const directive = buildV2RecallDirective(DEFAULT_RECALL_DIRECTIVE);
    expect(directive).toContain(`\`${SUPERMEMORY_RECALL_TOOL_NAME}\` tool`);
    expect(directive).not.toContain('`supermemory` tool with `mode: "search"`');
  });

  test("injects once per request copy and survives frozen messages", () => {
    const message = request("u1", "hello");
    applyInjection([message], message, { start: ["profile"], end: ["recall"] });
    applyInjection([message], message, { start: ["profile"], end: ["recall"] });
    expect(texts(message)).toEqual(["profile", "hello", "recall"]);

    const frozen = request("u2", "frozen");
    Object.freeze(frozen.content);
    const messages = [frozen];
    applyInjection(messages, frozen, { start: [], end: ["recall"] });
    expect(texts(messages[0]!)).toEqual(["frozen", "recall"]);
  });
});

interface FakeTool {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<{ content?: unknown }>;
}

interface Harness {
  ctx: V2Context;
  runtime: V2Runtime;
  tools: Map<string, FakeTool>;
  hooks: Record<string, (event: unknown) => Promise<void> | void>;
  queries: string[];
  writes: Array<{ customId?: string; timeoutMs?: number; metadata?: Record<string, unknown> }>;
  adds: Array<{ content: string; customId?: string; metadata?: Record<string, unknown> }>;
  emitted: Array<{ kind?: unknown; message?: unknown }>;
  sessionLookups: string[];
  transcript: TranscriptMessage[];
}

interface HarnessOptions {
  /** The plugin instance's location. */
  directory?: string;
  /** Directory OpenCode reports for a session; throw to simulate a failed lookup. */
  sessionDirectory?: (sessionID: string) => string;
  /** Result of each capture write. */
  writeResult?: () => { success: boolean; error?: string };
  /** Plugin storage shared between runtimes, as OpenCode keeps it across reloads. */
  storage?: Map<string, unknown>;
}

function harness(
  config: Partial<V2RuntimeDependencies["config"]> = {},
  options: HarnessOptions = {},
): Harness {
  const harnessOptions = options;
  const directory = options.directory ?? "/repo";
  const sessionDirectory = options.sessionDirectory ?? (() => directory);
  const sessionLookups: string[] = [];
  const tools = new Map<string, FakeTool>();
  const hooks: Harness["hooks"] = {};
  const queries: string[] = [];
  const writes: Harness["writes"] = [];
  const adds: Harness["adds"] = [];
  const emitted: Harness["emitted"] = [];
  const state: { transcript: TranscriptMessage[] } = { transcript: [] };
  const registration = { dispose: async () => undefined };

  const storage = options.storage;
  const ctx = {
    location: { directory },
    ...(storage
      ? {
          storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => void storage.set(key, value),
            remove: async (key: string) => void storage.delete(key),
          },
        }
      : {}),
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: FakeTool) => {
            tools.set(tool.name, tool);
          },
          list: () => [],
          get: () => undefined,
          namespace: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        });
        return registration;
      },
      hook: async (name: string, callback: Harness["hooks"][string]) => {
        hooks[`tool.${name}`] = callback;
        return registration;
      },
      reload: async () => undefined,
      list: async () => [],
    },
    session: {
      hook: async (name: string, callback: Harness["hooks"][string]) => {
        hooks[`session.${name}`] = callback;
        return registration;
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionLookups.push(sessionID);
        return { id: sessionID, location: { directory: sessionDirectory(sessionID) } };
      },
      context: async () => state.transcript,
    },
    permission: {
      hook: async (name: string, callback: Harness["hooks"][string]) => {
        hooks[`permission.${name}`] = callback;
        return registration;
      },
    },
    rpc: {
      register: async () => ({
        ...registration,
        events: {
          emit: async (_name: string, data: Record<string, unknown>) => {
            emitted.push(data);
          },
        },
      }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => undefined),
        }),
      }),
    },
  };

  const memoryClient = {
    getProfileScoped: async () => ({
      success: true,
      profile: { static: ["Prefers bun"], dynamic: [] },
    }),
    searchMemoriesForRecall: async (query: string) => {
      queries.push(query);
      return {
        success: true,
        results: [{ memory: "Uses bun, not Node.js", similarity: 0.9 }],
      };
    },
    searchMemoriesScoped: async () => ({ success: true, results: [] }),
    searchMemoriesMany: async () => ({
      success: true,
      results: [{ id: "m1", memory: "Uses bun, not Node.js", similarity: 0.9 }],
    }),
    listMemoriesScoped: async () => ({
      success: true,
      memories: [{ summary: "Build: bun run build" }],
    }),
    ingestConversation: async (
      _conversationId: string,
      _messages: unknown,
      _containerTags: string[],
      metadata?: Record<string, unknown>,
      options?: { customId?: string; timeoutMs?: number },
    ) => {
      writes.push({ customId: options?.customId, timeoutMs: options?.timeoutMs, metadata });
      return harnessOptions.writeResult?.() ?? { success: true };
    },
    addMemory: async (
      content: string,
      _containerTag: string,
      metadata?: Record<string, unknown>,
      options?: { customId?: string },
    ) => {
      adds.push({ content, customId: options?.customId, metadata });
      return { success: true, id: "mem_1" };
    },
    deleteMemory: async () => ({ success: true }),
  };

  const runtime = new V2Runtime(ctx as unknown as V2Context, {
    configured: true,
    config: {
      recallMode: "direct",
      injectProfile: true,
      captureEveryNTurns: 1,
      compactionEnabled: true,
      keywordPatterns: ["remember"],
      maxProjectMemories: 10,
      ...config,
    },
    memoryClient: memoryClient as unknown as V2RuntimeDependencies["memoryClient"],
    executeTool: executeSupermemoryTool,
    resolveTags: () => tags,
    logger: () => undefined,
    checkUpdate: async () => ({
      currentVersion: "2.0.15",
      latestVersion: "9.9.9",
      updateCommand: "bunx opencode-supermemory@latest install",
    }),
  });

  return {
    ctx: ctx as unknown as V2Context,
    runtime,
    tools,
    hooks,
    queries,
    writes,
    adds,
    emitted,
    sessionLookups,
    get transcript() {
      return state.transcript;
    },
    set transcript(value: TranscriptMessage[]) {
      state.transcript = value;
    },
  };
}

describe("OpenCode 2 runtime", () => {
  test("registers tools and hooks, and auto-allows recall", async () => {
    const h = harness();
    await h.runtime.register();

    expect([...h.tools.keys()].sort()).toEqual([
      SUPERMEMORY_TOOL_NAME,
      SUPERMEMORY_RECALL_TOOL_NAME,
    ].sort());
    expect(Object.keys(h.hooks).sort()).toEqual([
      "permission.evaluate",
      "session.compaction",
      "session.context",
      "tool.execute.after",
      "tool.execute.before",
    ]);

    const evaluation = { action: "supermemory_recall", effect: "ask" };
    await h.hooks["permission.evaluate"]!(evaluation);
    expect(evaluation.effect).toBe("allow");

    const other = { action: "supermemory", effect: "ask" };
    await h.hooks["permission.evaluate"]!(other);
    expect(other.effect).toBe("ask");

    const recall = h.tools.get(SUPERMEMORY_RECALL_TOOL_NAME)!;
    const denied = JSON.parse(
      String((await recall.execute({ mode: "add", content: "x" }, { sessionID: "s1" })).content),
    );
    expect(denied.success).toBe(false);
    const found = JSON.parse(
      String((await recall.execute({ query: "bun" }, { sessionID: "s1" })).content),
    );
    expect(found.count).toBe(1);
    h.runtime.cleanup();
  });

  test("injects profile and direct recall once per prompt, re-applied on continuations", async () => {
    const h = harness();
    await h.runtime.register();

    const first = request("u1", "continue the auth flow work from before");
    await h.runtime.handleContext({ sessionID: "s1", messages: [first] });
    const firstTexts = texts(first);
    expect(firstTexts[0]).toContain("Prefers bun");
    expect(firstTexts.at(-1)).toContain("Uses bun, not Node.js");
    expect(firstTexts).not.toContain(expect.stringContaining("update available"));

    // Tool continuation: fresh request copy, same prompt, no second search.
    const continuation = request("u1", "continue the auth flow work from before");
    await h.runtime.handleContext({
      sessionID: "s1",
      messages: [continuation, { role: "assistant", content: [] } as unknown as RequestMessage],
    });
    expect(texts(continuation)).toEqual(firstTexts);
    expect(h.queries).toHaveLength(1);

    // New prompt: no profile again, repeated memory suppressed per session.
    const second = request("u2", "remember that we deploy with bun");
    await h.runtime.handleContext({
      sessionID: "s1",
      messages: [first, second],
    });
    const secondTexts = texts(second);
    expect(h.queries).toHaveLength(2);
    expect(secondTexts[0]).toBe("remember that we deploy with bun");
    expect(secondTexts.some((text) => text.includes("[MEMORY TRIGGER DETECTED]"))).toBe(true);
    expect(secondTexts.some((text) => text.includes("Uses bun, not Node.js"))).toBe(false);

    const kinds = h.emitted.map((event) => event.kind);
    expect(kinds).toContain("recalled");
    expect(kinds).toContain("update-available");
    h.runtime.cleanup();
  });

  test("advisory mode injects the recall directive instead of searching", async () => {
    const h = harness({ recallMode: "advisory", injectProfile: false });
    await h.runtime.register();
    const message = request("u1", "what did we decide about caching?");
    await h.runtime.handleContext({ sessionID: "s1", messages: [message] });
    expect(texts(message).at(-1)).toContain(SUPERMEMORY_RECALL_TOOL_NAME);
    expect(h.queries).toHaveLength(0);
    h.runtime.cleanup();
  });

  test("captures completed turns idempotently and saves compaction summaries", async () => {
    const h = harness();
    await h.runtime.register();

    h.transcript = [user("u1", "question 1"), assistant("a1", "answer 1")];
    await h.runtime.handleEvent({
      id: "e1",
      type: "session.execution.succeeded",
      data: { sessionID: "s1" },
    });
    await h.runtime.idle();
    await h.runtime.handleEvent({
      id: "e2",
      type: "session.execution.succeeded",
      data: { sessionID: "s1" },
    });
    await h.runtime.idle();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.customId).toStartWith("opencode:capture:");
    expect(h.writes[0]?.timeoutMs).toBe(3_000);
    expect(h.writes[0]?.metadata).toMatchObject({
      captureReason: "cadence",
      sm_capture_mode: "automatic",
    });

    // Compaction truncates the transcript; the earlier turn keeps its slot.
    h.transcript = [
      { id: "c1", type: "compaction" },
      user("u2", "question 2"),
      assistant("a2", "answer 2"),
    ];
    await h.runtime.handleEvent({
      id: "e3",
      type: "session.execution.succeeded",
      data: { sessionID: "s1" },
    });
    await h.runtime.idle();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]?.customId).not.toBe(h.writes[0]?.customId);

    const summary = "Summary ".repeat(20);
    await h.runtime.handleEvent({
      id: "e4",
      type: "session.compaction.ended",
      data: { sessionID: "s1", text: summary, reason: "auto" },
    });
    await h.runtime.handleEvent({
      id: "e4",
      type: "session.compaction.ended",
      data: { sessionID: "s1", text: summary, reason: "auto" },
    });
    expect(h.adds).toHaveLength(1);
    expect(h.adds[0]?.customId).toStartWith("opencode:compaction:");
    expect(h.adds[0]?.metadata).toMatchObject({ sm_capture_mode: "compaction" });

    const system: Array<{ type: "text"; text: string }> = [];
    await h.runtime.handleCompaction({ sessionID: "s1", system });
    expect(system[0]?.text).toContain(COMPACTION_CONTEXT_MARKER);
    expect(system[0]?.text).toContain("Build: bun run build");

    await h.runtime.handleEvent({
      id: "e5",
      type: "session.deleted",
      data: { sessionID: "s1" },
    });
    expect(h.runtime.trackedSessionCount).toBe(0);
    expect(h.writes).toHaveLength(2);
    expect(h.emitted.filter((event) => event.kind === "saved")).toHaveLength(3);
    h.runtime.cleanup();
  });

  test("reports tool-driven recall activity", async () => {
    const h = harness();
    await h.runtime.register();
    await h.hooks["tool.execute.before"]!({
      tool: SUPERMEMORY_TOOL_NAME,
      input: { mode: "search", query: "auth" },
    });
    await h.hooks["tool.execute.after"]!({
      tool: SUPERMEMORY_RECALL_TOOL_NAME,
      status: "completed",
      result: {
        content: JSON.stringify({ success: true, query: "auth", count: 2, results: [{}, {}] }),
      },
    });
    expect(h.emitted.map((event) => event.kind)).toEqual(["recalling", "recalled"]);
    h.runtime.cleanup();
  });
});

function ownershipContext(directory: string): V2Context {
  const registration = { dispose: async () => undefined };
  return {
    location: { directory },
    tool: {
      transform: async () => registration,
      hook: async () => registration,
      reload: async () => undefined,
      list: async () => [],
    },
    session: {
      hook: async () => registration,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        location: { directory },
      }),
      context: async () => [],
    },
    permission: {
      hook: async () => registration,
    },
    rpc: {
      register: async () => ({
        ...registration,
        events: { emit: async () => undefined },
      }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => undefined),
        }),
      }),
    },
  } as unknown as V2Context;
}

function ownershipDeps(): Partial<V2RuntimeDependencies> {
  return {
    configured: true,
    config: {
      recallMode: "direct",
      injectProfile: false,
      captureEveryNTurns: 1,
      compactionEnabled: false,
      keywordPatterns: [],
      maxProjectMemories: 10,
    } as V2RuntimeDependencies["config"],
    memoryClient: {
      searchMemories: async () => ({ success: true, results: [] }),
      addMemory: async () => ({ success: true, id: "mem_1" }),
    } as unknown as V2RuntimeDependencies["memoryClient"],
    executeTool: executeSupermemoryTool,
    resolveTags: () => tags,
    logger: () => undefined,
    checkUpdate: async () => ({
      currentVersion: "2.0.15",
      latestVersion: "2.0.15",
      updateCommand: "bunx opencode-supermemory@latest install",
    }),
  };
}

function ownerFor(directory: string): { generation: number } | undefined {
  return (
    globalThis as unknown as Record<
      symbol,
      { generation: number } | undefined
    >
  )[Symbol.for(`opencode-supermemory.v2.owner:${directory}`)];
}

describe("OpenCode 2 runtime session ownership", () => {
  // OpenCode delivers every location's events to every plugin instance, so two
  // runtimes for different directories both receive each event below.
  const directories: Record<string, string> = {
    "ses-a": "/repo-a",
    "ses-b": "/repo-b",
  };
  const lookup = (sessionID: string) => {
    const directory = directories[sessionID];
    if (!directory) throw new Error(`Session not found: ${sessionID}`);
    return directory;
  };
  const pair = () => {
    const a = harness({}, { directory: "/repo-a", sessionDirectory: lookup });
    const b = harness({}, { directory: "/repo-b", sessionDirectory: lookup });
    a.transcript = [user("u1", "question 1"), assistant("a1", "answer 1")];
    b.transcript = a.transcript;
    return { a, b };
  };
  const broadcast = async (runtimes: V2Runtime[], event: V2Event) => {
    for (const runtime of runtimes) await runtime.handleEvent(event);
    await Promise.all(runtimes.map((runtime) => runtime.idle()));
  };

  test("captures a session only in the runtime for its directory", async () => {
    const { a, b } = pair();
    await a.runtime.register();
    await b.runtime.register();

    await broadcast([a.runtime, b.runtime], {
      id: "e1",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-a" },
    });
    await broadcast([a.runtime, b.runtime], {
      id: "e2",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-b" },
    });

    expect(a.writes.map((write) => write.metadata?.sessionId)).toEqual(["ses-a"]);
    expect(b.writes.map((write) => write.metadata?.sessionId)).toEqual(["ses-b"]);
    a.runtime.cleanup();
    b.runtime.cleanup();
  });

  test("caches ownership per session and trusts sessions it already serves", async () => {
    const { a, b } = pair();
    await a.runtime.register();
    await b.runtime.register();

    // ses-a reached runtime A through its directory-scoped context hook.
    await a.runtime.handleContext({
      sessionID: "ses-a",
      messages: [request("u1", "continue the auth flow work from before")],
    });
    const lookupsBefore = a.sessionLookups.length;

    for (const id of ["e1", "e2", "e3"]) {
      await broadcast([a.runtime, b.runtime], {
        id,
        type: "session.execution.succeeded",
        data: { sessionID: "ses-a" },
      });
    }

    expect(a.sessionLookups.length).toBe(lookupsBefore);
    expect(b.sessionLookups).toEqual(["ses-a"]);
    expect(b.writes).toHaveLength(0);
    expect(a.writes).toHaveLength(1);
    a.runtime.cleanup();
    b.runtime.cleanup();
  });

  test("uses the event location when present and skips sessions it cannot place", async () => {
    const { a, b } = pair();
    await a.runtime.register();
    await b.runtime.register();

    const summary = "Summary ".repeat(20);
    await broadcast([a.runtime, b.runtime], {
      id: "e1",
      type: "session.compaction.ended",
      data: { sessionID: "ses-b", text: summary, reason: "auto" },
      location: { directory: "/repo-b/" },
    });
    expect(a.adds).toHaveLength(0);
    expect(b.adds).toHaveLength(1);
    expect(a.sessionLookups).not.toContain("ses-b");

    await broadcast([a.runtime, b.runtime], {
      id: "e2",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-unknown" },
    });
    expect(a.writes).toHaveLength(0);
    expect(b.writes).toHaveLength(0);
    a.runtime.cleanup();
    b.runtime.cleanup();
  });

  test("does not re-send saved batches when the runtime shuts down", async () => {
    const h = harness({}, { directory: "/repo-a", sessionDirectory: lookup });
    h.transcript = [user("u1", "question 1"), assistant("a1", "answer 1")];
    await h.runtime.register();
    await h.runtime.handleEvent({
      id: "e1",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-a" },
    });
    await h.runtime.idle();
    expect(h.writes).toHaveLength(1);

    h.transcript = [...h.transcript, user("u2", "question 2"), assistant("a2", "answer 2")];
    h.runtime.cleanup();
    await h.runtime.idle();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]?.customId).not.toBe(h.writes[0]?.customId);
  });

  test("stops re-sending a batch after repeated failed writes", async () => {
    const h = harness(
      {},
      {
        directory: "/repo-a",
        sessionDirectory: lookup,
        // The server stays slow: every write times out on the client.
        writeResult: () => ({ success: false, error: "Timeout after 3250ms" }),
      },
    );
    await h.runtime.register();
    const turns: TranscriptMessage[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      turns.push(user(`u${turn}`, `question ${turn}`), assistant(`a${turn}`, `answer ${turn}`));
      h.transcript = [...turns];
      await h.runtime.handleEvent({
        id: `e${turn}`,
        type: "session.execution.succeeded",
        data: { sessionID: "ses-a" },
      });
      await h.runtime.idle();
    }

    const perBatch = new Map<string, number>();
    for (const write of h.writes) {
      perBatch.set(write.customId!, (perBatch.get(write.customId!) ?? 0) + 1);
    }
    expect(Math.max(...perBatch.values())).toBe(MAX_CAPTURE_ATTEMPTS);
    // Unbounded retries would have sent 1 + 2 + ... + 6 = 21 writes.
    expect(h.writes.length).toBeLessThan(21);
    h.runtime.cleanup();
  });

  test("a reloaded runtime does not re-send batches saved before the reload", async () => {
    const storage = new Map<string, unknown>();
    const first = harness({}, { directory: "/repo-a", sessionDirectory: lookup, storage });
    first.transcript = [user("u1", "question 1"), assistant("a1", "answer 1")];
    await first.runtime.register();
    await first.runtime.handleEvent({
      id: "e1",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-a" },
    });
    await first.runtime.idle();
    first.runtime.cleanup();
    await first.runtime.idle();
    expect(first.writes).toHaveLength(1);

    const second = harness({}, { directory: "/repo-a", sessionDirectory: lookup, storage });
    second.transcript = [
      ...first.transcript,
      user("u2", "question 2"),
      assistant("a2", "answer 2"),
    ];
    await second.runtime.register();
    await second.runtime.handleEvent({
      id: "e2",
      type: "session.execution.succeeded",
      data: { sessionID: "ses-a" },
    });
    await second.runtime.idle();

    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]?.customId).not.toBe(first.writes[0]?.customId);

    await second.runtime.handleEvent({
      id: "e3",
      type: "session.deleted",
      data: { sessionID: "ses-a" },
    });
    await second.runtime.idle();
    await Promise.resolve();
    expect([...storage.keys()]).toEqual([]);
    second.runtime.cleanup();
  });

  test("compares directories after normalizing them", () => {
    expect(isSameDirectory("/repo-a/", "/repo-a")).toBe(true);
    expect(isSameDirectory("/repo-a/../repo-a", "/repo-a")).toBe(true);
    expect(isSameDirectory("/repo-a", "/repo-ab")).toBe(false);
  });
});

describe("OpenCode 2 runtime ownership", () => {
  test("each project directory owns its runtime; hot reload replaces only the same directory", async () => {
    const cleanupA1 = await setupV2(ownershipContext("/repo-a"), ownershipDeps());
    const cleanupB1 = await setupV2(ownershipContext("/repo-b"), ownershipDeps());

    expect(ownerFor("/repo-a")?.generation).toBe(1);
    expect(ownerFor("/repo-b")?.generation).toBe(1);

    // A same-directory hot reload replaces the previous generation...
    const cleanupA2 = await setupV2(ownershipContext("/repo-a"), ownershipDeps());
    expect(ownerFor("/repo-a")?.generation).toBe(2);
    // ...but a different directory never disposes another directory's runtime.
    expect(ownerFor("/repo-b")?.generation).toBe(1);

    cleanupA2();
    cleanupA1();
    cleanupB1();
    expect(ownerFor("/repo-a")).toBeUndefined();
    expect(ownerFor("/repo-b")).toBeUndefined();
  });
});
