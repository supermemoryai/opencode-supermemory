import { createHash } from "node:crypto";

import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { AUTOMATIC_CAPTURE_TIMEOUT_MS } from "./capture.js";
import {
  COMPACTION_CONTEXT_MARKER,
  createCompactionPrompt,
  fitProjectMemories,
} from "./compaction-prompt.js";
import { supermemoryClient } from "./client.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { ResolvedTags } from "./tags.js";

const MIN_SUMMARY_CHARS = 100;

interface MessageInfo {
  id: string;
  role: string;
  sessionID: string;
  summary?: unknown;
  finish?: string | boolean;
  error?: unknown;
}

interface SessionMessage {
  info: MessageInfo;
  parts?: Array<{ type: string; text?: string }>;
}

interface CompactionMemoryClient {
  listMemoriesScoped: (
    canonicalTag: string,
    containerTags: string[],
    scope: "project",
    limit: number,
  ) => Promise<{
    memories?: Array<{ summary?: string | null; content?: string | null }>;
  }>;
  addMemory: (
    content: string,
    containerTag: string,
    metadata?: Record<string, unknown>,
    options?: { customId?: string; entityContext?: string; timeoutMs?: number },
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
}

export interface CompactionContext {
  directory: string;
  client: {
    session: {
      messages: (params: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<{ data?: SessionMessage[] } | SessionMessage[]>;
    };
  };
}

export interface CompactionOptions {
  memoryClient?: CompactionMemoryClient;
  /** Called after a compaction summary is saved as a memory. */
  onSaved?: () => void;
}

function getResponseMessages(
  response: { data?: SessionMessage[] } | SessionMessage[],
): SessionMessage[] {
  return Array.isArray(response) ? response : response.data ?? [];
}

function getSummaryContent(message: SessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type: string; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isFinishedSummary(info: MessageInfo | undefined): info is MessageInfo {
  return Boolean(
    info?.sessionID &&
      info.role === "assistant" &&
      info.summary === true &&
      info.finish,
  );
}

function isFailedSummary(info: MessageInfo): boolean {
  return info.finish === "error" || Boolean(info.error);
}

/**
 * OpenCode V1 compaction support. OpenCode decides when to compact, which
 * model summarizes, and how the session continues. Supermemory adds bounded
 * project memories to OpenCode's own compaction prompt and saves each
 * successful summary as a memory.
 */
export function createCompactionHook(
  ctx: CompactionContext,
  tags: ResolvedTags,
  options?: CompactionOptions,
) {
  const memoryClient = options?.memoryClient ?? supermemoryClient;
  const pendingSessions = new Set<string>();
  const captureInProgress = new Set<string>();
  const capturedSummaryIDs = new Map<string, Set<string>>();

  async function fetchProjectMemories(): Promise<string[]> {
    try {
      const result = await memoryClient.listMemoriesScoped(
        tags.canonical,
        tags.projectReads,
        "project",
        CONFIG.maxProjectMemories,
      );
      const memories = (result.memories ?? [])
        .map((memory) => memory.summary || memory.content || "")
        .filter((memory): memory is string => Boolean(memory));
      return fitProjectMemories(memories);
    } catch (error) {
      log("[compaction] failed to fetch project memories", {
        error: String(error),
      });
      return [];
    }
  }

  async function saveSummaryAsMemory(
    sessionID: string,
    summaryID: string,
    summaryContent: string,
  ): Promise<boolean> {
    if (summaryContent.length < MIN_SUMMARY_CHARS) {
      log("[compaction] summary too short to save", {
        sessionID,
        length: summaryContent.length,
      });
      return true;
    }

    try {
      const result = await memoryClient.addMemory(
        `[Session Summary]\n${summaryContent}`,
        tags.canonical,
        {
          type: "conversation",
          project: tags.projectName,
          sm_project_id: tags.projectId,
          sm_scope: "personal",
          sm_capture_mode: "compaction",
          sessionId: sessionID,
        },
        {
          // A stable id per summary makes a repeated save of the same summary a no-op.
          customId: `opencode:compaction:${createHash("sha256").update(`${sessionID}:${summaryID}`).digest("hex")}`,
          entityContext: AGENT_ENTITY_CONTEXT,
          timeoutMs: AUTOMATIC_CAPTURE_TIMEOUT_MS,
        },
      );

      if (result.success) {
        log("[compaction] summary saved as memory", {
          sessionID,
          memoryId: result.id,
        });
        options?.onSaved?.();
        return true;
      }

      log("[compaction] failed to save summary", { error: result.error });
      return false;
    } catch (error) {
      log("[compaction] failed to save summary", { error: String(error) });
      return false;
    }
  }

  async function captureSummary(
    sessionID: string,
    expectedSummaryID?: string,
  ): Promise<void> {
    if (!pendingSessions.has(sessionID) || captureInProgress.has(sessionID)) {
      return;
    }

    const capturedForSession = capturedSummaryIDs.get(sessionID);
    if (expectedSummaryID && capturedForSession?.has(expectedSummaryID)) return;

    captureInProgress.add(sessionID);
    try {
      const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      });
      const summaries = getResponseMessages(response).filter(
        (message) => isFinishedSummary(message.info) && !isFailedSummary(message.info),
      );
      const summary = expectedSummaryID
        ? summaries.find((message) => message.info.id === expectedSummaryID)
        : summaries.at(-1);

      if (!summary) {
        log("[compaction] summary message not available yet", { sessionID });
        return;
      }
      if (capturedSummaryIDs.get(sessionID)?.has(summary.info.id)) return;

      const summaryContent = getSummaryContent(summary);
      if (!summaryContent) {
        log("[compaction] summary content not available yet", {
          sessionID,
          summaryID: summary.info.id,
        });
        return;
      }

      if (!(await saveSummaryAsMemory(sessionID, summary.info.id, summaryContent))) {
        return;
      }

      const captured = capturedSummaryIDs.get(sessionID) ?? new Set<string>();
      captured.add(summary.info.id);
      capturedSummaryIDs.set(sessionID, captured);
      pendingSessions.delete(sessionID);
    } catch (error) {
      log("[compaction] failed to capture summary", { error: String(error) });
    } finally {
      captureInProgress.delete(sessionID);
    }
  }

  return {
    async compacting(
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ): Promise<void> {
      pendingSessions.add(input.sessionID);

      try {
        const projectMemories = await fetchProjectMemories();
        if (!output.context.some((item) => item.includes(COMPACTION_CONTEXT_MARKER))) {
          output.context.push(createCompactionPrompt(projectMemories));
        }
        log("[compaction] native context injected", {
          sessionID: input.sessionID,
          memoriesCount: projectMemories.length,
        });
      } catch (error) {
        // Compaction must never fail because optional Supermemory context failed.
        log("[compaction] failed to inject native context", {
          sessionID: input.sessionID,
          error: String(error),
        });
      }
    },

    async event({ event }: { event: { type: string; properties?: unknown } }) {
      const properties = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = properties?.info as MessageInfo | undefined;
        if (!isFinishedSummary(info)) return;
        if (isFailedSummary(info)) {
          pendingSessions.delete(info.sessionID);
          log("[compaction] native compaction failed; summary not captured", {
            sessionID: info.sessionID,
          });
          return;
        }
        await captureSummary(info.sessionID, info.id);
        return;
      }

      if (event.type === "session.compacted" || event.type === "session.idle") {
        const sessionID = properties?.sessionID as string | undefined;
        if (sessionID && pendingSessions.has(sessionID)) {
          await captureSummary(sessionID);
        }
        return;
      }

      if (event.type === "session.deleted") {
        const sessionInfo = properties?.info as { id?: string } | undefined;
        if (!sessionInfo?.id) return;
        pendingSessions.delete(sessionInfo.id);
        captureInProgress.delete(sessionInfo.id);
        capturedSummaryIDs.delete(sessionInfo.id);
      }
    },
  };
}
