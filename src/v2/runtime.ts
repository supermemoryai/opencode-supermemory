import { createHash } from "node:crypto";

import type { Message } from "@opencode-ai/ai";
import type { Context as PluginContext } from "@opencode-ai/plugin/promise/plugin";

import { CONFIG, isConfigured, PLUGIN_VERSION } from "../config.js";
import {
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
} from "../services/compaction.js";
import { formatContextForPrompt } from "../services/context.js";
import { AGENT_ENTITY_CONTEXT } from "../services/entity-context.js";
import { log } from "../services/logger.js";
import {
  executeSupermemoryTool,
  type SupermemoryToolArgs,
} from "../services/memory-tool.js";
import { isFullyPrivate, stripPrivateContent } from "../services/privacy.js";
import { buildRecallDirective } from "../services/recall.js";
import { getTags, type ResolvedTags } from "../services/tags.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;
const COMPACTION_CONTEXT_MARKER = "[SUPERMEMORY COMPACTION CONTEXT]";
const SYNTHETIC_METADATA_KEY = "supermemoryV2";
const UPDATE_COMMAND = "bunx opencode-supermemory@latest install";

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
    mode: {
      type: "string",
      enum: ["add", "search", "profile", "list", "forget", "help"],
    },
    content: { type: "string" },
    query: { type: "string" },
    type: {
      type: "string",
      enum: [
        "project-config",
        "architecture",
        "error-solution",
        "preference",
        "learned-pattern",
        "conversation",
      ],
    },
    scope: { type: "string", enum: ["user", "project"] },
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
    scope: { type: "string", enum: ["user", "project"] },
    limit: { type: "number" },
  },
  required: ["query"],
} as const;

const SUPERMEMORY_DESCRIPTION =
  "Manage and query the Supermemory persistent memory system. Use 'search' to find relevant memories, 'add' to store new knowledge, 'profile' to view user profile, 'list' to see recent memories, 'forget' to remove a memory.";

const SUPERMEMORY_RECALL_DESCRIPTION =
  "Search saved Supermemory context. This least-privilege helper only accepts search operations.";

type RuntimeMemoryClient = Pick<
  SupermemoryClient,
  | "addMemory"
  | "ingestConversation"
  | "getProfileScoped"
  | "searchMemoriesScoped"
  | "listMemoriesScoped"
  | "searchMemoriesMany"
  | "deleteMemory"
>;

type RuntimeConfig = Pick<
  typeof CONFIG,
  | "autoRecallEveryPrompt"
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
  getUpdateNotice: () => Promise<string | null>;
}

const DEFAULT_DEPENDENCIES: V2RuntimeDependencies = {
  configured: isConfigured(),
  config: CONFIG,
  memoryClient: supermemoryClient,
  executeTool: executeSupermemoryTool,
  resolveTags: getTags,
  logger: log,
  getUpdateNotice: async () => {
    const info = await checkNpmUpdate(
      "opencode-supermemory",
      PLUGIN_VERSION,
      UPDATE_COMMAND,
    );
    return info ? formatUpdateNotice(info) : null;
  },
};

interface V2Event {
  id?: string;
  type: string;
  created?: number;
  data?: Record<string, unknown>;
}

interface CachedMessage {
  id: string;
  role: string;
  contextText: string;
  streamText: Map<number, string>;
}

interface SessionState {
  messages: Map<string, CachedMessage>;
  order: string[];
  completedUsers: Set<string>;
  completedCaptureIds: Set<string>;
  injectedInitialContext: boolean;
  lastInjectedDispatch?: string;
  compactionNeedsContext: boolean;
  directory?: string;
  tags?: ResolvedTags;
  resolving?: Promise<ResolvedTags>;
}

interface PendingSummary {
  customId: string;
  eventId: string;
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

export function buildV2RecallDirective(
  directive: string = buildRecallDirective(),
): string {
  return directive.replaceAll("`supermemory`", "`supermemory_recall`");
}

function isSyntheticPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const metadata = (part as { metadata?: Record<string, unknown> }).metadata;
  return Boolean(metadata?.[SYNTHETIC_METADATA_KEY]);
}

function extractMessageText(message: Message): string {
  return message.content
    .filter(
      (part): part is Message["content"][number] & { type: "text"; text: string } =>
        part.type === "text" &&
        typeof part.text === "string" &&
        !isSyntheticPart(part),
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function messageKey(
  message: Message,
  text: string,
  occurrence: number,
): string {
  if (message.id) return message.id;
  return `context:${message.role}:${sha256(text).slice(0, 24)}:${occurrence}`;
}

function cachedText(message: CachedMessage): string {
  if (message.streamText.size === 0) return message.contextText;
  return [...message.streamText.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("\n")
    .trim();
}

function sanitizeCaptureText(text: string): string {
  if (!text || isFullyPrivate(text)) return "";
  return stripPrivateContent(text).trim();
}

export function buildCachedCaptureTurns(
  messages: Map<string, CachedMessage>,
  order: readonly string[],
  completedUsers: ReadonlySet<string>,
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

  for (const id of order) {
    const message = messages.get(id);
    if (!message) continue;
    const rawText = cachedText(message);

    if (message.role === "user") {
      finish();
      current = {
        id,
        messages: sanitizeCaptureText(rawText)
          ? [{ role: "user", content: sanitizeCaptureText(rawText) }]
          : [],
        fullyPrivate: rawText.length > 0 && isFullyPrivate(rawText),
        complete: completedUsers.has(id),
      };
      continue;
    }

    if (!current || message.role !== "assistant" || current.fullyPrivate) {
      continue;
    }

    const text = sanitizeCaptureText(rawText);
    if (text) current.messages.push({ role: "assistant", content: text });
  }

  finish();
  return turns;
}

function makeSyntheticText(text: string, kind: string) {
  return {
    type: "text" as const,
    text,
    metadata: { [SYNTHETIC_METADATA_KEY]: kind },
  };
}

function injectIntoMessage(
  message: Message,
  text: string,
  kind: string,
  position: "start" | "end" = "end",
): void {
  if (!text.trim()) return;
  const mutable = message.content as Array<Message["content"][number]>;
  const part = makeSyntheticText(text, kind);
  if (position === "start") mutable.unshift(part);
  else mutable.push(part);
}

function getLatestUser(messages: Message[]): Message | undefined {
  return messages.findLast((message) => message.role === "user");
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

export class V2Runtime {
  readonly #ctx: PluginContext;
  readonly #deps: V2RuntimeDependencies;
  readonly #isOwner: () => boolean;
  readonly #states = new Map<string, SessionState>();
  readonly #captureInFlight = new Map<string, Promise<void>>();
  readonly #pendingSummaries = new Map<string, PendingSummary>();
  readonly #summaryInFlight = new Set<string>();
  readonly #deduper = new EventDeduper();
  readonly #registrations: Registration[] = [];
  readonly #abortController = new AbortController();
  #active = true;

  constructor(
    ctx: PluginContext,
    options?: Partial<V2RuntimeDependencies>,
    isOwner: () => boolean = () => true,
  ) {
    this.#ctx = ctx;
    this.#deps = mergeDependencies(options);
    this.#isOwner = isOwner;
  }

  get active(): boolean {
    return this.#active && this.#isOwner();
  }

  get trackedSessionCount(): number {
    return this.#states.size;
  }

  get completedCaptureCount(): number {
    return [...this.#states.values()].reduce(
      (total, state) => total + state.completedCaptureIds.size,
      0,
    );
  }

  async register(): Promise<void> {
    const toolRegistration = await this.#ctx.tool.transform((draft) => {
      draft.add({
        name: "supermemory",
        description: SUPERMEMORY_DESCRIPTION,
        input: SUPERMEMORY_TOOL_INPUT,
        options: { codemode: false, permission: "supermemory" },
        execute: async (args, context) => {
          if (!this.active) return { content: this.#inactiveToolResult() };
          return {
            content: await this.executeTool(
              args as SupermemoryToolArgs,
              context.sessionID,
            ),
          };
        },
      });

      draft.add({
        name: "supermemory_recall",
        description: SUPERMEMORY_RECALL_DESCRIPTION,
        input: SUPERMEMORY_RECALL_INPUT,
        options: { codemode: false, permission: "supermemory_recall" },
        execute: async (args, context) => {
          if (!this.active) return { content: this.#inactiveToolResult() };
          return {
            content: await this.executeRecallTool(
              args as SupermemoryToolArgs,
              context.sessionID,
            ),
          };
        },
      });
    });
    if (!this.active) {
      this.#disposeRegistration(toolRegistration);
      return;
    }
    this.#registrations.push(toolRegistration);

    const contextRegistration = await this.#ctx.session.hook(
      "context",
      async (context) => {
        if (!this.active) return;
        await this.handleContext(context);
      },
    );
    if (!this.active) {
      this.#disposeRegistration(contextRegistration);
      return;
    }
    this.#registrations.push(contextRegistration);

    if (this.active && this.#deps.configured) this.#startEventSubscription();
  }

  async executeTool(args: SupermemoryToolArgs, sessionID: string): Promise<string> {
    try {
      const tags = await this.#resolveSession(sessionID);
      return await this.#deps.executeTool(args, tags, {
        memoryClient: this.#deps.memoryClient,
        configured: this.#deps.configured,
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
        error: "supermemory_recall only supports search mode",
      });
    }
    return this.executeTool({ ...args, mode: "search" }, sessionID);
  }

  async handleContext(context: {
    sessionID: string;
    messages: Message[];
  }): Promise<void> {
    if (!this.#deps.configured) return;
    const state = this.#state(context.sessionID);
    this.#cacheContextMessages(state, context.messages);

    const latestUser = getLatestUser(context.messages);
    if (state.compactionNeedsContext && latestUser) {
      state.compactionNeedsContext = false;
      await this.#injectCompactionContext(context.sessionID, latestUser);
    }

    if (!latestUser) return;
    const userText = extractMessageText(latestUser);
    if (!userText) return;
    const dispatchKey = this.#dispatchKey(context.messages, latestUser, userText);
    if (state.lastInjectedDispatch === dispatchKey) return;
    state.lastInjectedDispatch = dispatchKey;

    if (detectMemoryKeyword(userText, this.#deps.config.keywordPatterns)) {
      injectIntoMessage(latestUser, MEMORY_NUDGE_MESSAGE, "nudge");
    }
    injectIntoMessage(latestUser, buildV2RecallDirective(), "recall");

    if (state.injectedInitialContext) return;
    state.injectedInitialContext = true;
    try {
      const tags = await this.#resolveSession(context.sessionID);
      const [memoryContext, updateNotice] = await Promise.all([
        this.#buildInitialContext(userText, tags),
        this.#deps.getUpdateNotice().catch((error) => {
          this.#deps.logger("v2 update check failed", { error: String(error) });
          return null;
        }),
      ]);
      const initialContext = [memoryContext, updateNotice]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join("\n\n");
      injectIntoMessage(latestUser, initialContext, "initial-context", "start");
    } catch (error) {
      this.#deps.logger("v2 context injection failed", {
        sessionID: context.sessionID,
        error: String(error),
      });
    }
  }

  async handleEvent(event: V2Event): Promise<void> {
    if (!this.active || this.#deduper.hasSeen(event.id)) return;
    const sessionID = this.#eventSessionID(event);

    if (sessionID && event.type !== "session.compaction.ended") {
      await this.#retryPendingSummaries(sessionID);
    }

    switch (event.type) {
      case "session.text.ended": {
        if (!sessionID) return;
        const assistantMessageID = String(event.data?.assistantMessageID ?? "");
        const text = String(event.data?.text ?? "");
        const ordinal = Number(event.data?.ordinal ?? 0);
        if (assistantMessageID && text) {
          this.#cacheAssistantText(
            this.#state(sessionID),
            assistantMessageID,
            Number.isFinite(ordinal) ? ordinal : 0,
            text,
          );
        }
        return;
      }

      case "session.execution.succeeded": {
        if (!sessionID) return;
        const state = this.#state(sessionID);
        this.#markLatestTurnComplete(state);
        await this.#runCaptureExclusive(sessionID, () =>
          this.#captureCadence(sessionID, state),
        );
        return;
      }

      case "session.execution.interrupted": {
        if (!sessionID || event.data?.reason !== "shutdown") return;
        const state = this.#states.get(sessionID);
        if (state) {
          await this.#runCaptureExclusive(sessionID, () =>
            this.#captureSessionEnd(sessionID, state),
          );
        }
        return;
      }

      case "session.deleted": {
        if (!sessionID) return;
        const state = this.#states.get(sessionID);
        if (state) {
          await this.#runCaptureExclusive(sessionID, () =>
            this.#captureSessionEnd(sessionID, state),
          );
        }
        this.#states.delete(sessionID);
        return;
      }

      case "session.compaction.started": {
        if (sessionID && this.#deps.config.compactionEnabled) {
          this.#state(sessionID).compactionNeedsContext = true;
        }
        return;
      }

      case "session.compaction.ended": {
        if (!sessionID || !this.#deps.config.compactionEnabled) return;
        this.#state(sessionID).compactionNeedsContext = false;
        const text = String(event.data?.text ?? "").trim();
        if (!text) return;
        if (text.length < 100) {
          this.#deps.logger("v2 compaction summary too short to save", {
            sessionID,
            length: text.length,
          });
          return;
        }
        const eventId = event.id ?? sha256(`${sessionID}:${text}`);
        const customId = `opencode:compaction:${sha256(`${sessionID}:${eventId}`)}`;
        this.#pendingSummaries.set(customId, {
          customId,
          eventId,
          sessionID,
          text,
        });
        await this.#retryPendingSummaries(sessionID);
        return;
      }

      case "session.compaction.failed": {
        if (sessionID) this.#state(sessionID).compactionNeedsContext = false;
        return;
      }

      case "global.disposed": {
        await Promise.all(
          [...this.#states.entries()].map(([id, state]) =>
            this.#runCaptureExclusive(id, () =>
              this.#captureSessionEnd(id, state),
            ),
          ),
        );
        this.#states.clear();
        return;
      }
    }
  }

  cleanup(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#abortController.abort();

    const snapshots = [...this.#states.entries()];
    const pendingSessions = [
      ...new Set([...this.#pendingSummaries.values()].map((item) => item.sessionID)),
    ];
    for (const [sessionID, state] of snapshots) {
      void this.#runCaptureExclusive(sessionID, () =>
        this.#captureSessionEnd(sessionID, state),
      ).catch((error) => {
        this.#deps.logger("v2 cleanup capture failed", {
          sessionID,
          error: String(error),
        });
      });
    }
    for (const sessionID of pendingSessions) {
      void this.#retryPendingSummaries(sessionID, true);
    }

    this.#states.clear();
    for (const registration of this.#registrations.splice(0)) {
      this.#disposeRegistration(registration);
    }
  }

  #state(sessionID: string): SessionState {
    const existing = this.#states.get(sessionID);
    if (existing) return existing;
    const state: SessionState = {
      messages: new Map(),
      order: [],
      completedUsers: new Set(),
      completedCaptureIds: new Set(),
      injectedInitialContext: false,
      compactionNeedsContext: false,
    };
    this.#states.set(sessionID, state);
    return state;
  }

  #inactiveToolResult(): string {
    return JSON.stringify({
      success: false,
      error: "This duplicate Supermemory V2 plugin instance is inactive",
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

  #dispatchKey(messages: Message[], latestUser: Message, text: string): string {
    if (latestUser.id) return latestUser.id;
    const index = messages.lastIndexOf(latestUser);
    let occurrence = 0;
    for (let cursor = 0; cursor <= index; cursor += 1) {
      const candidate = messages[cursor];
      if (
        candidate?.role === "user" &&
        extractMessageText(candidate) === text
      ) {
        occurrence += 1;
      }
    }
    return `dispatch:${index}:${occurrence}:${sha256(text)}`;
  }

  async #resolveSession(sessionID: string): Promise<ResolvedTags> {
    const state = this.#state(sessionID);
    if (state.tags) return state.tags;
    if (state.resolving) return state.resolving;

    state.resolving = (async () => {
      const session = await this.#ctx.session.get({ sessionID });
      const directory = session.location?.directory;
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

  #cacheContextMessages(state: SessionState, messages: Message[]): void {
    const occurrences = new Map<string, number>();
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = extractMessageText(message);
      if (!text) continue;
      const occurrenceKey = `${message.role}:${sha256(text)}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const id = messageKey(message, text, occurrence);
      const existing = state.messages.get(id);
      if (existing) {
        existing.contextText = text;
        continue;
      }
      state.messages.set(id, {
        id,
        role: message.role,
        contextText: text,
        streamText: new Map(),
      });
      state.order.push(id);
    }
  }

  #cacheAssistantText(
    state: SessionState,
    id: string,
    ordinal: number,
    text: string,
  ): void {
    let message = state.messages.get(id);
    if (!message) {
      message = {
        id,
        role: "assistant",
        contextText: "",
        streamText: new Map(),
      };
      state.messages.set(id, message);
      state.order.push(id);
    }
    message.streamText.set(ordinal, text);
  }

  #markLatestTurnComplete(state: SessionState): void {
    const latestUser = state.order.findLast((id) => state.messages.get(id)?.role === "user");
    if (latestUser) state.completedUsers.add(latestUser);
  }

  async #buildInitialContext(
    userMessage: string,
    tags: ResolvedTags,
  ): Promise<string> {
    if (this.#deps.config.autoRecallEveryPrompt) {
      const [profileResult, userMemoriesResult, projectMemoriesListResult] =
        await Promise.all([
          this.#deps.memoryClient.getProfileScoped(
            tags.canonical,
            tags.personalReads,
            "personal",
            userMessage,
          ),
          this.#deps.memoryClient.searchMemoriesScoped(
            userMessage,
            tags.canonical,
            tags.personalReads,
            "personal",
          ),
          this.#deps.memoryClient.listMemoriesScoped(
            tags.canonical,
            tags.projectReads,
            "project",
            this.#deps.config.maxProjectMemories,
          ),
        ]);

      const projectMemories = {
        results: (projectMemoriesListResult.memories ?? []).map((memory) => ({
          id: memory.id,
          memory: memory.summary || memory.content || memory.title || "",
          similarity: 1,
          title: memory.title,
          metadata: memory.metadata,
        })),
      };
      return formatContextForPrompt(
        profileResult.success ? profileResult : null,
        userMemoriesResult.success ? userMemoriesResult : { results: [] },
        projectMemories,
      );
    }

    const profileResult = await this.#deps.memoryClient.getProfileScoped(
      tags.canonical,
      tags.personalReads,
      "personal",
    );
    return formatContextForPrompt(
      profileResult.success ? profileResult : null,
      { results: [] },
      { results: [] },
    );
  }

  async #injectCompactionContext(
    sessionID: string,
    latestUser: Message | undefined,
  ): Promise<void> {
    let memories: string[] = [];
    try {
      const tags = await this.#resolveSession(sessionID);
      const result = await this.#deps.memoryClient.listMemoriesScoped(
        tags.canonical,
        tags.projectReads,
        "project",
        this.#deps.config.maxProjectMemories,
      );
      memories = fitProjectMemories(
        (result.memories ?? [])
          .map((memory) => memory.summary || memory.content || "")
          .filter((memory): memory is string => Boolean(memory)),
      );
    } catch (error) {
      this.#deps.logger("v2 compaction project-memory lookup failed", {
        sessionID,
        error: String(error),
      });
    }

    const context = createCompactionPrompt(memories);
    if (latestUser && !extractMessageText(latestUser).includes(COMPACTION_CONTEXT_MARKER)) {
      injectIntoMessage(latestUser, context, "compaction");
    }
    this.#deps.logger("v2 compaction context injected", {
      sessionID,
      memoriesCount: memories.length,
    });
  }

  #captureTurns(state: SessionState): CaptureTurn[] {
    return buildCachedCaptureTurns(
      state.messages,
      state.order,
      state.completedUsers,
    );
  }

  async #saveCaptureBatch(
    sessionID: string,
    state: SessionState,
    batch: CaptureBatch,
    reason: "cadence" | "session_end",
  ): Promise<void> {
    const captureId = getCaptureId(sessionID, batch);
    if (state.completedCaptureIds.has(captureId)) return;
    const messages = batch.turns.flatMap((turn) => turn.messages);
    if (messages.length === 0) {
      state.completedCaptureIds.add(captureId);
      return;
    }

    const tags = state.tags ?? (await this.#resolveSession(sessionID));
    const result = await this.#deps.memoryClient.ingestConversation(
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

    if (result.success) state.completedCaptureIds.add(captureId);
    else {
      this.#deps.logger("v2 capture failed", {
        sessionID,
        reason,
        error: result.error,
      });
    }
  }

  async #captureCadence(sessionID: string, state: SessionState): Promise<void> {
    const turns = this.#captureTurns(state);
    for (const batch of buildCadenceBatches(
      turns,
      this.#deps.config.captureEveryNTurns,
    )) {
      await this.#saveCaptureBatch(sessionID, state, batch, "cadence");
    }
  }

  async #captureSessionEnd(sessionID: string, state: SessionState): Promise<void> {
    await this.#captureCadence(sessionID, state);
    const turns = this.#captureTurns(state);
    const finalBatch = buildSessionEndBatch(
      turns,
      this.#deps.config.captureEveryNTurns,
    );
    if (finalBatch) {
      await this.#saveCaptureBatch(sessionID, state, finalBatch, "session_end");
    }
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
          },
        );
        if (result.success) this.#pendingSummaries.delete(summary.customId);
        else {
          this.#deps.logger("v2 compaction summary save failed", {
            sessionID,
            error: result.error,
          });
        }
      } catch (error) {
        this.#deps.logger("v2 compaction summary save failed", {
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
    const events = this.#ctx.event.subscribe({ signal: this.#abortController.signal });
    void (async () => {
      try {
        for await (const event of events) {
          if (!this.active) return;
          try {
            await this.handleEvent(event as V2Event);
          } catch (error) {
            this.#deps.logger("v2 event handling failed", {
              type: (event as V2Event).type,
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

export async function setupV2(
  ctx: PluginContext,
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

  try {
    await runtime.register();
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
