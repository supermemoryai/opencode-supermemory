import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { supermemoryClient } from "./client.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { ResolvedTags } from "./tags.js";

const COMPACTION_CONTEXT_MARKER = "[SUPERMEMORY COMPACTION CONTEXT]";
const MAX_COMPACTION_MEMORY_CHARS = 12_000;
const MAX_SINGLE_MEMORY_CHARS = 2_000;

interface MessageInfo {
  id: string;
  role: string;
  sessionID: string;
  summary?: boolean;
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
    options?: { customId?: string; entityContext?: string },
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
}

export function fitProjectMemories(memories: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let remaining = MAX_COMPACTION_MEMORY_CHARS;

  for (const rawMemory of memories) {
    const normalized = rawMemory.trim();
    if (!normalized || seen.has(normalized) || remaining <= 0) continue;
    seen.add(normalized);

    const memory = normalized.slice(
      0,
      Math.min(MAX_SINGLE_MEMORY_CHARS, remaining),
    );
    result.push(memory);
    remaining -= memory.length;
  }

  return result;
}

export function createCompactionPrompt(projectMemories: string[]): string {
  const memoriesSection =
    projectMemories.length > 0
      ? `
## Project Knowledge (from Supermemory)
The following project-specific knowledge should be preserved and referenced in the summary:
${projectMemories.map((memory) => `- ${memory}`).join("\n")}
`
      : "";

  return `${COMPACTION_CONTEXT_MARKER}

When summarizing this session, you MUST include the following sections in your summary:

## 1. User Requests (As-Is)
- List all original user requests exactly as they were stated
- Preserve the user's exact wording and intent

## 2. Final Goal
- What the user ultimately wanted to achieve
- The end result or deliverable expected

## 3. Work Completed
- What has been done so far
- Files created/modified
- Features implemented
- Problems solved

## 4. Remaining Tasks
- What still needs to be done
- Pending items from the original request
- Follow-up tasks identified during the work

## 5. MUST NOT Do (Critical Constraints)
- Things that were explicitly forbidden
- Approaches that failed and should not be retried
- User's explicit restrictions or preferences
- Anti-patterns identified during the session
${memoriesSection}
This context is critical for maintaining continuity after compaction.
`;
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
    summaryContent: string,
  ): Promise<boolean> {
    if (summaryContent.length < 100) {
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
        { entityContext: AGENT_ENTITY_CONTEXT },
      );

      if (result.success) {
        log("[compaction] summary saved as memory", {
          sessionID,
          memoryId: result.id,
        });
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
      const messages = getResponseMessages(response);
      const summaries = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.info.summary === true &&
          Boolean(message.info.finish) &&
          message.info.finish !== "error" &&
          !message.info.error,
      );
      const summary = expectedSummaryID
        ? summaries.find((message) => message.info.id === expectedSummaryID)
        : summaries.at(-1);

      if (!summary) {
        log("[compaction] summary message not available yet", { sessionID });
        return;
      }

      const alreadyCaptured = capturedSummaryIDs
        .get(sessionID)
        ?.has(summary.info.id);
      if (alreadyCaptured) return;

      const summaryContent = getSummaryContent(summary);
      if (!summaryContent) {
        log("[compaction] summary content not available yet", {
          sessionID,
          summaryID: summary.info.id,
        });
        return;
      }

      if (!(await saveSummaryAsMemory(sessionID, summaryContent))) return;

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
        const context = createCompactionPrompt(projectMemories);
        if (!output.context.some((item) => item.includes(COMPACTION_CONTEXT_MARKER))) {
          output.context.push(context);
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
      const properties = event.properties as
        | Record<string, unknown>
        | undefined;

      if (event.type === "message.updated") {
        const info = properties?.info as MessageInfo | undefined;
        if (
          info?.sessionID &&
          info.role === "assistant" &&
          info.summary === true &&
          Boolean(info.finish) &&
          (info.finish === "error" || Boolean(info.error))
        ) {
          pendingSessions.delete(info.sessionID);
          log("[compaction] native compaction failed; summary not captured", {
            sessionID: info.sessionID,
          });
          return;
        }
        if (
          info?.sessionID &&
          info.role === "assistant" &&
          info.summary === true &&
          Boolean(info.finish)
        ) {
          await captureSummary(info.sessionID, info.id);
        }
        return;
      }

      if (
        event.type === "session.compacted" ||
        event.type === "session.idle"
      ) {
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
