import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log as defaultLog } from "./logger.js";

export const SESSION_CAPTURE_TIMEOUT_MS = 25_000;

function sessionDir(): string {
  const override = process.env.SUPERMEMORY_SESSION_DIR?.trim();
  return override || join(homedir(), ".supermemory-opencode", "session");
}

export interface SessionCursor {
  count: number;
  generation: number;
  headHash: string;
}

export interface SessionDelta {
  raw: string;
  generation: number;
  offset: number;
  count: number;
  commit: () => void;
}

export type SessionMetadata = Record<string, string | number>;

export interface SessionWriter {
  addSession: (
    namespace: string,
    raw: string,
    options: {
      sessionId: string;
      generation: number;
      offset: number;
      metadata?: SessionMetadata;
      supportingContext?: string;
      timeoutMs?: number;
    },
  ) => Promise<void>;
}

export function sessionMetadata(
  projectName: string,
  projectId: string,
): SessionMetadata {
  return {
    type: "session_turn",
    project: projectName,
    sm_project_id: projectId,
    sm_scope: "personal",
    sm_capture_mode: "automatic",
    timestamp: new Date().toISOString(),
  };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cursorPath(sessionId: string): string {
  return join(sessionDir(), `${sanitizeSegment(sessionId)}.json`);
}

function ensureDir(): void {
  const dir = sessionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readCursor(sessionId: string): SessionCursor {
  try {
    const cursor = JSON.parse(
      readFileSync(cursorPath(sessionId), "utf8"),
    ) as Partial<SessionCursor>;
    if (
      typeof cursor.count === "number" &&
      typeof cursor.generation === "number"
    ) {
      return {
        count: cursor.count,
        generation: cursor.generation,
        headHash: typeof cursor.headHash === "string" ? cursor.headHash : "",
      };
    }
  } catch {}
  return { count: 0, generation: 0, headHash: "" };
}

function writeCursor(sessionId: string, cursor: SessionCursor): void {
  ensureDir();
  const path = cursorPath(sessionId);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(cursor));
  renameSync(temp, path);
}

function messageId(message: unknown): string {
  if (message && typeof message === "object") {
    const record = message as { id?: unknown; info?: { id?: unknown } };
    if (typeof record.info?.id === "string") return record.info.id;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}

function hashPrefix(ids: string[], count: number): string {
  if (count <= 0) return "";
  return createHash("sha256")
    .update(ids.slice(0, count).join("\n"))
    .digest("hex");
}

// OpenCode has no append-only transcript file: the host returns the whole
// message history each call and compaction rewrites its head. The message count
// is the append offset; a shorter list or a changed already-sent prefix means the
// history was rewritten, so the generation is bumped and the delta restarts at 0.
export function buildSessionDelta(
  sessionId: string,
  messages: readonly unknown[],
): SessionDelta | null {
  const previous = readCursor(sessionId);
  const ids = messages.map(messageId);
  let offset = previous.count;
  let generation = previous.generation;

  const consumedHash = hashPrefix(ids, Math.min(previous.count, ids.length));
  if (
    messages.length < previous.count ||
    (previous.headHash !== "" && previous.headHash !== consumedHash)
  ) {
    offset = 0;
    generation = previous.generation + 1;
  }

  if (messages.length <= offset) return null;

  const raw = `${messages
    .slice(offset)
    .map((message) => JSON.stringify(message))
    .join("\n")}\n`;
  const count = messages.length;
  const headHash = hashPrefix(ids, count);

  return {
    raw,
    generation,
    offset,
    count,
    commit: () => writeCursor(sessionId, { count, generation, headHash }),
  };
}

export async function captureSession(options: {
  writer: SessionWriter;
  namespace: string;
  sessionId: string;
  messages: readonly unknown[];
  metadata?: SessionMetadata;
  supportingContext?: string;
  timeoutMs?: number;
  onSaved?: () => void;
  logger?: typeof defaultLog;
}): Promise<boolean> {
  const { writer, namespace, sessionId, messages } = options;
  const logger = options.logger ?? defaultLog;
  if (!namespace) return false;

  const delta = buildSessionDelta(sessionId, messages);
  if (!delta) return true;

  try {
    await writer.addSession(namespace, delta.raw, {
      sessionId,
      generation: delta.generation,
      offset: delta.offset,
      metadata: options.metadata,
      supportingContext: options.supportingContext,
      timeoutMs: options.timeoutMs ?? SESSION_CAPTURE_TIMEOUT_MS,
    });
  } catch (error) {
    logger("[session] failed to send session session", {
      sessionId,
      generation: delta.generation,
      offset: delta.offset,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  delta.commit();
  options.onSaved?.();
  logger("[session] session session sent", {
    sessionId,
    generation: delta.generation,
    offset: delta.offset,
    count: delta.count,
    bytes: delta.raw.length,
  });
  return true;
}
