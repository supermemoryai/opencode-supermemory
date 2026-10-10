import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";

import {
  AUTOMATIC_CAPTURE_TIMEOUT_MS,
  buildCadenceBatches,
  buildCaptureTurns,
  buildSessionEndBatch,
  createCaptureHook,
  getCaptureId,
  type SessionMessage,
} from "./capture.js";
import { SupermemoryClient } from "./client.js";
import type { ResolvedTags } from "./tags.js";

function textPart(
  messageID: string,
  text: string,
  synthetic = false,
): Part {
  return {
    id: `part-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text,
    synthetic,
  };
}

function user(id: string, text: string): SessionMessage {
  return {
    info: { id, role: "user", sessionID: "session-1" },
    parts: [textPart(id, text)],
  };
}

function assistant(id: string, text: string): SessionMessage {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "session-1",
      finish: "stop",
    },
    parts: [textPart(id, text)],
  };
}

function conversation(turnCount: number): SessionMessage[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const turn = index + 1;
    return [
      user(`user-${turn}`, `question ${turn}`),
      assistant(`assistant-${turn}`, `answer ${turn}`),
    ];
  }).flat();
}

describe("automatic conversation capture", () => {
  test("builds fixed cadence batches and a final remainder", () => {
    const turns = buildCaptureTurns(conversation(7));
    const cadence = buildCadenceBatches(turns, 3);
    const sessionEnd = buildSessionEndBatch(turns, 3);

    expect(cadence.map((batch) => [batch.startTurn, batch.endTurn])).toEqual([
      [1, 3],
      [4, 6],
    ]);
    expect(sessionEnd && [sessionEnd.startTurn, sessionEnd.endTurn]).toEqual([
      7, 7,
    ]);
  });

  test("uses a stable capture ID within the API length limit", () => {
    const batch = buildCadenceBatches(
      [
        {
          id: `msg_${"a".repeat(48)}`,
          messages: [{ role: "user", content: "test" }],
        },
      ],
      1,
    )[0]!;
    const sessionID = `ses_${"b".repeat(48)}`;
    const captureId = getCaptureId(sessionID, batch);

    expect(captureId).toBe(getCaptureId(sessionID, batch));
    expect(captureId.length).toBeLessThanOrEqual(100);
    expect(captureId).not.toContain(sessionID);
  });

  test("excludes synthetic context and protects private turns", () => {
    const messages = [
      {
        ...user("user-1", "real prompt"),
        parts: [
          textPart("user-1", "injected recall", true),
          textPart("user-1", "real prompt"),
        ],
      },
      assistant("assistant-1", "real answer"),
      user("user-2", "<private>secret prompt</private>"),
      assistant("assistant-2", "secret-derived answer"),
      user("user-3", "token <private>secret</private>"),
      assistant("assistant-3", "safe answer"),
    ];

    const turns = buildCaptureTurns(messages);
    expect(turns[0]?.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "assistant", content: "real answer" },
    ]);
    expect(turns[1]?.messages).toEqual([]);
    expect(turns[2]?.messages[0]).toEqual({
      role: "user",
      content: "token [REDACTED]",
    });
  });

  test("captures on the third idle and flushes the final remainder once", async () => {
    let messages = conversation(1);
    const writes: Array<{
      conversationId: string;
      metadata?: Record<string, string | number | boolean>;
      customId?: string;
      timeoutMs?: number;
    }> = [];
    const ctx = {
      directory: "/repo",
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
    };
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
    const hook = createCaptureHook(ctx, tags, {
      captureEveryNTurns: 3,
      memoryClient: {
        ingestConversation: async (
          conversationId,
          _conversationMessages,
          _containerTags,
          metadata,
          options,
        ) => {
          writes.push({
            conversationId,
            metadata,
            customId: options?.customId,
            timeoutMs: options?.timeoutMs,
          });
          return { success: true };
        },
      },
    });

    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    messages = conversation(3);
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.metadata?.captureReason).toBe("cadence");
    expect(writes[0]?.timeoutMs).toBe(AUTOMATIC_CAPTURE_TIMEOUT_MS);

    messages = conversation(4);
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    await hook.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1" } },
      },
    });
    await hook.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1" } },
      },
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]?.metadata?.captureReason).toBe("session_end");
    expect(writes[0]?.customId).not.toBe(writes[1]?.customId);
  });

  test("retains terminal capture state after failure and retries with bounded SDK options", async () => {
    const sdkOptions: Array<{ timeout?: number; maxRetries?: number }> = [];
    let attempts = 0;
    let readAttempts = 0;
    const memoryClient = new SupermemoryClient();
    (
      memoryClient as unknown as {
        client: {
          memories: {
            add: (
              payload: unknown,
              options?: { timeout?: number; maxRetries?: number },
            ) => Promise<{ id: string }>;
          };
        };
      }
    ).client = {
      memories: {
        add: async (_payload, options) => {
          sdkOptions.push(options ?? {});
          attempts += 1;
          if (attempts === 1) throw new Error("temporary capture failure");
          return { id: "memory-1" };
        },
      },
    };

    const hook = createCaptureHook(
      {
        directory: "/repo",
        client: {
          session: {
            messages: async () => {
              readAttempts += 1;
              if (readAttempts === 1) {
                throw new Error("temporary transcript read failure");
              }
              return { data: conversation(1) };
            },
          },
        },
      },
      {
        canonical: "repo_test__0123456789abcdef",
        user: "repo_test__0123456789abcdef",
        project: "repo_test__0123456789abcdef",
        projectId: "0123456789abcdef",
        projectName: "test",
        personalReads: [],
        projectReads: [],
        allReads: [],
      },
      { captureEveryNTurns: 0, memoryClient },
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hook.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: "session-1" } },
        },
      });
    }

    expect(sdkOptions).toEqual([
      { timeout: AUTOMATIC_CAPTURE_TIMEOUT_MS, maxRetries: 0 },
      { timeout: AUTOMATIC_CAPTURE_TIMEOUT_MS, maxRetries: 0 },
    ]);
    expect(readAttempts).toBe(3);
  });
});
