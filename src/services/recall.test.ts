import { describe, expect, test } from "bun:test";

import {
  buildDirectRecallContext,
  buildDirectRecallResult,
  MAX_RECALL_QUERY_CHARS,
  RecallSessionCache,
} from "./recall.js";
import { getInjectedProfileFactTexts } from "./context.js";

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

  test("starts first-turn search alongside profile and suppresses only injected facts", async () => {
    const cache = new RecallSessionCache();
    const profile = {
      success: true,
      profile: {
        static: [
          "Use Bun for all package scripts",
          "This undisplayed profile fact may still be recalled",
        ],
        dynamic: [],
      },
    };
    let resolveSuppression!: (texts: string[]) => void;
    const suppression = new Promise<string[]>((resolve) => {
      resolveSuppression = resolve;
    });
    let searchStarted = false;

    const contextPromise = buildDirectRecallContext({
      prompt: "what did we decide about the build system",
      sessionID: "session-1",
      cache,
      suppressTexts: suppression,
      search: async () => {
        searchStarted = true;
        return {
          success: true as const,
          results: [
            { memory: "Use Bun for all package scripts", similarity: 0.9 },
            {
              memory: "This undisplayed profile fact may still be recalled",
              similarity: 0.85,
            },
            { memory: "Run typecheck before build", similarity: 0.8 },
          ],
        };
      },
    });
    await Promise.resolve();

    expect(searchStarted).toBe(true);
    resolveSuppression(getInjectedProfileFactTexts(profile, 1));
    const context = await contextPromise;

    expect(context).not.toContain("Use Bun for all package scripts");
    expect(context).toContain("This undisplayed profile fact may still be recalled");
    expect(context).toContain("Run typecheck before build");
    expect(context).toContain("◪");
  });

  test("reports visible recall counts and fail-open state", async () => {
    const recalled = await buildDirectRecallResult({
      prompt: "what did we decide about the build system",
      sessionID: "session-visible",
      cache: new RecallSessionCache(),
      search: async () => ({
        success: true,
        results: [{ memory: "Use Bun", similarity: 0.9 }],
      }),
    });
    expect(recalled.status).toBe("recalled");
    expect(recalled.count).toBe(1);
    expect(recalled.tokens).toBeGreaterThan(0);

    const unavailable = await buildDirectRecallResult({
      prompt: "what did we decide about the build system",
      sessionID: "session-unavailable",
      cache: new RecallSessionCache(),
      search: async () => ({ success: false, error: "offline" }),
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.context).toBe("");
    expect(unavailable.error).toBe("offline");

    const thrown = await buildDirectRecallResult({
      prompt: "what did we decide about the build system",
      sessionID: "session-thrown",
      cache: new RecallSessionCache(),
      search: async () => {
        throw new Error("network failed");
      },
    });
    expect(thrown.status).toBe("unavailable");
    expect(thrown.error).toBe("network failed");
  });
});
