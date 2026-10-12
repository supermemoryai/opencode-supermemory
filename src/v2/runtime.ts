import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { Plugin } from "@opencode/plugin";
import type { SessionHooks } from "@opencode/plugin/promise/session";

import { CONFIG, getApiBaseUrl, getApiVersion, isConfigured, PLUGIN_VERSION, SUPERMEMORY_API_KEY } from "../config.js";
import {
  createMemoryActivityReporterFromSink,
  type MemoryActivityNotice,
  type MemoryActivityReporter,
} from "../services/activity.js";
import {
  AUTOMATIC_CAPTURE_TIMEOUT_MS,
  buildCadenceBatches,
  buildSessionEndBatch,
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
import { planCapture } from "./capture-plan.js";
import { parseCaptureAcknowledgements, parseCaptureQueue, queueCaptureGroup, type PendingCaptureGroup } from "./capture-queue.js";

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
> & Partial<Pick<SupermemoryClient, "getCaptureDestination">>;

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

export interface V2Event {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
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
  deleted?: boolean;
  tags?: ResolvedTags;
  resolving?: Promise<ResolvedTags>;
  injectedInitialContext: boolean;
  dispatches: Map<string, Promise<Injection>>;
  dispatchOrder: string[];
  turns: CaptureTurn[];
  turnIndex: Map<string, number>;
  acknowledgedCaptureIds: Set<string>;
  acknowledgedTurnFingerprints: Set<string>;
  captureLedgerLoaded?: Promise<void>;
  captureLedgerKey?: string;
  legacyCaptureLedgerKey?: string;
  captureLedgerDirty: boolean;
  pendingCaptures: Map<string, PendingCaptureGroup>;
  pendingCaptureKey?: string;
  pendingCaptureAccount?: string;
  pendingCaptureDirty: boolean;
}

interface PendingSummary {
  customId: string;
  sessionID: string;
  text: string;
}

interface CaptureHandoff {
  version?: 2;
  account?: string;
  sessions: Array<{
    sessionID: string;
    directory?: string;
    deleted?: boolean;
    tags?: ResolvedTags;
    turns: CaptureTurn[];
    captureIds: string[];
    turnFingerprints: string[];
    ledgerKey?: string;
    legacyLedgerKey?: string;
    dirty: boolean;
    pending?: PendingCaptureGroup[];
    pendingKey?: string;
    pendingAccount?: string;
    pendingDirty?: boolean;
  }>;
  summaries: PendingSummary[];
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

function normalizeDirectory(directory: string): string {
  const normalized = resolve(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
  readonly #summaryTasks = new Map<string, Promise<void>>();
  readonly #deduper = new EventDeduper();
  readonly #sessionOwners = new Map<string, boolean>();
  readonly #ownerLookups = new Map<string, Promise<boolean>>();
  readonly #registrations: Registration[] = [];
  readonly #registrationTasks = new Set<Promise<void>>();
  readonly #abortController = new AbortController();
  readonly #captureAccount = sha256(SUPERMEMORY_API_KEY ?? "unconfigured");
  #emitActivity: ((notice: MemoryActivityNotice) => void) | undefined;
  #activity: MemoryActivityReporter;
  #active = true;
  #cleanup: Promise<void> | undefined;
  #recoveryTask: Promise<void> | undefined;

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
    if (!this.active) return;
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
      const pending = this.#ctx.rpc.register(SUPERMEMORY_RPC, {});
      await this.#track(pending);
      const rpc = await pending;
      if (!this.active) return;
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

    if (this.active) {
      this.#startEventSubscription();
      const task = this.#restorePendingSessions();
      this.#recoveryTask = task;
      void task.finally(() => {
        if (this.#recoveryTask === task) this.#recoveryTask = undefined;
      }).catch(() => logger("[capture] pending recovery deferred; originals retained"));
    }
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

    const injection = await pending;
    if (this.active) applyInjection(event.messages, latestUser, injection);
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

    if (!sessionID && event.location?.directory &&
        normalizeDirectory(event.location.directory) !== normalizeDirectory(this.#ctx.location.directory)) return;
    if (sessionID && !(await this.#ownsSession(sessionID, event))) return;
    if (!this.active) return;

    const summaryWork = sessionID && event.type !== "session.compaction.ended"
      ? this.#retryPendingSummaries(sessionID)
      : undefined;

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
        await summaryWork;
        const state = this.#states.get(sessionID);
        this.#recall.delete(sessionID);
        if (!state) return;
        state.deleted = true;
        if (state.pendingCaptures.size > 0) state.pendingCaptureDirty = true;
        if (await this.#finishSession(sessionID)) {
          this.#states.delete(sessionID);
          this.#sessionOwners.delete(sessionID);
        }
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
        await this.idle();
        const unfinished = await this.#flushAll();
        for (const sessionID of this.#states.keys()) {
          if (!unfinished.has(sessionID)) this.#states.delete(sessionID);
        }
        this.#recall.clear();
        return;
      }
    }
  }

  /** Waits for background capture and summary work; used by tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#captureInFlight.size > 0 || this.#summaryTasks.size > 0 || this.#recoveryTask) {
      await Promise.allSettled([
        ...this.#captureInFlight.values(), ...this.#summaryTasks.values(),
        ...(this.#recoveryTask ? [this.#recoveryTask] : []),
      ]);
    }
  }

  cleanup(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    this.#active = false;
    this.#abortController.abort();
    const registrations = this.#registrations.splice(0);
    this.#cleanup = (async () => {
      await Promise.allSettled(this.#registrationTasks);
      const disposals = await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      for (const result of disposals) {
        if (result.status === "rejected") {
          this.#deps.logger("v2 registration cleanup failed", { error: String(result.reason) });
        }
      }
      await this.idle();
      const unfinished = await this.#flushAll(true);
      for (const sessionID of this.#states.keys()) {
        if (!unfinished.has(sessionID)) this.#states.delete(sessionID);
      }
      this.#recall.clear();
    })().catch((error) => {
      this.#deps.logger("v2 cleanup capture failed", { error: String(error) });
    });
    return this.#cleanup;
  }

  async #track(pending: Promise<Registration>): Promise<void> {
    const task = (async () => {
      const registration = await pending;
      if (!this.active) {
        await registration.dispose();
        return;
      }
      this.#registrations.push(registration);
    })();
    this.#registrationTasks.add(task);
    try { await task; } finally { this.#registrationTasks.delete(task); }
  }

  takeCaptureState(): CaptureHandoff {
    const snapshot: CaptureHandoff = {
      version: 2,
      account: this.#captureAccount,
      sessions: [...this.#states].map(([sessionID, state]) => ({
        sessionID,
        directory: state.directory,
        deleted: state.deleted,
        tags: state.tags,
        turns: state.turns,
        captureIds: [...state.acknowledgedCaptureIds],
        turnFingerprints: [...state.acknowledgedTurnFingerprints],
        ledgerKey: state.captureLedgerKey,
        legacyLedgerKey: state.legacyCaptureLedgerKey,
        dirty: state.captureLedgerDirty,
        pending: [...state.pendingCaptures.values()],
        pendingKey: state.pendingCaptureKey,
        pendingAccount: state.pendingCaptureAccount,
        pendingDirty: state.pendingCaptureDirty,
      })),
      summaries: [...this.#pendingSummaries.values()],
    };
    this.#states.clear();
    this.#pendingSummaries.clear();
    return snapshot;
  }

  inheritCaptureState(snapshot: CaptureHandoff): void {
    for (const source of snapshot.sessions) {
      const state = this.#state(source.sessionID);
      state.directory = source.directory;
      state.deleted = source.deleted;
      state.tags = source.tags;
      state.turns = source.turns;
      state.turnIndex = new Map(source.turns.map((turn, index) => [turn.id, index]));
      state.acknowledgedCaptureIds = new Set(source.captureIds.filter((id) =>
        snapshot.version === 2 || id.startsWith("opencode:compaction:")));
      state.acknowledgedTurnFingerprints = new Set(source.turnFingerprints);
      state.captureLedgerKey = snapshot.version === 2 ? source.ledgerKey : undefined;
      state.legacyCaptureLedgerKey = snapshot.version === 2 ? source.legacyLedgerKey : source.ledgerKey;
      state.captureLedgerDirty = source.dirty;
      state.pendingCaptures = new Map((source.pending ?? []).map((group) => [group.id, group]));
      state.pendingCaptureKey = source.pendingKey;
      state.pendingCaptureAccount = source.pendingAccount ?? snapshot.account;
      state.pendingCaptureDirty = source.pendingDirty ?? false;
    }
    for (const summary of snapshot.summaries) this.#pendingSummaries.set(summary.customId, summary);
  }

  async #ownsSession(sessionID: string, event: V2Event): Promise<boolean> {
    const directory = event.location?.directory;
    if (directory) {
      const owned = normalizeDirectory(directory) === normalizeDirectory(this.#ctx.location.directory);
      return this.#rememberSessionOwner(sessionID, owned);
    }
    const known = this.#sessionOwners.get(sessionID);
    if (known !== undefined) return known;
    const pending = this.#ownerLookups.get(sessionID);
    if (pending) return pending;
    const lookup = (async () => {
      try {
        const session = await this.#ctx.session.get({ sessionID });
        const owned = normalizeDirectory(session.location.directory) ===
          normalizeDirectory(this.#ctx.location.directory);
        return this.#rememberSessionOwner(sessionID, owned);
      } catch (error) {
        this.#deps.logger("v2 session owner lookup failed; skipping event", {
          sessionID, error: String(error),
        });
        return false;
      } finally {
        this.#ownerLookups.delete(sessionID);
      }
    })();
    this.#ownerLookups.set(sessionID, lookup);
    return lookup;
  }

  #rememberSessionOwner(sessionID: string, owned: boolean): boolean {
    this.#sessionOwners.delete(sessionID);
    this.#sessionOwners.set(sessionID, owned);
    while (this.#sessionOwners.size > 1024) {
      this.#sessionOwners.delete(this.#sessionOwners.keys().next().value!);
    }
    return owned;
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
      acknowledgedCaptureIds: new Set(),
      acknowledgedTurnFingerprints: new Set(),
      captureLedgerDirty: false,
      pendingCaptures: new Map(),
      pendingCaptureDirty: false,
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
      if (normalizeDirectory(directory) !== normalizeDirectory(this.#ctx.location.directory)) {
        throw new Error(`OpenCode session ${sessionID} belongs to another location`);
      }
      this.#rememberSessionOwner(sessionID, true);
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
      const session = await this.#ctx.session.get({ sessionID });
      if (normalizeDirectory(session.location.directory) !== normalizeDirectory(this.#ctx.location.directory)) {
        return state.turns;
      }
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

  #queueBatch(
    sessionID: string,
    state: SessionState,
    batch: CaptureBatch,
    reason: "cadence" | "session_end",
  ): void {
    const queued = new Set([...state.pendingCaptures.values()].flatMap((group) => group.turnFingerprints));
    const remaining = batch.turns.filter((turn) => {
      const fingerprint = sha256(JSON.stringify(turn));
      return turn.messages.length > 0 && !state.acknowledgedTurnFingerprints.has(fingerprint) && !queued.has(fingerprint);
    });
    if (remaining.length === 0) return;
    const positions = remaining.map((turn) => batch.startTurn + batch.turns.indexOf(turn));
    batch = {
      startTurn: batch.startTurn + batch.turns.indexOf(remaining[0]!),
      endTurn: batch.startTurn + batch.turns.indexOf(remaining.at(-1)!),
      turns: remaining,
    };
    const groups = planCapture(sessionID, batch, positions);
    for (const planned of groups) {
      const group = queueCaptureGroup(planned, reason);
      if (!state.pendingCaptures.has(group.id)) {
        state.pendingCaptures.set(group.id, group);
        state.pendingCaptureAccount = this.#captureAccount;
        state.pendingCaptureDirty = true;
      }
    }
  }

  async #drainCaptureQueue(sessionID: string, state: SessionState): Promise<boolean> {
    await this.#persistCaptureLedger(sessionID, state);
    if (!(await this.#persistPendingCaptures(sessionID, state))) return false;
    const tags = await this.#resolveSession(sessionID);
    let complete = true;
    for (const group of [...state.pendingCaptures.values()]) {
      const reason = group.reason;
      for (const piece of group.pieces) {
        if (state.acknowledgedCaptureIds.has(piece.acknowledgedId)) continue;
        await this.#persistCaptureLedger(sessionID, state);
        if (!(await this.#persistPendingCaptures(sessionID, state))) return false;
        if (state.acknowledgedCaptureIds.has(piece.acknowledgedId)) continue;
        let result: { success: boolean; error?: string; submittedMessageCount?: number };
        try {
          this.#captureDestination();
          result = await this.#deps.memoryClient.ingestConversation(
            piece.conversationId,
            piece.messages,
            [tags.canonical],
            {
              project: tags.projectName,
              sm_project_id: tags.projectId,
              sm_scope: "personal",
              sm_capture_mode: "automatic",
              captureReason: reason,
              sessionId: sessionID,
              turnStart: piece.startTurn,
              turnEnd: piece.endTurn,
              ...piece.metadata,
            },
            {
              defaultEntityContext: AGENT_ENTITY_CONTEXT,
              customId: piece.id,
              timeoutMs: AUTOMATIC_CAPTURE_TIMEOUT_MS,
              requireComplete: true,
              preserveWhitespace: piece.preserveWhitespace,
            },
          );
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (result.success &&
            (result.submittedMessageCount ?? piece.messages.length) === piece.messages.length) {
          state.acknowledgedCaptureIds.add(piece.acknowledgedId);
          state.captureLedgerDirty = true;
          await this.#persistCaptureLedger(sessionID, state);
          this.#deps.logger("[capture] conversation piece saved", {
            sessionID, reason, captureId: piece.id,
            startTurn: piece.startTurn, endTurn: piece.endTurn,
          });
        } else {
          this.#deps.logger("[capture] failed to save complete conversation piece", {
            sessionID, reason, captureId: piece.id,
          });
        }
      }
      await this.#persistCaptureLedger(sessionID, state);
      if (!state.captureLedgerDirty) {
        const pending = group.pieces.filter((piece) => !state.acknowledgedCaptureIds.has(piece.acknowledgedId));
        if (pending.length !== group.pieces.length) {
          group.pieces = pending;
          state.pendingCaptureDirty = true;
          if (!(await this.#persistPendingCaptures(sessionID, state))) return false;
        }
      }
      if (group.pieceIds.every((id) => state.acknowledgedCaptureIds.has(id))) {
        const newlyComplete = group.turnFingerprints.some((fingerprint) => !state.acknowledgedTurnFingerprints.has(fingerprint));
        for (const fingerprint of group.turnFingerprints) state.acknowledgedTurnFingerprints.add(fingerprint);
        state.captureLedgerDirty = true;
        await this.#persistCaptureLedger(sessionID, state);
        if (newlyComplete) this.#activity.saved();
        if (!state.captureLedgerDirty) {
          state.pendingCaptures.delete(group.id);
          state.pendingCaptureDirty = true;
          if (!(await this.#persistPendingCaptures(sessionID, state))) return false;
        }
      } else {
        complete = false;
      }
    }
    return complete && !state.captureLedgerDirty && !state.pendingCaptureDirty;
  }

  async #loadCaptureLedger(sessionID: string, state: SessionState): Promise<void> {
    const destination = this.#captureDestination();
    if (!this.#ctx.storage) return;
    state.captureLedgerLoaded ??= (async () => {
      const tags = await this.#resolveSession(sessionID);
      if (tags.canonical !== this.#deps.resolveTags(this.#ctx.location.directory).canonical) {
        throw new Error("Capture namespace context changed; pending originals retained");
      }
      const scope = sha256(JSON.stringify([
        destination.baseUrl, destination.apiVersion, normalizeDirectory(state.directory!),
        tags.canonical, sessionID,
      ]));
      const previousKeys = [state.captureLedgerKey, state.legacyCaptureLedgerKey];
      const hasProgress = state.pendingCaptures.size > 0 || state.acknowledgedCaptureIds.size > 0 ||
        state.acknowledgedTurnFingerprints.size > 0 || state.captureLedgerDirty || state.pendingCaptureDirty ||
        [...this.#pendingSummaries.values()].some((summary) => summary.sessionID === sessionID);
      if (hasProgress &&
          ((state.pendingCaptureAccount !== undefined && state.pendingCaptureAccount !== this.#captureAccount) ||
           previousKeys.some((key) => key !== undefined && key !== `capture-acks:v2:${scope}` && key !== `capture-acks:v1:${scope}`))) {
        throw new Error("Capture progress destination or credential context changed; originals retained");
      }
      state.captureLedgerKey = `capture-acks:v2:${scope}`;
      state.legacyCaptureLedgerKey = `capture-acks:v1:${scope}`;
      const read = async (key: string, version: 1 | 2) => parseCaptureAcknowledgements(
        await this.#ctx.storage.get(key), scope, this.#captureAccount, version,
      );
      const current = await read(state.captureLedgerKey, 2);
      const saved = current ?? await read(state.legacyCaptureLedgerKey, 1);
      if (saved) {
        for (const id of saved.captureIds) {
          if (current || id.startsWith("opencode:compaction:")) state.acknowledgedCaptureIds.add(id);
        }
        for (const id of saved.turnIds) state.acknowledgedTurnFingerprints.add(id);
        if (!current) state.captureLedgerDirty = true;
      }
      await this.#loadPendingCaptures(sessionID, state, scope);
    })();
    try {
      await state.captureLedgerLoaded;
    } catch (error) {
      state.captureLedgerLoaded = undefined;
      throw error;
    }
  }

  async #persistCaptureLedger(sessionID: string, state: SessionState): Promise<void> {
    if (!this.#ctx.storage) {
      state.captureLedgerDirty = false;
      return;
    }
    if (!state.captureLedgerKey) return;
    const scope = state.captureLedgerKey.slice("capture-acks:v2:".length);
    const saved = parseCaptureAcknowledgements(await this.#ctx.storage.get(state.captureLedgerKey), scope, this.#captureAccount, 2);
    const captureIds = new Set(saved?.captureIds ?? []);
    const turnIds = new Set(saved?.turnIds ?? []);
    if ([...state.acknowledgedCaptureIds].some((id) => !captureIds.has(id)) ||
        [...state.acknowledgedTurnFingerprints].some((id) => !turnIds.has(id))) state.captureLedgerDirty = true;
    for (const id of captureIds) state.acknowledgedCaptureIds.add(id);
    for (const id of turnIds) state.acknowledgedTurnFingerprints.add(id);
    if (!state.captureLedgerDirty) return;
    try {
      await this.#ctx.storage.set(state.captureLedgerKey, {
        version: 2,
        account: this.#captureAccount,
        scope,
        captureIds: [...state.acknowledgedCaptureIds],
        turnIds: [...state.acknowledgedTurnFingerprints],
      });
      state.captureLedgerDirty = false;
    } catch {
      this.#deps.logger("[capture] acknowledgement persistence failed; retaining in-memory ACKs", {
        sessionID,
      });
    }
  }

  #pendingProjectPrefix(): string {
    return `capture-pending:v1:${sha256(normalizeDirectory(this.#ctx.location.directory))}:`;
  }

  #captureDestination(): { baseUrl: string; apiVersion: "legacy" | "v5" } {
    const current = { baseUrl: getApiBaseUrl(), apiVersion: getApiVersion(), account: this.#captureAccount };
    if (this.#ctx.storage && !this.#deps.memoryClient.getCaptureDestination) {
      throw new Error("Capture transport provenance unavailable; originals retained");
    }
    const bound = this.#deps.memoryClient.getCaptureDestination?.() ?? current;
    if (current.baseUrl !== bound.baseUrl || current.apiVersion !== bound.apiVersion || current.account !== bound.account) {
      throw new Error("Capture destination changed; reinitialize the client before retrying; originals retained");
    }
    return bound;
  }

  async #loadPendingCaptures(sessionID: string, state: SessionState, scope: string): Promise<void> {
    const prefix = `${this.#pendingProjectPrefix()}${sha256(sessionID)}:`;
    const key = `${prefix}${scope}`;
    if (state.pendingCaptures.size > 0 &&
        ((state.pendingCaptureKey !== undefined && state.pendingCaptureKey !== key) ||
         (state.pendingCaptureAccount !== undefined && state.pendingCaptureAccount !== this.#captureAccount))) {
      throw new Error("Pending capture destination or credential context changed; originals retained");
    }
    state.pendingCaptureKey = key;
    state.pendingCaptureAccount = this.#captureAccount;
    let after: string | undefined;
    do {
      const page = await this.#ctx.storage.scan({ prefix, after });
      for (const entry of page.entries) {
        if (entry.key !== key) throw new Error("Pending capture destination changed; originals retained");
        const saved = parseCaptureQueue(entry.value, scope, this.#captureAccount, sessionID, state.acknowledgedCaptureIds);
        state.deleted ||= saved.deleted;
        for (const group of saved.groups) {
          if (!state.pendingCaptures.has(group.id)) state.pendingCaptures.set(group.id, group);
        }
      }
      after = page.next;
    } while (after);
  }

  async #persistPendingCaptures(sessionID: string, state: SessionState): Promise<boolean> {
    if (!this.#ctx.storage) {
      state.pendingCaptureDirty = false;
      return true;
    }
    if (!state.pendingCaptureKey || !state.captureLedgerKey) return false;
    try {
      const scope = state.captureLedgerKey.slice("capture-acks:v2:".length);
      const progress = parseCaptureAcknowledgements(await this.#ctx.storage.get(state.captureLedgerKey), scope, this.#captureAccount, 2);
      const durableIds = new Set(progress?.captureIds ?? []);
      const durableTurns = new Set(progress?.turnIds ?? []);
      const original = await this.#ctx.storage.get(state.pendingCaptureKey);
      if (original !== undefined) {
        const saved = parseCaptureQueue(original, scope, this.#captureAccount, sessionID, durableIds);
        if (saved.groups.some((group) => !state.pendingCaptures.has(group.id) &&
            (!group.pieceIds.every((id) => durableIds.has(id)) ||
             !group.turnFingerprints.every((id) => durableTurns.has(id))))) {
          throw new Error("Pending group completion is not durably committed; originals retained");
        }
      }
      if (!state.pendingCaptureDirty) return true;
      if (state.pendingCaptures.size === 0) {
        await this.#ctx.storage.remove(state.pendingCaptureKey);
      } else {
        const value = {
          version: 1,
          scope,
          account: this.#captureAccount,
          sessionID,
          deleted: state.deleted === true,
          groups: [...state.pendingCaptures.values()],
        };
        parseCaptureQueue(value, value.scope, value.account, sessionID, durableIds);
        await this.#ctx.storage.set(state.pendingCaptureKey, JSON.parse(JSON.stringify(value)));
      }
      state.pendingCaptureDirty = false;
      return true;
    } catch {
      this.#deps.logger("[capture] pending checkpoint failed; retaining selected content", {
        sessionID,
      });
      return false;
    }
  }

  async #restorePendingSessions(): Promise<void> {
    if (!this.#ctx.storage) return;
    const prefix = this.#pendingProjectPrefix();
    let after: string | undefined;
    do {
      const page = await this.#ctx.storage.scan({ prefix, after });
      for (const entry of page.entries) {
        if (!this.active) return;
        try {
          const value = entry.value as Record<string, unknown> | null;
          if (!value || typeof value.sessionID !== "string" || value.sessionID.length === 0 || value.sessionID.length > 1024 ||
              !entry.key.startsWith(`${prefix}${sha256(value.sessionID)}:`)) {
            throw new Error("Invalid pending capture identity; originals retained");
          }
          const sessionID = value.sessionID;
          const state = this.#state(sessionID);
          state.directory ??= this.#ctx.location.directory;
          state.tags ??= this.#deps.resolveTags(this.#ctx.location.directory);
          await this.#finishSession(sessionID, { queuedOnly: true, forgetWhenComplete: true });
        } catch {
          this.#deps.logger("[capture] stored pending recovery deferred; originals retained");
        }
      }
      after = page.next;
    } while (after);
  }

  async #captureCadence(sessionID: string): Promise<void> {
    const state = this.#state(sessionID);
    await this.#loadCaptureLedger(sessionID, state);
    await this.#persistCaptureLedger(sessionID, state);
    const turns = await this.#refreshTurns(sessionID, state);
    for (const batch of buildCadenceBatches(
      turns,
      this.#deps.config.captureEveryNTurns,
    )) {
      this.#queueBatch(sessionID, state, batch, "cadence");
    }
    await this.#drainCaptureQueue(sessionID, state);
  }

  async #captureSessionEnd(sessionID: string): Promise<boolean> {
    const state = this.#state(sessionID);
    await this.#loadCaptureLedger(sessionID, state);
    await this.#persistCaptureLedger(sessionID, state);
    const turns = await this.#refreshTurns(sessionID, state);
    for (const batch of buildCadenceBatches(
      turns,
      this.#deps.config.captureEveryNTurns,
    )) {
      this.#queueBatch(sessionID, state, batch, "cadence");
    }
    const finalBatch = buildSessionEndBatch(
      turns,
      this.#deps.config.captureEveryNTurns,
    );
    if (finalBatch) {
      this.#queueBatch(sessionID, state, finalBatch, "session_end");
    }
    const complete = await this.#drainCaptureQueue(sessionID, state);
    return complete && !state.captureLedgerDirty && !state.pendingCaptureDirty && state.pendingCaptures.size === 0;
  }

  async #finishSession(
    sessionID: string,
    options: { allowInactive?: boolean; queuedOnly?: boolean; forgetWhenComplete?: boolean } = {},
  ): Promise<boolean> {
    await this.#retryPendingSummaries(sessionID, options.allowInactive);
    let complete = false;
    await this.#runCaptureExclusive(sessionID, async () => {
      if (options.queuedOnly) {
        const state = this.#state(sessionID);
        await this.#loadCaptureLedger(sessionID, state);
        await this.#persistCaptureLedger(sessionID, state);
        if (!(await this.#drainCaptureQueue(sessionID, state))) return;
      } else if (!(await this.#captureSessionEnd(sessionID))) return;
      if ([...this.#pendingSummaries.values()].some((item) => item.sessionID === sessionID)) return;
      const state = this.#state(sessionID);
      if (state.deleted && state.captureLedgerKey && this.#ctx.storage) {
        const scope = state.captureLedgerKey.slice("capture-acks:v2:".length);
        parseCaptureAcknowledgements(await this.#ctx.storage.get(state.captureLedgerKey), scope, this.#captureAccount, 2);
        if (state.legacyCaptureLedgerKey) {
          parseCaptureAcknowledgements(await this.#ctx.storage.get(state.legacyCaptureLedgerKey), scope, this.#captureAccount, 1);
        }
        await this.#ctx.storage.remove(state.captureLedgerKey);
        if (state.legacyCaptureLedgerKey) await this.#ctx.storage.remove(state.legacyCaptureLedgerKey);
      }
      complete = true;
      if (options.forgetWhenComplete && this.#states.get(sessionID) === state &&
          state.pendingCaptures.size === 0 && !state.captureLedgerDirty && !state.pendingCaptureDirty) {
        this.#states.delete(sessionID);
        this.#recall.delete(sessionID);
      }
    });
    return complete;
  }

  async #flushAll(allowInactive = false): Promise<Set<string>> {
    const sessions = new Set([
      ...this.#states.keys(),
      ...[...this.#pendingSummaries.values()].map((item) => item.sessionID),
    ]);
    const unfinished = new Set(sessions);
    await Promise.all([...sessions].map(async (sessionID) => {
      if (await this.#finishSession(sessionID, { allowInactive })) unfinished.delete(sessionID);
    }));
    return unfinished;
  }

  async #runCaptureExclusive(
    sessionID: string,
    task: () => Promise<unknown>,
  ): Promise<void> {
    const previous = this.#captureInFlight.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => { await task(); });
    this.#captureInFlight.set(sessionID, next);
    try {
      await next;
    } catch {
      this.#deps.logger("[capture] background capture failed", {
        sessionID,
      });
    } finally {
      if (this.#captureInFlight.get(sessionID) === next) {
        this.#captureInFlight.delete(sessionID);
      }
    }
  }

  #retryPendingSummaries(sessionID: string, allowInactive = false): Promise<void> {
    const previous = this.#summaryTasks.get(sessionID);
    if (previous) return previous;
    const task = this.#savePendingSummaries(sessionID, allowInactive);
    this.#summaryTasks.set(sessionID, task);
    void task.finally(() => {
      if (this.#summaryTasks.get(sessionID) === task) this.#summaryTasks.delete(sessionID);
    }).catch(() => undefined);
    return task;
  }

  async #savePendingSummaries(
    sessionID: string,
    allowInactive = false,
  ): Promise<void> {
    if (!allowInactive && !this.active) return;
    const pending = [...this.#pendingSummaries.values()].filter(
      (item) => item.sessionID === sessionID,
    );
    if (pending.length === 0) return;

    let tags: ResolvedTags;
    const state = this.#state(sessionID);
    try {
      tags = await this.#resolveSession(sessionID);
      await this.#loadCaptureLedger(sessionID, state);
    } catch (error) {
      this.#deps.logger("v2 compaction summary retry deferred", {
        sessionID,
        error: String(error),
      });
      return;
    }

    for (const summary of pending) {
      const acknowledgedId = `${summary.customId}:${sha256(summary.text)}`;
      if (state.acknowledgedCaptureIds.has(acknowledgedId)) {
        this.#pendingSummaries.delete(summary.customId);
        continue;
      }
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
          await this.#runCaptureExclusive(sessionID, async () => {
            state.acknowledgedCaptureIds.add(acknowledgedId);
            state.captureLedgerDirty = true;
            await this.#persistCaptureLedger(sessionID, state);
          });
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

const OWNER_REGISTRY_KEY = Symbol.for("opencode-supermemory.v2.owners");

interface GlobalOwner {
  generation: number;
  cleanup: () => Promise<void>;
  runtime?: V2Runtime;
}

function ownerRegistry(): Map<string, GlobalOwner> {
  const global = globalThis as unknown as Record<symbol, Map<string, GlobalOwner> | undefined>;
  return global[OWNER_REGISTRY_KEY] ??= new Map();
}

// Replacements finish disposal and capture before the same location can register again.
export async function setupV2(
  ctx: V2Context,
  options?: Partial<V2RuntimeDependencies>,
): Promise<() => Promise<void>> {
  const registry = ownerRegistry();
  const directory = normalizeDirectory(ctx.location.directory);
  const previous = registry.get(directory);

  const owner: GlobalOwner = {
    generation: (previous?.generation ?? 0) + 1,
    cleanup: async () => undefined,
  };
  registry.set(directory, owner);

  const runtime = new V2Runtime(ctx, options, () => registry.get(directory) === owner);
  owner.runtime = runtime;
  const predecessor = previous?.cleanup() ?? Promise.resolve();
  const cleanup = async () => {
    await predecessor;
    await runtime.cleanup();
    if (registry.get(directory) === owner && runtime.trackedSessionCount === 0) registry.delete(directory);
  };
  owner.cleanup = cleanup;
  await predecessor;
  if (previous?.runtime) runtime.inheritCaptureState(previous.runtime.takeCaptureState());

  log("v2 plugin init", {
    generation: owner.generation,
    directory: ctx.location?.directory,
    configured: runtime["active"] && (options?.configured ?? isConfigured()),
  });

  try {
    await runtime.register();
  } catch (error) {
    await cleanup();
    throw error;
  }

  return cleanup;
}
