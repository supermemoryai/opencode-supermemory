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

export interface SkippedRange {
  generation: number;
  offset: number;
  end: number;
  reason: string;
}

export interface SessionCursor {
  count: number;
  generation: number;
  headHash: string;
  skipped?: SkippedRange[];
}

export interface SessionChunk {
  raw: string;
  generation: number;
  offset: number;
  count: number;
  truncatedBytes: number;
  completedTurns: number;
  commit: (skipReason?: string) => void;
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
        ...(Array.isArray(cursor.skipped) ? { skipped: cursor.skipped } : {}),
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

const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_STRING_CHARS = 16 * 1024;
const MAX_SKIPPED_RANGES = 20;
const MIN_REQUEST_MS = 1_000;
const REJECTED_STATUSES = new Set([400, 413, 415, 422]);

function truncateLongStrings(_key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = stripPrivateContent(value);
  return text.length > MAX_RECORD_STRING_CHARS
    ? `${text.slice(0, MAX_RECORD_STRING_CHARS)}…[truncated ${text.length - MAX_RECORD_STRING_CHARS} chars]`
    : text;
}

// A message too big for one request keeps its JSON shape with long strings cut, so the turn is still captured.
function fitMessage(message: unknown): { text: string; truncatedBytes: number } {
  const text = JSON.stringify(message, redactPrivate);
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_CHUNK_BYTES) return { text, truncatedBytes: 0 };
  const cut = JSON.stringify(message, truncateLongStrings);
  return { text: cut, truncatedBytes: bytes - Buffer.byteLength(cut) };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// OpenCode has no append-only transcript file: the host returns the whole
// message history each call and compaction rewrites its head. The message count
// is the append offset; a shorter list or a changed already-sent prefix means the
// history was rewritten, so the generation is bumped and the delta restarts at 0.
export function buildSessionChunks(
  sessionId: string,
  namespace: string,
  transcript: readonly unknown[],
): SessionChunk[] {
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

  const skipped = [...(previous.skipped ?? [])];
  const chunks: SessionChunk[] = [];
  const pushChunk = (start: number, end: number, lines: string[], truncatedBytes: number) => {
    const headHash = hashPrefix(ids, end);
    chunks.push({
      raw: `${lines.join("\n")}\n`,
      generation,
      offset: start,
      count: end,
      truncatedBytes,
      completedTurns: messages
        .slice(start, end)
        .filter((message) => isFinalAssistant(asRecord(message))).length,
      commit: (skipReason) => {
        if (skipReason) {
          skipped.push({ generation, offset: start, end, reason: skipReason });
          skipped.splice(0, Math.max(0, skipped.length - MAX_SKIPPED_RANGES));
        }
        writeCursor(sessionId, namespace, {
          count: end,
          generation,
          headHash,
          ...(skipped.length > 0 ? { skipped } : {}),
        });
      },
    });
  };

  let chunkStart = offset;
  let lines: string[] = [];
  let bytes = 0;
  let truncated = 0;
  for (let index = offset; index < messages.length; index++) {
    const kept = fitMessage(messages[index]);
    const size = Buffer.byteLength(kept.text) + 1;
    if (lines.length > 0 && bytes + size > MAX_CHUNK_BYTES) {
      pushChunk(chunkStart, index, lines, truncated);
      chunkStart = index;
      lines = [];
      bytes = 0;
      truncated = 0;
    }
    lines.push(kept.text);
    bytes += size;
    truncated += kept.truncatedBytes;
  }
  if (lines.length > 0) pushChunk(chunkStart, messages.length, lines, truncated);
  return chunks;
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
  onCaptureWarning?: (message: string) => void;
  logger?: typeof defaultLog;
}): Promise<boolean> {
  const { writer, namespace, sessionId, messages } = options;
  const logger = options.logger ?? defaultLog;
  if (!namespace) return false;

  const chunks = buildSessionChunks(sessionId, namespace, messages);
  if (chunks.length === 0) return true;
  const completedTurns = chunks.reduce((sum, chunk) => sum + chunk.completedTurns, 0);
  if (options.everyNTurns && completedTurns < options.everyNTurns) return true;

  const deadline = Date.now() + (options.timeoutMs ?? SESSION_CAPTURE_TIMEOUT_MS);
  let sent = 0;
  let skippedBytes = 0;
  let truncatedBytes = 0;
  let complete = true;
  const skipReasons = new Set<string>();
  for (const chunk of chunks) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_REQUEST_MS) {
      complete = false;
      break;
    }
    try {
      await writer.addSession(namespace, chunk.raw, {
        sessionId,
        generation: chunk.generation,
        offset: chunk.offset,
        metadata: options.metadata,
        supportingContext: options.supportingContext,
        timeoutMs: remaining,
      });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === "number" && REJECTED_STATUSES.has(status)) {
        const bytes = Buffer.byteLength(chunk.raw);
        chunk.commit(`server rejected ${formatBytes(bytes)} with HTTP ${status}`);
        skippedBytes += bytes;
        skipReasons.add(`HTTP ${status}`);
        logger("[session] chunk rejected and skipped", {
          sessionId,
          generation: chunk.generation,
          offset: chunk.offset,
          count: chunk.count,
          status,
        });
        continue;
      }
      logger("[session] failed to send session chunk; cursor left at this chunk", {
        sessionId,
        generation: chunk.generation,
        offset: chunk.offset,
        error: error instanceof Error ? error.message : String(error),
      });
      complete = false;
      break;
    }
    chunk.commit();
    sent++;
    truncatedBytes += chunk.truncatedBytes;
  }

  if (sent > 0) options.onSaved?.();
  const warning = [
    truncatedBytes > 0
      ? `trimmed ${formatBytes(truncatedBytes)} of oversized tool output`
      : "",
    skippedBytes > 0
      ? `skipped ${formatBytes(skippedBytes)} of this session (${[...skipReasons].join(", ")}); ranges listed in ~/.supermemory-opencode/session`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (warning) options.onCaptureWarning?.(warning);
  if (sent > 0 || skippedBytes > 0) {
    logger("[session] session sent", {
      sessionId,
      chunks: chunks.length,
      sent,
      skippedBytes,
      truncatedBytes,
    });
  }
  return complete;
}
