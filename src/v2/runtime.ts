import { createHash } from "node:crypto";

import type { Plugin } from "@opencode/plugin";
import type { SessionHooks } from "@opencode/plugin/promise/session";

import { CONFIG, isConfigured, PLUGIN_VERSION } from "../config.js";
import {
  createMemoryActivityReporterFromSink,
  type MemoryActivityNotice,
  type MemoryActivityReporter,
} from "../services/activity.js";
import {
  AUTOMATIC_CAPTURE_TIMEOUT_MS,
  buildCadenceBatches,
  buildSessionEndBatch,
  getCaptureId,
  type CaptureBatch,
  type CaptureTurn,
} from "../services/capture.js";
import { supermemoryClient, type SupermemoryClient } from "../services/client.js";
import {
  createCompactionPrompt,
  fitProjectMemories,
} from "../services/compaction-prompt.js";
import {
  formatContextForPrompt,
  getInjectedProfileFactTexts,
} from "../services/context.js";
import { AGENT_ENTITY_CONTEXT } from "../services/entity-context.js";
import { log } from "../services/logger.js";
import {
  executeSupermemoryTool,
  MEMORY_TOOL_MODES,
  MEMORY_TOOL_SCOPES,
  MEMORY_TOOL_TYPES,
  SUPERMEMORY_RECALL_TOOL_DESCRIPTION,
  SUPERMEMORY_TOOL_DESCRIPTION,
  type SupermemoryToolArgs,
} from "../services/memory-tool.js";
import { RECALL_PERMISSION } from "../services/opencode-permissions.js";
import { isFullyPrivate, stripPrivateContent } from "../services/privacy.js";
import {
  buildDirectRecallResult,
  buildRecallDirective,
  DIRECT_RECALL_TIMEOUT_MS,
  RecallSessionCache,
  type DirectRecallResult,
} from "../services/recall.js";
import { getTags, type ResolvedTags } from "../services/tags.js";
import { checkNpmUpdate, type UpdateInfo } from "../services/version-check.js";
import { SUPERMEMORY_RPC } from "../rpc.js";

export type V2Context = Plugin.Context;
type SessionContextEvent = SessionHooks["context"];
type SessionCompactionEvent = SessionHooks["compaction"];
export type RequestMessage = SessionContextEvent["messages"][number];
type RequestContentPart = RequestMessage["content"][number];

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;
const SYNTHETIC_METADATA_KEY = "supermemory";
const UPDATE_COMMAND = "bunx opencode-supermemory@latest install";
const MAX_DISPATCHES_PER_SESSION = 8;
const MIN_SUMMARY_CHARS = 100;

export const SUPERMEMORY_TOOL_NAME = "supermemory";
export const SUPERMEMORY_RECALL_TOOL_NAME = "supermemory_recall";

export const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for personal preferences in this project (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;

export const SUPERMEMORY_TOOL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: [...MEMORY_TOOL_MODES] },
    content: { type: "string" },
    query: { type: "string" },
    type: { type: "string", enum: [...MEMORY_TOOL_TYPES] },
    scope: { type: "string", enum: [...MEMORY_TOOL_SCOPES] },
    memoryId: { type: "string" },
    limit: { type: "number" },
  },
} as const;

export const SUPERMEMORY_RECALL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["search"] },
    query: { type: "string" },
    scope: { type: "string", enum: [...MEMORY_TOOL_SCOPES] },
    limit: { type: "number" },
  },
  required: ["query"],
} as const;

type RuntimeMemoryClient = Pick<
  SupermemoryClient,
  | "addMemory"
  | "ingestConversation"
  | "getProfileScoped"
  | "searchMemoriesForRecall"
  | "searchMemoriesScoped"
  | "searchMemoriesMany"
  | "listMemoriesScoped"
  | "deleteMemory"
>;

type RuntimeConfig = Pick<
  typeof CONFIG,
  | "recallMode"
  | "injectProfile"
  | "captureEveryNTurns"
  | "compactionEnabled"
  | "keywordPatterns"
  | "maxProjectMemories"
>;

export interface V2RuntimeDependencies {
  configured: boolean;
  config: RuntimeConfig;
  memoryClient: RuntimeMemoryClient;
  executeTool: typeof executeSupermemoryTool;
  resolveTags: typeof getTags;
  logger: typeof log;
  checkUpdate: () => Promise<UpdateInfo | null>;
}

const DEFAULT_DEPENDENCIES: V2RuntimeDependencies = {
  configured: isConfigured(),
  config: CONFIG,
  memoryClient: supermemoryClient,
  executeTool: executeSupermemoryTool,
  resolveTags: getTags,
  logger: log,
  checkUpdate: () =>
    checkNpmUpdate("opencode-supermemory", PLUGIN_VERSION, UPDATE_COMMAND),
};

/** Minimal shape of an OpenCode 2 event as read from `ctx.event.subscribe()`. */
export interface V2Event {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
}

/** Minimal shape of a persisted OpenCode 2 transcript message. */
export interface TranscriptMessage {
  id: string;
  type: string;
  text?: string;
  finish?: string;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

interface Injection {
  start: string[];
  end: string[];
}

interface SessionState {
  directory?: string;
  tags?: ResolvedTags;
  resolving?: Promise<ResolvedTags>;
  injectedInitialContext: boolean;
  dispatches: Map<string, Promise<Injection>>;
  dispatchOrder: string[];
  turns: CaptureTurn[];
  turnIndex: Map<string, number>;
  completedCaptureIds: Set<string>;
}

interface PendingSummary {
  customId: string;
  sessionID: string;
  text: string;
}

interface Registration {
  dispose: () => Promise<void>;
}

function mergeDependencies(
  overrides: Partial<V2RuntimeDependencies> | undefined,
): V2RuntimeDependencies {
  return {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
    config: { ...DEFAULT_DEPENDENCIES.config, ...overrides?.config },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
}

export function detectMemoryKeyword(
  text: string,
  patterns: readonly string[] = CONFIG.keywordPatterns,
): boolean {
  if (patterns.length === 0) return false;
  return new RegExp(`\\b(${patterns.join("|")})\\b`, "i").test(
    removeCodeBlocks(text),
  );
}

/**
 * OpenCode 2 exposes the search-only `supermemory_recall` helper, so the
 * advisory directive points the model at it instead of the full tool.
 */
export function buildV2RecallDirective(
  directive: string = buildRecallDirective(),
): string {
  return directive.replaceAll(
    `\`${SUPERMEMORY_TOOL_NAME}\` tool with \`mode: "search"\``,
    `\`${SUPERMEMORY_RECALL_TOOL_NAME}\` tool`,
  );
}

function isSyntheticPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const metadata = (part as { metadata?: Record<string, unknown> }).metadata;
  return Boolean(metadata?.[SYNTHETIC_METADATA_KEY]);
}

export function extractMessageText(message: {
  content: ReadonlyArray<unknown>;
}): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string" &&
        !isSyntheticPart(part),
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function makeSyntheticPart(text: string, kind: string): RequestContentPart {
  return {
    type: "text",
    text,
    metadata: { [SYNTHETIC_METADATA_KEY]: kind },
  } as RequestContentPart;
}

/**
 * Adds plugin context to the outgoing copy of the latest user message. Hook
 * messages are request-local, so the same injection is re-applied on every
 * model call for the same prompt (including tool continuations).
 */
export function applyInjection(
  messages: RequestMessage[],
  message: RequestMessage,
  injection: Injection,
): void {
  if (injection.start.length === 0 && injection.end.length === 0) return;
  if (message.content.some(isSyntheticPart)) return;

  const start = injection.start.map((text) => makeSyntheticPart(text, "context"));
  const end = injection.end.map((text) => makeSyntheticPart(text, "recall"));

  try {
    const content = message.content as RequestContentPart[];
    content.unshift(...start);
    content.push(...end);
  } catch {
    // Frozen request messages: replace the message with a copy that keeps
    // its prototype so downstream encoding still recognises it.
    const index = messages.indexOf(message);
    if (index < 0) return;
    const copy = Object.assign(
      Object.create(Object.getPrototypeOf(message) as object | null),
      message,
      { content: [...start, ...message.content, ...end] },
    ) as RequestMessage;
    messages[index] = copy;
  }
}

function sanitizeCaptureText(text: string): string {
  if (!text || isFullyPrivate(text)) return "";
  return stripPrivateContent(text).trim();
}

function isFinalAssistant(message: TranscriptMessage): boolean {
  return (
    typeof message.finish === "string" &&
    message.finish.length > 0 &&
    message.finish !== "tool-calls"
  );
}

function assistantText(message: TranscriptMessage): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

/**
 * Groups an OpenCode 2 transcript into completed user/assistant turns using
 * the same rules as the V1 capture hook: synthetic and system messages are
 * ignored, `<private>` content is redacted, and a fully private prompt hides
 * its whole turn.
 */
export function buildTranscriptTurns(
  messages: ReadonlyArray<TranscriptMessage>,
): CaptureTurn[] {
  const turns: CaptureTurn[] = [];
  let current:
    | {
        id: string;
        messages: CaptureTurn["messages"];
        fullyPrivate: boolean;
        complete: boolean;
      }
    | undefined;

  const finish = () => {
    if (current?.complete) {
      turns.push({
        id: current.id,
        messages: current.fullyPrivate ? [] : current.messages,
      });
    }
    current = undefined;
  };

  for (const message of messages) {
    if (message.type === "user") {
      finish();
      const rawText = (message.text ?? "").trim();
      const text = sanitizeCaptureText(rawText);
      current = {
        id: message.id,
        messages: text ? [{ role: "user", content: text }] : [],
        fullyPrivate: rawText.length > 0 && isFullyPrivate(rawText),
        complete: false,
      };
      continue;
    }

    if (!current || message.type !== "assistant") continue;

    const text = sanitizeCaptureText(assistantText(message));
    if (text && !current.fullyPrivate) {
      current.messages.push({ role: "assistant", content: text });
    }
    if (isFinalAssistant(message)) current.complete = true;
  }

  finish();
  return turns;
}

/**
 * Merges freshly read turns into the session's cumulative turn list. The
 * transcript OpenCode returns may shrink after compaction, so turn positions
 * (and therefore capture IDs) are anchored to the first time a turn was seen.
 */
export function mergeTurns(
  existing: CaptureTurn[],
  index: Map<string, number>,
  incoming: CaptureTurn[],
): CaptureTurn[] {
  for (const turn of incoming) {
    const position = index.get(turn.id);
    if (position === undefined) {
      index.set(turn.id, existing.length);
      existing.push(turn);
    } else {
      existing[position] = turn;
    }
  }
  return existing;
}

export class EventDeduper {
  readonly #limit: number;
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];

  constructor(limit = 4_096) {
    this.#limit = Math.max(1, limit);
  }

  hasSeen(id: string | undefined): boolean {
    if (!id) return false;
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    this.#order.push(id);
    if (this.#order.length > this.#limit) {
      const oldest = this.#order.shift();
      if (oldest) this.#seen.delete(oldest);
    }
    return false;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export class V2Runtime {
  readonly #ctx: V2Context;
  readonly #deps: V2RuntimeDependencies;
  readonly #isOwner: () => boolean;
  readonly #states = new Map<string, SessionState>();
  readonly #recall = new RecallSessionCache();
  readonly #captureInFlight = new Map<string, Promise<void>>();
  readonly #pendingSummaries = new Map<string, PendingSummary>();
  readonly #summaryInFlight = new Set<string>();
  readonly #deduper = new EventDeduper();
  readonly #registrations: Registration[] = [];
  readonly #abortController = new AbortController();
  #emitActivity: ((notice: MemoryActivityNotice) => void) | undefined;
  #activity: MemoryActivityReporter;
  #active = true;

  constructor(
    ctx: V2Context,
    options?: Partial<V2RuntimeDependencies>,
    isOwner: () => boolean = () => true,
  ) {
    this.#ctx = ctx;
    this.#deps = mergeDependencies(options);
    this.#isOwner = isOwner;
    this.#activity = createMemoryActivityReporterFromSink((notice) => {
      this.#deps.logger("[activity]", { kind: notice.kind, message: notice.message });
      this.#emitActivity?.(notice);
    });
  }

  get active(): boolean {
    return this.#active && this.#isOwner();
  }

  get trackedSessionCount(): number {
    return this.#states.size;
  }

  async register(): Promise<void> {
    const { logger } = this.#deps;

    await this.#track(
      this.#ctx.tool.transform((editor) => {
        editor.add({
          name: SUPERMEMORY_TOOL_NAME,
          description: SUPERMEMORY_TOOL_DESCRIPTION,
          input: SUPERMEMORY_TOOL_INPUT,
          options: { codemode: false, permission: SUPERMEMORY_TOOL_NAME },
          execute: async (input, context) => {
            if (!this.active) return { content: this.#inactiveToolResult() };
            return {
              content: await this.executeTool(
                input as SupermemoryToolArgs,
                context.sessionID,
              ),
            };
          },
        });

        editor.add({
          name: SUPERMEMORY_RECALL_TOOL_NAME,
          description: SUPERMEMORY_RECALL_TOOL_DESCRIPTION,
          input: SUPERMEMORY_RECALL_INPUT,
          options: { codemode: false, permission: RECALL_PERMISSION.action },
          execute: async (input, context) => {
            if (!this.active) return { content: this.#inactiveToolResult() };
            return {
              content: await this.executeRecallTool(
                input as SupermemoryToolArgs,
                context.sessionID,
              ),
            };
          },
        });
      }),
    );
    if (!this.active) return;

    if (!this.#deps.configured) {
      logger("v2 plugin disabled - SUPERMEMORY_API_KEY not set (tools registered, hooks skipped)");
      return;
    }

    await this.#track(
      this.#ctx.session.hook("context", async (event) => {
        if (!this.active) return;
        await this.handleContext(event);
      }),
    );
    if (!this.active) return;

    await this.#track(
      this.#ctx.session.hook("compaction", async (event) => {
        if (!this.active) return;
        await this.handleCompaction(event);
      }),
    );
    if (!this.active) return;

    // Mirror the V1 `permission.ask` auto-allow: recall is read-only.
    await this.#track(
      this.#ctx.permission.hook("evaluate", (event) => {
        if (!this.active) return;
        if (event.action === RECALL_PERMISSION.action && event.effect === "ask") {
          event.effect = "allow";
        }
      }),
    );
    if (!this.active) return;

    await this.#track(
      this.#ctx.tool.hook("execute.before", (event) => {
        if (!this.active) return;
        this.handleToolBefore(event.tool, event.input);
      }),
    );
    await this.#track(
      this.#ctx.tool.hook("execute.after", (event) => {
        if (!this.active) return;
        if (event.status !== "completed") return;
        this.handleToolAfter(event.tool, toolResultText(event.result.content));
      }),
    );
    if (!this.active) return;

    try {
      const rpc = await this.#ctx.rpc.register(SUPERMEMORY_RPC, {});
      this.#registrations.push(rpc);
      this.#emitActivity = (notice) => {
        void rpc.events
          .emit("activity", {
            kind: notice.kind,
            title: notice.title,
            message: notice.message,
            variant: notice.variant,
            duration: notice.duration,
          })
          .catch((error) => {
            logger("[activity] unable to emit notice", { error: String(error) });
          });
      };
    } catch (error) {
      logger("[activity] RPC unavailable; notices are log-only", {
        error: String(error),
      });
    }

    if (this.active) this.#startEventSubscription();
    logger("v2 plugin registered", {
      tools: [SUPERMEMORY_TOOL_NAME, SUPERMEMORY_RECALL_TOOL_NAME],
      hooks: ["session.context", "session.compaction", "permission.evaluate", "tool.execute"],
      activity: this.#emitActivity ? "rpc" : "log-only",
      recallMode: this.#deps.config.recallMode,
      captureEveryNTurns: this.#deps.config.captureEveryNTurns,
      compactionEnabled: this.#deps.config.compactionEnabled,
    });
  }

  async executeTool(args: SupermemoryToolArgs, sessionID: string): Promise<string> {
    try {
      const tags = await this.#resolveSession(sessionID);
      return await this.#deps.executeTool(args, tags, {
        memoryClient: this.#deps.memoryClient,
        configured: this.#deps.configured,
        onSaved: () => this.#activity.saved(),
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async executeRecallTool(
    args: SupermemoryToolArgs,
    sessionID: string,
  ): Promise<string> {
    if (args.mode && args.mode !== "search") {
      return JSON.stringify({
        success: false,
        error: `${SUPERMEMORY_RECALL_TOOL_NAME} only supports search mode`,
      });
    }
    return this.executeTool({ ...args, mode: "search" }, sessionID);
  }

  handleToolBefore(tool: string, input: unknown): void {
    const args = (input ?? {}) as { mode?: unknown; query?: unknown };
    const isRecall =
      tool === SUPERMEMORY_RECALL_TOOL_NAME ||
      (tool === SUPERMEMORY_TOOL_NAME && args.mode === "search");
    if (!isRecall) return;
    this.#activity.recalling(
      typeof args.query === "string" ? args.query : undefined,
    );
  }

  handleToolAfter(tool: string, output: string): void {
    if (tool !== SUPERMEMORY_TOOL_NAME && tool !== SUPERMEMORY_RECALL_TOOL_NAME) {
      return;
    }
    try {
      const result = JSON.parse(output) as {
        success?: boolean;
        query?: unknown;
        count?: number;
        results?: unknown[];
      };
      if (!result.success || result.query === undefined) return;
      const count = result.count ?? result.results?.length;
      if (typeof count === "number" && count > 0) {
        this.#activity.recalled(count, Math.round(output.length / 4));
      }
    } catch {
      // Tool output remains authoritative when it is not structured JSON.
    }
  }

  async handleContext(event: {
    sessionID: string;
    messages: RequestMessage[];
  }): Promise<void> {
    if (!this.#deps.configured) return;
    const latestUser = event.messages.findLast((message) => message.role === "user");
    if (!latestUser) return;
    const userText = extractMessageText(latestUser);
    if (!userText) return;

    const state = this.#state(event.sessionID);
    const key = this.#dispatchKey(event.messages, latestUser, userText);
    let pending = state.dispatches.get(key);
    if (!pending) {
      pending = this.#buildInjection(event.sessionID, state, userText).catch(
        (error): Injection => {
          this.#deps.logger("v2 context injection failed", {
            sessionID: event.sessionID,
            error: String(error),
          });
          return { start: [], end: [] };
        },
      );
      state.dispatches.set(key, pending);
      state.dispatchOrder.push(key);
      while (state.dispatchOrder.length > MAX_DISPATCHES_PER_SESSION) {
        const oldest = state.dispatchOrder.shift();
        if (oldest) state.dispatches.delete(oldest);
      }
    }

    applyInjection(event.messages, latestUser, await pending);
  }

  async handleCompaction(event: {
    sessionID: string;
    system: Array<{ type: "text"; text: string }>;
  }): Promise<void> {
    if (!this.#deps.configured || !this.#deps.config.compactionEnabled) return;
    const memories = await this.#projectMemories(event.sessionID);
    event.system.push({ type: "text", text: createCompactionPrompt(memories) });
    this.#deps.logger("v2 compaction context injected", {
      sessionID: event.sessionID,
      memoriesCount: memories.length,
    });
  }

  async handleEvent(event: V2Event): Promise<void> {
    if (!this.active || this.#deduper.hasSeen(event.id)) return;
    const sessionID = this.#eventSessionID(event);

    if (sessionID && event.type !== "session.compaction.ended") {
      void this.#retryPendingSummaries(sessionID);
    }

    switch (event.type) {
      case "session.execution.succeeded": {
        if (!sessionID) return;
        void this.#runCaptureExclusive(sessionID, () =>
          this.#captureCadence(sessionID),
        );
        return;
      }

      case "session.execution.interrupted": {
        if (!sessionID || event.data?.reason !== "shutdown") return;
        if (!this.#states.has(sessionID)) return;
        void this.#runCaptureExclusive(sessionID, () =>
          this.#captureSessionEnd(sessionID),
        );
        return;
      }

      case "session.deleted": {
        if (!sessionID) return;
        const state = this.#states.get(sessionID);
        this.#recall.delete(sessionID);
        if (!state) return;
        await this.#runCaptureExclusive(sessionID, () =>
          this.#captureSessionEnd(sessionID),
        );
        this.#states.delete(sessionID);
        return;
      }

      case "session.compaction.ended": {
        if (!sessionID || !this.#deps.config.compactionEnabled) return;
        const text = String(event.data?.text ?? "").trim();
        if (!text) return;
        if (text.length < MIN_SUMMARY_CHARS) {
          this.#deps.logger("v2 compaction summary too short to save", {
            sessionID,
            length: text.length,
          });
          return;
        }
        const eventId = event.id ?? sha256(`${sessionID}:${text}`);
        const customId = `opencode:compaction:${sha256(`${sessionID}:${eventId}`)}`;
        this.#pendingSummaries.set(customId, { customId, sessionID, text });
        await this.#retryPendingSummaries(sessionID);
        return;
      }

      case "global.disposed": {
        await this.#flushAll();
        this.#states.clear();
        this.#recall.clear();
        return;
      }
    }
  }

  /** Waits for background capture and summary work; used by tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#captureInFlight.size > 0 || this.#summaryInFlight.size > 0) {
      await Promise.allSettled([...this.#captureInFlight.values()]);
      if (this.#summaryInFlight.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  cleanup(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#abortController.abort();

    void this.#flushAll(true).catch((error) => {
      this.#deps.logger("v2 cleanup capture failed", { error: String(error) });
    });
    this.#states.clear();
    this.#recall.clear();

    for (const registration of this.#registrations.splice(0)) {
      this.#disposeRegistration(registration);
    }
  }

  async #track(pending: Promise<Registration>): Promise<void> {
    const registration = await pending;
    if (!this.active) {
      this.#disposeRegistration(registration);
      return;
    }
    this.#registrations.push(registration);
  }

  #state(sessionID: string): SessionState {
    const existing = this.#states.get(sessionID);
    if (existing) return existing;
    const state: SessionState = {
      injectedInitialContext: false,
      dispatches: new Map(),
      dispatchOrder: [],
      turns: [],
      turnIndex: new Map(),
      completedCaptureIds: new Set(),
    };
    this.#states.set(sessionID, state);
    return state;
  }

  #inactiveToolResult(): string {
    return JSON.stringify({
      success: false,
      error: "This Supermemory plugin instance has been replaced; retry the call.",
    });
  }

  #disposeRegistration(registration: Registration): void {
    try {
      void registration.dispose().catch((error) => {
        this.#deps.logger("v2 registration cleanup failed", {
          error: String(error),
        });
      });
    } catch (error) {
      this.#deps.logger("v2 registration cleanup failed", {
        error: String(error),
      });
    }
  }

  #dispatchKey(
    messages: RequestMessage[],
    latestUser: RequestMessage,
    text: string,
  ): string {
    const id = (latestUser as { id?: string }).id;
    if (id) return id;
    const userCount = messages.filter((message) => message.role === "user").length;
    return `dispatch:${userCount}:${sha256(text)}`;
  }

  async #resolveSession(sessionID: string): Promise<ResolvedTags> {
    const state = this.#state(sessionID);
    if (state.tags) return state.tags;
    if (state.resolving) return state.resolving;

    state.resolving = (async () => {
      let directory: string | undefined;
      try {
        const session = await this.#ctx.session.get({ sessionID });
        directory = (session as { location?: { directory?: string } }).location
          ?.directory;
      } catch (error) {
        this.#deps.logger("v2 session lookup failed; using plugin location", {
          sessionID,
          error: String(error),
        });
      }
      directory ??= this.#ctx.location?.directory;
      if (!directory) {
        throw new Error(`Unable to resolve directory for OpenCode session ${sessionID}`);
      }
      state.directory = directory;
      state.tags = this.#deps.resolveTags(directory);
      return state.tags;
    })();

    try {
      return await state.resolving;
    } finally {
      state.resolving = undefined;
    }
  }

  async #buildInjection(
    sessionID: string,
    state: SessionState,
    userText: string,
  ): Promise<Injection> {
    const { config, memoryClient } = this.#deps;
    const start: string[] = [];
    const end: string[] = [];
    const isFirstMessage = !state.injectedInitialContext;
    state.injectedInitialContext = true;

    if (detectMemoryKeyword(userText, config.keywordPatterns)) {
      end.push(MEMORY_NUDGE_MESSAGE);
    }
    if (config.recallMode === "advisory") end.push(buildV2RecallDirective());

    let tags: ResolvedTags;
    try {
      tags = await this.#resolveSession(sessionID);
    } catch (error) {
      this.#deps.logger("v2 context skipped; no session directory", {
        sessionID,
        error: String(error),
      });
      return { start, end };
    }

    const profileRequest =
      isFirstMessage && config.recallMode !== "off" && config.injectProfile
        ? memoryClient
            .getProfileScoped(tags.canonical, tags.personalReads, "personal", undefined, {
              timeoutMs: DIRECT_RECALL_TIMEOUT_MS,
            })
            .catch(() => null)
        : Promise.resolve(null);

    const skipped: DirectRecallResult = {
      context: "",
      status: "skipped",
      count: 0,
      tokens: 0,
    };
    const directRecall =
      config.recallMode === "direct"
        ? buildDirectRecallResult({
            prompt: userText,
            sessionID,
            cache: this.#recall,
            search: (query) =>
              memoryClient.searchMemoriesForRecall(
                query,
                tags.canonical,
                tags.personalReads,
                tags.projectReads,
                { timeoutMs: DIRECT_RECALL_TIMEOUT_MS },
              ),
            suppressTexts: isFirstMessage
              ? profileRequest.then((result) =>
                  result?.success && result.profile
                    ? getInjectedProfileFactTexts(result)
                    : [],
                )
              : undefined,
          })
        : Promise.resolve(skipped);

    const firstMessage = isFirstMessage
      ? profileRequest.then((result) =>
          result?.success
            ? formatContextForPrompt(result, { results: [] }, { results: [] })
            : "",
        )
      : Promise.resolve("");

    const updateCheck = isFirstMessage
      ? this.#deps.checkUpdate().catch(() => null)
      : Promise.resolve(null);

    const [recall, firstMessageContext, updateInfo] = await Promise.all([
      directRecall,
      firstMessage,
      updateCheck,
    ]);

    if (recall.status === "recalled") {
      this.#activity.recalled(recall.count, recall.tokens);
    } else if (recall.status === "unavailable") {
      this.#activity.recallUnavailable();
    }
    if (updateInfo) this.#activity.updateAvailable(updateInfo);

    if (firstMessageContext) start.push(firstMessageContext);
    if (recall.context) end.push(recall.context);

    this.#deps.logger("v2 context prepared", {
      sessionID,
      firstMessage: isFirstMessage,
      firstMessageContextLength: firstMessageContext.length,
      directRecallContextLength: recall.context.length,
    });
    return { start, end };
  }

  async #projectMemories(sessionID: string): Promise<string[]> {
    try {
      const tags = await this.#resolveSession(sessionID);
      const result = await this.#deps.memoryClient.listMemoriesScoped(
        tags.canonical,
        tags.projectReads,
        "project",
        this.#deps.config.maxProjectMemories,
      );
      return fitProjectMemories(
        (result.memories ?? [])
          .map((memory) => memory.summary || memory.content || "")
          .filter((memory): memory is string => Boolean(memory)),
      );
    } catch (error) {
      this.#deps.logger("v2 compaction project-memory lookup failed", {
        sessionID,
        error: String(error),
      });
      return [];
    }
  }

  async #refreshTurns(sessionID: string, state: SessionState): Promise<CaptureTurn[]> {
    try {
      const messages = (await this.#ctx.session.context({ sessionID })) as unknown;
      if (Array.isArray(messages)) {
        mergeTurns(
          state.turns,
          state.turnIndex,
          buildTranscriptTurns(messages as TranscriptMessage[]),
        );
      }
    } catch (error) {
      this.#deps.logger("v2 capture transcript read failed; using cached turns", {
        sessionID,
        error: String(error),
      });
    }
    return state.turns;
  }

  async #saveBatch(
    sessionID: string,
    state: SessionState,
    batch: CaptureBatch,
    reason: "cadence" | "session_end",
  ): Promise<boolean> {
    const captureId = getCaptureId(sessionID, batch);
    if (state.completedCaptureIds.has(captureId)) return true;
    const messages = batch.turns.flatMap((turn) => turn.messages);
    if (messages.length === 0) {
      state.completedCaptureIds.add(captureId);
      return true;
    }

    let result: { success: boolean; error?: string };
    try {
      const tags = await this.#resolveSession(sessionID);
      result = await this.#deps.memoryClient.ingestConversation(
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
          timeoutMs: AUTOMATIC_CAPTURE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.success) {
      state.completedCaptureIds.add(captureId);
      this.#activity.saved();
      this.#deps.logger("[capture] conversation batch saved", {
        sessionID,
        reason,
        startTurn: batch.startTurn,
        endTurn: batch.endTurn,
      });
      return true;
    }

    this.#deps.logger("[capture] failed to save conversation batch", {
      sessionID,
      reason,
      startTurn: batch.startTurn,
      endTurn: batch.endTurn,
      error: result.error,
    });
    return false;
  }

  async #captureCadence(sessionID: string): Promise<void> {
    const state = this.#state(sessionID);
    const turns = await this.#refreshTurns(sessionID, state);
    for (const batch of buildCadenceBatches(
      turns,
      this.#deps.config.captureEveryNTurns,
    )) {
      await this.#saveBatch(sessionID, state, batch, "cadence");
    }
  }

  async #captureSessionEnd(sessionID: string): Promise<void> {
    const state = this.#state(sessionID);
    const turns = await this.#refreshTurns(sessionID, state);
    for (const batch of buildCadenceBatches(
      turns,
      this.#deps.config.captureEveryNTurns,
    )) {
      await this.#saveBatch(sessionID, state, batch, "cadence");
    }
    const finalBatch = buildSessionEndBatch(
      turns,
      this.#deps.config.captureEveryNTurns,
    );
    if (finalBatch) {
      await this.#saveBatch(sessionID, state, finalBatch, "session_end");
    }
  }

  async #flushAll(allowInactive = false): Promise<void> {
    const sessions = [...this.#states.keys()];
    const pending = new Set(
      [...this.#pendingSummaries.values()].map((item) => item.sessionID),
    );
    await Promise.all([
      ...sessions.map((sessionID) =>
        this.#runCaptureExclusive(sessionID, () =>
          this.#captureSessionEnd(sessionID),
        ),
      ),
      ...[...pending].map((sessionID) =>
        this.#retryPendingSummaries(sessionID, allowInactive),
      ),
    ]);
  }

  async #runCaptureExclusive(
    sessionID: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.#captureInFlight.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#captureInFlight.set(sessionID, next);
    try {
      await next;
    } catch (error) {
      this.#deps.logger("[capture] background capture failed", {
        sessionID,
        error: String(error),
      });
    } finally {
      if (this.#captureInFlight.get(sessionID) === next) {
        this.#captureInFlight.delete(sessionID);
      }
    }
  }

  async #retryPendingSummaries(
    sessionID: string,
    allowInactive = false,
  ): Promise<void> {
    if (!allowInactive && !this.active) return;
    const pending = [...this.#pendingSummaries.values()].filter(
      (item) => item.sessionID === sessionID,
    );
    if (pending.length === 0) return;

    let tags: ResolvedTags;
    try {
      tags = await this.#resolveSession(sessionID);
    } catch (error) {
      this.#deps.logger("v2 compaction summary retry deferred", {
        sessionID,
        error: String(error),
      });
      return;
    }

    for (const summary of pending) {
      if (this.#summaryInFlight.has(summary.customId)) continue;
      this.#summaryInFlight.add(summary.customId);
      try {
        const result = await this.#deps.memoryClient.addMemory(
          `[Session Summary]\n${summary.text}`,
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
            customId: summary.customId,
            entityContext: AGENT_ENTITY_CONTEXT,
            timeoutMs: AUTOMATIC_CAPTURE_TIMEOUT_MS,
          },
        );
        if (result.success) {
          this.#pendingSummaries.delete(summary.customId);
          this.#activity.saved();
          this.#deps.logger("[compaction] summary saved as memory", {
            sessionID,
            memoryId: result.id,
          });
        } else {
          this.#deps.logger("[compaction] failed to save summary", {
            sessionID,
            error: result.error,
          });
        }
      } catch (error) {
        this.#deps.logger("[compaction] failed to save summary", {
          sessionID,
          error: String(error),
        });
      } finally {
        this.#summaryInFlight.delete(summary.customId);
      }
    }
  }

  #eventSessionID(event: V2Event): string | undefined {
    const sessionID = event.data?.sessionID;
    return typeof sessionID === "string" && sessionID ? sessionID : undefined;
  }

  #startEventSubscription(): void {
    const events = this.#ctx.event.subscribe({
      signal: this.#abortController.signal,
    });
    void (async () => {
      try {
        for await (const event of events as AsyncIterable<V2Event>) {
          if (!this.active) return;
          try {
            await this.handleEvent(event);
          } catch (error) {
            this.#deps.logger("v2 event handling failed", {
              type: event.type,
              error: String(error),
            });
          }
        }
      } catch (error) {
        if (this.active) {
          this.#deps.logger("v2 event subscription failed", {
            error: String(error),
          });
        }
      }
    })();
  }
}

const OWNER_KEY = Symbol.for("opencode-supermemory.v2.owner");

interface GlobalOwner {
  generation: number;
  cleanup: () => void;
}

function ownerRegistry(): Record<symbol, GlobalOwner | undefined> {
  return globalThis as unknown as Record<symbol, GlobalOwner | undefined>;
}

/**
 * Starts the OpenCode 2 runtime. Only one instance is active per process, so a
 * hot-reloaded plugin replaces (and cleans up) the previous generation.
 */
export async function setupV2(
  ctx: V2Context,
  options?: Partial<V2RuntimeDependencies>,
): Promise<() => void> {
  const registry = ownerRegistry();
  const previous = registry[OWNER_KEY];
  previous?.cleanup();

  const owner: GlobalOwner = {
    generation: (previous?.generation ?? 0) + 1,
    cleanup: () => undefined,
  };
  registry[OWNER_KEY] = owner;

  const runtime = new V2Runtime(ctx, options, () => registry[OWNER_KEY] === owner);
  const cleanup = () => {
    runtime.cleanup();
    if (registry[OWNER_KEY] === owner) delete registry[OWNER_KEY];
  };
  owner.cleanup = cleanup;

  log("v2 plugin init", {
    generation: owner.generation,
    directory: ctx.location?.directory,
    configured: runtime["active"] && (options?.configured ?? isConfigured()),
  });

  try {
    await runtime.register();
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
