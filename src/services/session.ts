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

import { getApiBaseUrl } from "../config.js";
import { log as defaultLog } from "./logger.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";

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
  completedTurns: number;
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

// Keyed by destination too, so a send accepted by one backend or namespace never hides history from another.
function cursorPath(sessionId: string, namespace: string): string {
  const destination = createHash("sha256")
    .update(`${getApiBaseUrl()}\n${namespace}`)
    .digest("hex")
    .slice(0, 16);
  return join(
    sessionDir(),
    `${sanitizeSegment(sessionId)}.${destination}.json`,
  );
}

function ensureDir(): void {
  const dir = sessionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readCursor(
  sessionId: string,
  namespace: string,
): SessionCursor {
  try {
    const cursor = JSON.parse(
      readFileSync(cursorPath(sessionId, namespace), "utf8"),
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

function writeCursor(
  sessionId: string,
  namespace: string,
  cursor: SessionCursor,
): void {
  ensureDir();
  const path = cursorPath(sessionId, namespace);
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

interface TranscriptPart {
  type?: string;
  text?: unknown;
  synthetic?: boolean;
  ignored?: boolean;
}

interface TranscriptRecord {
  info?: { role?: string; finish?: unknown; summary?: unknown };
  role?: string;
  type?: string;
  text?: unknown;
  finish?: unknown;
  summary?: unknown;
  parts?: TranscriptPart[];
  content?: TranscriptPart[];
}

function asRecord(message: unknown): TranscriptRecord {
  return message && typeof message === "object"
    ? (message as TranscriptRecord)
    : {};
}

function roleOf(message: TranscriptRecord): string {
  return message.info?.role ?? message.role ?? message.type ?? "";
}

function promptText(message: TranscriptRecord): string {
  const parts = message.parts ?? message.content;
  if (!Array.isArray(parts)) {
    return typeof message.text === "string" ? message.text : "";
  }
  return parts
    .filter(
      (part) =>
        part?.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

function isFinalAssistant(message: TranscriptRecord): boolean {
  const info = message.info ?? message;
  return (
    roleOf(message) === "assistant" &&
    info.summary !== true &&
    typeof info.finish === "string" &&
    info.finish.length > 0 &&
    info.finish !== "tool-calls"
  );
}

// A fully private prompt hides its whole turn, as legacy capture did; the filter is prefix-stable so cursor counts stay valid.
function withoutPrivateTurns(messages: readonly unknown[]): unknown[] {
  let hidden = false;
  return messages.filter((message) => {
    const record = asRecord(message);
    if (roleOf(record) === "user") {
      const text = promptText(record).trim();
      hidden = text.length > 0 && isFullyPrivate(text);
    }
    return !hidden;
  });
}

function redactPrivate(_key: string, value: unknown): unknown {
  return typeof value === "string" ? stripPrivateContent(value) : value;
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
  namespace: string,
  transcript: readonly unknown[],
): SessionDelta | null {
  const messages = withoutPrivateTurns(transcript);
  const previous = readCursor(sessionId, namespace);
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

  const added = messages.slice(offset);
  const raw = `${added
    .map((message) => JSON.stringify(message, redactPrivate))
    .join("\n")}\n`;
  const count = messages.length;
  const headHash = hashPrefix(ids, count);

  return {
    raw,
    generation,
    offset,
    count,
    completedTurns: added.filter((message) => isFinalAssistant(asRecord(message)))
      .length,
    commit: () =>
      writeCursor(sessionId, namespace, { count, generation, headHash }),
  };
}

const pendingCaptures = new Set<Promise<void>>();
let exitHeld = false;

export function holdExitUntilSettled(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  pendingCaptures.add(settled);
  void settled.then(() => pendingCaptures.delete(settled));
  if (exitHeld) return;
  exitHeld = true;
  const exit = process.exit.bind(process);
  process.exit = ((code?: number | string | null) => {
    if (pendingCaptures.size === 0) return exit(code);
    const grace = new Promise<void>((resolve) =>
      setTimeout(resolve, SESSION_CAPTURE_TIMEOUT_MS),
    );
    void Promise.race([Promise.all(pendingCaptures), grace]).then(() =>
      exit(code),
    );
    return undefined as never;
  }) as typeof process.exit;
}

export async function captureSession(options: {
  writer: SessionWriter;
  namespace: string;
  sessionId: string;
  messages: readonly unknown[];
  metadata?: SessionMetadata;
  supportingContext?: string;
  timeoutMs?: number;
  everyNTurns?: number;
  onSaved?: () => void;
  logger?: typeof defaultLog;
}): Promise<boolean> {
  const { writer, namespace, sessionId, messages } = options;
  const logger = options.logger ?? defaultLog;
  if (!namespace) return false;

  const delta = buildSessionDelta(sessionId, namespace, messages);
  if (!delta) return true;
  if (options.everyNTurns && delta.completedTurns < options.everyNTurns) {
    return true;
  }

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
