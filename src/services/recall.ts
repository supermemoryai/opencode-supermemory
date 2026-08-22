import { createHash } from "node:crypto";

import { getRecallConfig } from "../config.js";
import type { SearchResponse } from "./client.js";
import {
  formatRecallHit,
  getRecallResultText,
  normalizeRecallResults,
  type RecallHit,
} from "./recall-results.js";

export const DIRECT_RECALL_TIMEOUT_MS = 3_000;
export const MAX_RECALL_QUERY_CHARS = 500;
const MAX_SESSION_RECALL_HASHES = 500;

export const DEFAULT_RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, silently decide whether recalling saved memory (past sessions, decisions, conventions, the user's preferences) would materially improve your answer to THIS message. Reason first — don't search reflexively, and don't narrate the decision.

Recall — by calling the \`supermemory\` tool with \`mode: "search"\` — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences likely exist
- is ambiguous in a way past context would resolve

Skip recall when the message is self-contained, trivial, a greeting/meta, fully answerable from the current conversation, or you already recalled the relevant context this session and the topic hasn't shifted.

Cadence is per-message: it's fine to recall on several turns in a row, and fine to never recall in a session. When you do recall, run it before answering and fold the results into your response.
</supermemory-recall>`;

const RECALL_DEBUG_SUFFIX = `<recall-debug>
DEBUG MODE: Begin your reply with exactly one line, then continue normally:
[recall-decision] yes|no — <short reason>
"yes" means you are recalling saved Supermemory memory (via the \`supermemory\` tool with \`mode: "search"\`) for THIS message; "no" means you are skipping it.
</recall-debug>`;

export function buildRecallDirective(): string {
  const { directive } = getRecallConfig();
  let text = directive || DEFAULT_RECALL_DIRECTIVE;
  if (process.env.SUPERMEMORY_DEBUG) {
    text += `\n\n${RECALL_DEBUG_SUFFIX}`;
  }
  return text;
}

export function prepareRecallQuery(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 12 || /^[\/#\!]/.test(trimmed)) return null;
  return trimmed.slice(0, MAX_RECALL_QUERY_CHARS);
}

function recallTextHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function recallHash(hit: RecallHit): string {
  return recallTextHash(getRecallResultText(hit.result));
}

export class RecallSessionCache {
  private readonly sessions = new Map<
    string,
    { seen: Set<string>; order: string[] }
  >();

  constructor(private readonly maxHashes = MAX_SESSION_RECALL_HASHES) {}

  private getState(sessionID: string): { seen: Set<string>; order: string[] } {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = { seen: new Set(), order: [] };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  private rememberHash(
    state: { seen: Set<string>; order: string[] },
    hash: string,
  ): boolean {
    if (state.seen.has(hash)) return false;
    state.seen.add(hash);
    state.order.push(hash);
    while (state.order.length > Math.max(1, this.maxHashes)) {
      const oldest = state.order.shift();
      if (oldest) state.seen.delete(oldest);
    }
    return true;
  }

  rememberTexts(sessionID: string, texts: Iterable<string>): void {
    const state = this.getState(sessionID);
    for (const text of texts) {
      const trimmed = text.trim();
      if (trimmed) this.rememberHash(state, recallTextHash(trimmed));
    }
  }

  takeFresh(sessionID: string, hits: RecallHit[]): RecallHit[] {
    const state = this.getState(sessionID);
    return hits.filter((hit) => this.rememberHash(state, recallHash(hit)));
  }

  delete(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
  }
}

function formatDirectRecallContext(hits: RecallHit[]): string {
  return [
    "<supermemory-context>",
    "Relevant memories automatically recalled for this prompt. Every line marked ◪ comes from supermemory:",
    ...hits.map((hit) => `- ◪ ${formatRecallHit(hit)}`),
    "When one shapes your answer, credit it naturally with the ◪ prefix; if you name the source, say \"from supermemory\".",
    "Use these memories only when relevant. Search Supermemory for deeper context if needed.",
    "</supermemory-context>",
  ].join("\n");
}

export async function buildDirectRecallContext(options: {
  prompt: string;
  sessionID: string;
  cache: RecallSessionCache;
  search: (query: string) => Promise<SearchResponse>;
  suppressTexts?: Iterable<string> | Promise<Iterable<string>>;
}): Promise<string> {
  try {
    const query = prepareRecallQuery(options.prompt);
    // Begin the search before waiting for first-turn profile suppression. Both
    // reads have the same timeout, so a cold prompt pays one network window.
    const searchPromise = query
      ? Promise.resolve()
          .then(() => options.search(query))
          .catch(() => null)
      : null;

    if (options.suppressTexts) {
      options.cache.rememberTexts(
        options.sessionID,
        await options.suppressTexts,
      );
    }
    if (!query) return "";

    const response = await searchPromise;
    if (!response?.success) return "";
    const hits = normalizeRecallResults(response.results ?? []);
    const freshHits = options.cache.takeFresh(options.sessionID, hits);
    return freshHits.length > 0 ? formatDirectRecallContext(freshHits) : "";
  } catch {
    return "";
  }
}
