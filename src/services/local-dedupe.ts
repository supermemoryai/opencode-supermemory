import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConversationMessage } from "../types/index.js";

const STATE_DIR = join(homedir(), ".supermemory-opencode");
export const OPENING_PROMPTS_FILE = join(STATE_DIR, "opening-prompts.json");
export const RECALL_QUERIES_FILE = join(STATE_DIR, "recall-queries.json");
const MAX_OPENING_PROMPTS = 1_000;
const MAX_RECALL_QUERIES = 500;
export const RECALL_REPEAT_WINDOW_MS = 10 * 60 * 1000;

type Entries<T> = Record<string, T>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readEntries<T>(file: string): Entries<T> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Entries<T>)
      : {};
  } catch {
    return {};
  }
}

function writeEntries<T>(file: string, entries: Entries<T>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
  renameSync(temporary, file);
}

function newest<T>(entries: Entries<T>, limit: number, at: (value: T) => number): Entries<T> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, left], [, right]) => at(right) - at(left))
      .slice(0, limit),
  );
}

/**
 * Remembers which session first captured each opening prompt per container tag,
 * so repeated one-shot workers do not re-send the same task prompt.
 */
export class OpeningPromptIndex {
  constructor(private readonly file = OPENING_PROMPTS_FILE) {}

  /** Returns the batch to send and a commit to call once the capture is accepted. */
  prepare(
    containerTag: string,
    sessionID: string,
    messages: ConversationMessage[],
  ): { messages: ConversationMessage[]; commit: () => void } {
    const unchanged = { messages, commit: () => {} };
    const opening = messages[0];
    if (opening?.role !== "user" || typeof opening.content !== "string" || !opening.content.trim()) {
      return unchanged;
    }

    try {
      const hash = sha256(`${containerTag}\n${opening.content.replace(/\s+/g, " ").trim()}`);
      const owner = readEntries<{ sessionId: string; at: number }>(this.file)[hash];
      if (owner && owner.sessionId !== sessionID) {
        return {
          messages: [
            {
              role: "user",
              content: `[Opening prompt omitted: identical to one already captured from this machine (sha256:${hash.slice(0, 12)})]`,
            },
            ...messages.slice(1),
          ],
          commit: () => {},
        };
      }
      if (owner) return unchanged;
      return {
        messages,
        commit: () => {
          try {
            const entries = readEntries<{ sessionId: string; at: number }>(this.file);
            entries[hash] ??= { sessionId: sessionID, at: Date.now() };
            writeEntries(this.file, newest(entries, MAX_OPENING_PROMPTS, (entry) => entry.at));
          } catch {}
        },
      };
    } catch {
      return unchanged;
    }
  }
}

/** Exact repeats of a normalized recall query against one container tag within the window. */
export class RecallQueryIndex {
  constructor(
    private readonly file = RECALL_QUERIES_FILE,
    private readonly windowMs = RECALL_REPEAT_WINDOW_MS,
  ) {}

  isRepeat(containerTag: string, query: string, now = Date.now()): boolean {
    try {
      const hash = sha256(`${containerTag}\n${query.toLowerCase().replace(/\s+/g, " ").trim()}`);
      const entries = Object.fromEntries(
        Object.entries(readEntries<number>(this.file)).filter(
          ([, at]) => typeof at === "number" && now - at < this.windowMs,
        ),
      );
      if (entries[hash] !== undefined) return true;
      entries[hash] = now;
      writeEntries(this.file, newest(entries, MAX_RECALL_QUERIES, (at) => at));
      return false;
    } catch {
      return false;
    }
  }
}
