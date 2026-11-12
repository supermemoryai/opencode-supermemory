import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConversationMessage } from "../types/index.js";
import type { SearchResponse } from "./client.js";

const STATE_DIR = join(homedir(), ".supermemory-opencode");
export const OPENING_PROMPTS_FILE = join(STATE_DIR, "opening-prompts.json");
export const RECALL_QUERIES_FILE = join(STATE_DIR, "recall-queries.json");
const MAX_OPENING_PROMPTS = 1_000;
const MAX_RECALL_QUERIES = 500;
export const RECALL_REPEAT_WINDOW_MS = 10 * 60 * 1000;
export const OPENING_PROMPT_MIN_CHARS = 200;
export const OPENING_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

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
  try {
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function newest<T>(entries: Entries<T>, limit: number, at: (value: T) => number): Entries<T> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, left], [, right]) => at(right) - at(left))
      .slice(0, limit),
  );
}

/**
 * Remembers which session first captured each long opening prompt per container
 * tag in the last 24 hours, so repeated one-shot workers do not re-send it.
 */
export class OpeningPromptIndex {
  constructor(
    private readonly file = OPENING_PROMPTS_FILE,
    private readonly now: () => number = Date.now,
  ) {}

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

    const prompt = opening.content.replace(/\s+/g, " ").trim();
    if (prompt.length < OPENING_PROMPT_MIN_CHARS) return unchanged;

    try {
      const hash = sha256(`${containerTag}\n${prompt}`);
      const owner = this.#fresh()[hash];
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
            const entries = this.#fresh();
            entries[hash] ??= { sessionId: sessionID, at: this.now() };
            writeEntries(this.file, newest(entries, MAX_OPENING_PROMPTS, (entry) => entry.at));
          } catch {}
        },
      };
    } catch {
      return unchanged;
    }
  }

  #fresh(): Entries<{ sessionId: string; at: number }> {
    const now = this.now();
    return Object.fromEntries(
      Object.entries(readEntries<{ sessionId: string; at: number }>(this.file)).filter(
        ([, entry]) =>
          typeof entry?.at === "number" &&
          typeof entry.sessionId === "string" &&
          now - entry.at < OPENING_PROMPT_TTL_MS,
      ),
    );
  }
}

/** Re-serves the last successful recall search per backend, credential, container tags and normalized query within the window. */
export class RecallQueryCache {
  constructor(
    private readonly scope: () => string | null,
    private readonly file = RECALL_QUERIES_FILE,
    private readonly windowMs = RECALL_REPEAT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  wrap(
    containerTags: readonly string[],
    search: (query: string) => Promise<SearchResponse>,
  ): (query: string) => Promise<SearchResponse> {
    return async (query) => {
      const scope = this.scope();
      if (!scope) return search(query);
      const hash = sha256(
        [scope, ...containerTags, query.toLowerCase().replace(/\s+/g, " ").trim()].join("\n"),
      );
      const cached = this.#fresh()[hash];
      if (cached) return cached.response;

      const response = await search(query);
      if (response.success) {
        try {
          const entries = this.#fresh();
          entries[hash] = { at: this.now(), response };
          writeEntries(this.file, newest(entries, MAX_RECALL_QUERIES, (entry) => entry.at));
        } catch {}
      }
      return response;
    };
  }

  #fresh(): Entries<{ at: number; response: SearchResponse }> {
    const now = this.now();
    return Object.fromEntries(
      Object.entries(readEntries<{ at: number; response: SearchResponse }>(this.file)).filter(
        ([, entry]) =>
          typeof entry?.at === "number" &&
          entry.response?.success === true &&
          now - entry.at < this.windowMs,
      ),
    );
  }
}
