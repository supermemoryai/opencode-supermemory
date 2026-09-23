import { describe, expect, test } from "bun:test";

import {
  buildDirectRecallContext,
  MAX_RECALL_QUERY_CHARS,
  RecallSessionCache,
} from "./recall.js";

describe("direct recall", () => {
  test("applies prompt policy, fails open, and bounds session dedupe", async () => {
    const queries: string[] = [];
    const cache = new RecallSessionCache();
    const recallPrompt = (prompt: string) =>
      buildDirectRecallContext({
        prompt,
        sessionID: "session-1",
        cache,
        search: async (query) => {
          queries.push(query);
          return { success: true, results: [] };
        },
      });

    await recallPrompt("hello");
    await recallPrompt("/search something important");
    await recallPrompt("!run something important");
    await recallPrompt("# heading with enough text");
    await recallPrompt("x".repeat(MAX_RECALL_QUERY_CHARS + 50));

    expect(queries).toHaveLength(1);
    expect(queries[0]).toHaveLength(MAX_RECALL_QUERY_CHARS);

    let text = "first decision";
    const boundedCache = new RecallSessionCache(2);
    const recallSession = (sessionID: string) =>
      buildDirectRecallContext({
        prompt: "recall the decisions from earlier work",
        sessionID,
        cache: boundedCache,
        search: async () => ({
          success: true,
          results: [{ memory: text, similarity: 0.9 }],
        }),
      });

    expect(await recallSession("session-1")).toContain("first decision");
    expect(await recallSession("session-1")).toBe("");
    expect(await recallSession("session-2")).toContain("first decision");
    text = "second decision";
    await recallSession("session-1");
    text = "third decision";
    await recallSession("session-1");
    text = "first decision";
    expect(await recallSession("session-1")).toContain("first decision");

    expect(
      await buildDirectRecallContext({
        prompt: "recall the decisions from earlier work",
        sessionID: "session-3",
        cache: boundedCache,
        search: async () => {
          throw new Error("network failed");
        },
      }),
    ).toBe("");
  });

  test("suppresses first-turn hits already injected from the profile", async () => {
    const cache = new RecallSessionCache();
    const skippedContext = await buildDirectRecallContext({
      prompt: "hello",
      sessionID: "session-1",
      cache,
      suppressTexts: Promise.resolve(["Use Bun for all package scripts"]),
      search: async () => {
        throw new Error("short prompts must not search");
      },
    });
    const context = await buildDirectRecallContext({
      prompt: "what did we decide about the build system",
      sessionID: "session-1",
      cache,
      search: async () => ({
        success: true,
        results: [
          { memory: "Use Bun for all package scripts", similarity: 0.9 },
          { memory: "Run typecheck before build", similarity: 0.8 },
        ],
      }),
    });

    expect(skippedContext).toBe("");
    expect(context).not.toContain("Use Bun for all package scripts");
    expect(context).toContain("Run typecheck before build");
  });
});
