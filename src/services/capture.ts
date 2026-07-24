import { createHash } from "node:crypto";
import type { Part } from "@opencode-ai/sdk";

import { CONFIG } from "../config.js";
import type { ConversationMessage } from "../types/index.js";
import { supermemoryClient } from "./client.js";
import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { log } from "./logger.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";
import type { ResolvedTags } from "./tags.js";

interface CaptureMessageInfo {
  id: string;
  role: string;
  sessionID?: string;
  finish?: string;
  summary?: unknown;
}

export interface SessionMessage {
  info: CaptureMessageInfo;
  parts?: Part[];
}

export interface CaptureTurn {
  id: string;
  messages: ConversationMessage[];
}

export interface CaptureBatch {
  startTurn: number;
  endTurn: number;
  turns: CaptureTurn[];
}

interface CaptureContext {
  directory: string;
  client: {
    session: {
      messages: (params: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<
        { data?: SessionMessage[]; error?: unknown } | SessionMessage[]
      >;
    };
  };
}

interface ConversationWriter {
  ingestConversation: (
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>,
    options?: {
      defaultEntityContext?: string;
      customId?: string;
    },
  ) => Promise<{ success: boolean; error?: string }>;
}

export interface CaptureOptions {
  captureEveryNTurns?: number;
  memoryClient?: ConversationWriter;
}

function extractText(parts: Part[] | undefined): string {
  const text = (parts ?? [])
    .filter(
      (part): part is Part & { type: "text"; text: string } =>
        part.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!text || isFullyPrivate(text)) return "";
  return stripPrivateContent(text).trim();
}

function isFinalAssistantMessage(info: CaptureMessageInfo): boolean {
  return (
    info.role === "assistant" &&
    info.summary !== true &&
    typeof info.finish === "string" &&
    info.finish.length > 0 &&
    info.finish !== "tool-calls"
  );
}

export function buildCaptureTurns(messages: SessionMessage[]): CaptureTurn[] {
  const turns: CaptureTurn[] = [];
  let current:
    | {
        id: string;
        messages: ConversationMessage[];
        fullyPrivate: boolean;
        complete: boolean;
      }
    | undefined;

  const finishCurrent = () => {
    if (current?.complete) {
      turns.push({
        id: current.id,
        messages: current.fullyPrivate ? [] : current.messages,
      });
    }
    current = undefined;
  };

  for (const message of messages) {
    const { info } = message;

    if (info.role === "user") {
      finishCurrent();
      const rawText = (message.parts ?? [])
        .filter(
          (part): part is Part & { type: "text"; text: string } =>
            part.type === "text" &&
            part.synthetic !== true &&
            part.ignored !== true &&
            typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      const text = extractText(message.parts);
      current = {
        id: info.id,
        messages: text ? [{ role: "user", content: text }] : [],
        fullyPrivate: rawText.length > 0 && isFullyPrivate(rawText),
        complete: false,
      };
      continue;
    }

    if (!current || info.role !== "assistant" || info.summary === true) {
      continue;
    }

    const text = extractText(message.parts);
    if (text && !current.fullyPrivate) {
      current.messages.push({ role: "assistant", content: text });
    }
    if (isFinalAssistantMessage(info)) {
      current.complete = true;
    }
  }

  finishCurrent();
  return turns;
}

export function buildCadenceBatches(
  turns: CaptureTurn[],
  captureEveryNTurns: number,
): CaptureBatch[] {
  if (captureEveryNTurns <= 0) return [];

  const batches: CaptureBatch[] = [];
  const completeBatchCount = Math.floor(turns.length / captureEveryNTurns);
  for (let index = 0; index < completeBatchCount; index += 1) {
    const start = index * captureEveryNTurns;
    const end = start + captureEveryNTurns;
    batches.push({
      startTurn: start + 1,
      endTurn: end,
      turns: turns.slice(start, end),
    });
  }
  return batches;
}

export function buildSessionEndBatch(
  turns: CaptureTurn[],
  captureEveryNTurns: number,
): CaptureBatch | null {
  if (turns.length === 0) return null;

  const remainder =
    captureEveryNTurns > 0 ? turns.length % captureEveryNTurns : turns.length;
  if (remainder === 0) return null;

  const start = turns.length - remainder;
  return {
    startTurn: start + 1,
    endTurn: turns.length,
    turns: turns.slice(start),
  };
}

export function getCaptureId(
  sessionID: string,
  batch: CaptureBatch,
): string {
  const firstTurn = batch.turns[0]?.id ?? String(batch.startTurn);
  const lastTurn = batch.turns.at(-1)?.id ?? String(batch.endTurn);
  const fingerprint = `${sessionID}:${firstTurn}:${lastTurn}`;
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `opencode:capture:${digest}`;
}

export function createCaptureHook(
  ctx: CaptureContext,
  tags: ResolvedTags,
  options?: CaptureOptions,
) {
  const captureEveryNTurns =
    options?.captureEveryNTurns ?? CONFIG.captureEveryNTurns;
  const memoryClient = options?.memoryClient ?? supermemoryClient;
  const snapshots = new Map<string, CaptureTurn[]>();
  const activeSessions = new Set<string>();
  const completedCaptureIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  async function refreshSnapshot(sessionID: string): Promise<CaptureTurn[]> {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });
    if (!Array.isArray(response) && !response.data) {
      throw new Error(`Unable to read OpenCode session ${sessionID}`);
    }
    const rawMessages = Array.isArray(response) ? response : response.data ?? [];
    const turns = buildCaptureTurns(rawMessages);
    snapshots.set(sessionID, turns);
    activeSessions.add(sessionID);
    return turns;
  }

  async function saveBatch(
    sessionID: string,
    batch: CaptureBatch,
    reason: "cadence" | "session_end",
  ): Promise<void> {
    const captureId = getCaptureId(sessionID, batch);
    if (completedCaptureIds.has(captureId)) return;

    const messages = batch.turns.flatMap((turn) => turn.messages);
    if (messages.length === 0) {
      completedCaptureIds.add(captureId);
      return;
    }

    const result = await memoryClient.ingestConversation(
      `${sessionID}:${batch.startTurn}-${batch.endTurn}`,
      messages,
      [tags.canonical],
      {
        project: tags.projectName,
        sm_project_id: tags.projectId,
        sm_scope: "personal",
        sm_capture_mode: "automatic",
        captureReason: reason,
        sessionId: sessionID,
        turnStart: batch.startTurn,
        turnEnd: batch.endTurn,
      },
      {
        defaultEntityContext: AGENT_ENTITY_CONTEXT,
        customId: captureId,
      },
    );

    if (result.success) {
      completedCaptureIds.add(captureId);
      log("[capture] conversation batch saved", {
        sessionID,
        reason,
        startTurn: batch.startTurn,
        endTurn: batch.endTurn,
      });
      return;
    }

    log("[capture] failed to save conversation batch", {
      sessionID,
      reason,
      startTurn: batch.startTurn,
      endTurn: batch.endTurn,
      error: result.error,
    });
  }

  async function captureCadence(
    sessionID: string,
    turns: CaptureTurn[],
  ): Promise<void> {
    for (const batch of buildCadenceBatches(turns, captureEveryNTurns)) {
      await saveBatch(sessionID, batch, "cadence");
    }
  }

  async function captureSessionEnd(sessionID: string): Promise<void> {
    const turns = snapshots.get(sessionID);
    if (!turns) return;

    await captureCadence(sessionID, turns);
    const finalBatch = buildSessionEndBatch(turns, captureEveryNTurns);
    if (finalBatch) {
      await saveBatch(sessionID, finalBatch, "session_end");
    }
  }

  async function runExclusive(
    sessionID: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = inFlight.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    inFlight.set(sessionID, next);
    try {
      await next;
    } finally {
      if (inFlight.get(sessionID) === next) {
        inFlight.delete(sessionID);
      }
    }
  }

  return {
    async event({ event }: { event: { type: string; properties?: unknown } }) {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = props?.info as CaptureMessageInfo | undefined;
        if (info?.sessionID) activeSessions.add(info.sessionID);
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = props?.sessionID as string | undefined;
        if (!sessionID) return;

        await runExclusive(sessionID, async () => {
          try {
            const turns = await refreshSnapshot(sessionID);
            await captureCadence(sessionID, turns);
          } catch (error) {
            log("[capture] failed to process idle session", {
              sessionID,
              error: String(error),
            });
          }
        });
        return;
      }

      if (event.type === "session.deleted") {
        const sessionInfo = props?.info as { id?: string } | undefined;
        const sessionID = sessionInfo?.id;
        if (!sessionID) return;

        await runExclusive(sessionID, async () => {
          await captureSessionEnd(sessionID);
          snapshots.delete(sessionID);
          activeSessions.delete(sessionID);
        });
        return;
      }

      if (event.type === "server.instance.disposed") {
        await Promise.all(
          [...activeSessions].map((sessionID) =>
            runExclusive(sessionID, async () => {
              await captureSessionEnd(sessionID);
              snapshots.delete(sessionID);
              activeSessions.delete(sessionID);
            }),
          ),
        );
      }
    },
  };
}
