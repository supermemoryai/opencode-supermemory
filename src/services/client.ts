import Supermemory from "supermemory";
import {
  CONFIG,
  PLUGIN_VERSION,
  SUPERMEMORY_API_KEY,
  getApiBaseUrl,
  isConfigured,
} from "../config.js";
import { log } from "./logger.js";
import {
  mergeListResponses,
  mergeProfileResponses,
  mergeSearchResponses,
} from "./result-merge.js";
import type {
  ConversationIngestResponse,
  ConversationMessage,
  MemoryType,
} from "../types/index.js";

const TIMEOUT_MS = 30000;
const MAX_CONVERSATION_CHARS = 100_000;
const OPENCODE_SOURCE = "opencode";

export type MemoryScope = "personal" | "project";

export interface SearchResultItem {
  id?: string;
  memory?: string;
  content?: string;
  chunk?: string;
  context?: unknown;
  score?: number;
  similarity?: number;
  title?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
  containerTag?: string;
}

export interface SearchResponse {
  success: boolean;
  results?: SearchResultItem[];
  total?: number;
  timing?: number;
  error?: string;
}

export interface ProfileResponse {
  success: boolean;
  profile: { static: string[]; dynamic: string[] } | null;
  searchResults?: {
    results: SearchResultItem[];
    total: number;
    timing?: number;
  };
  error?: string;
}

export interface ListMemoryItem {
  id: string;
  summary?: string | null;
  content?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ListResponse {
  success: boolean;
  memories: ListMemoryItem[];
  pagination: {
    currentPage: number;
    totalItems: number;
    totalPages: number;
  };
  error?: string;
}

function getScopeFilters(scope: MemoryScope) {
  return {
    AND: [{ key: "sm_scope", value: scope, filterType: "metadata" as const }],
  };
}

function supportsScopedCanonicalTag(containerTag: string): boolean {
  return /^repo_.+__[0-9a-f]{16}$/i.test(containerTag);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

export class SupermemoryClient {
  private client: Supermemory | null = null;

  private formatConversationMessage(message: ConversationMessage): string {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text"
                ? part.text
                : `[image] ${part.imageUrl.url}`,
            )
            .join("\n");

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return `[${message.role}]`;
    }
    return `[${message.role}] ${trimmed}`;
  }

  private formatConversationTranscript(
    messages: ConversationMessage[],
  ): string {
    return messages
      .map(
        (message, idx) =>
          `${idx + 1}. ${this.formatConversationMessage(message)}`,
      )
      .join("\n");
  }

  private getClient(): Supermemory {
    if (!this.client) {
      if (!isConfigured()) {
        throw new Error("SUPERMEMORY_API_KEY not set");
      }
      this.client = new Supermemory({
        apiKey: SUPERMEMORY_API_KEY,
        baseURL: getApiBaseUrl(),
        defaultHeaders: { "x-sm-source": OPENCODE_SOURCE },
      });
      void this.client.settings.update({
        shouldLLMFilter: true,
        filterPrompt: CONFIG.filterPrompt,
      });
    }
    return this.client;
  }

  async searchMemories(
    query: string,
    containerTag: string,
    scope?: MemoryScope,
  ): Promise<SearchResponse> {
    log("searchMemories: start", { containerTag, scope });
    try {
      const result = await withTimeout(
        this.getClient().search.memories({
          q: query,
          containerTag,
          threshold: CONFIG.similarityThreshold,
          limit: CONFIG.maxMemories,
          searchMode: "hybrid",
          filters: scope ? getScopeFilters(scope) : undefined,
        }),
        TIMEOUT_MS,
      );
      const results = (result.results as SearchResultItem[]).map((item) => ({
        ...item,
        containerTag,
      }));
      log("searchMemories: success", { count: results.length });
      return {
        success: true,
        results,
        total: result.total,
        timing: result.timing,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return {
        success: false,
        error: errorMessage,
        results: [],
        total: 0,
        timing: 0,
      };
    }
  }

  async searchMemoriesMany(
    query: string,
    containerTags: string[],
  ): Promise<SearchResponse> {
    const uniqueTags = [...new Set(containerTags.filter(Boolean))];
    const responses = await Promise.all(
      uniqueTags.map((containerTag) =>
        this.searchMemories(query, containerTag),
      ),
    );
    return mergeSearchResponses(responses, CONFIG.maxMemories);
  }

  async searchMemoriesScoped(
    query: string,
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
  ): Promise<SearchResponse> {
    const legacyTags = [
      ...new Set(
        containerTags.filter((tag) => tag && tag !== canonicalTag),
      ),
    ];
    const responses = await Promise.all([
      this.searchMemories(
        query,
        canonicalTag,
        supportsScopedCanonicalTag(canonicalTag) ? scope : undefined,
      ),
      ...legacyTags.map((containerTag) =>
        this.searchMemories(query, containerTag),
      ),
    ]);
    return mergeSearchResponses(responses, CONFIG.maxMemories);
  }

  async getProfile(
    containerTag: string,
    query?: string,
    scope?: MemoryScope,
  ): Promise<ProfileResponse> {
    log("getProfile: start", { containerTag, scope });
    try {
      const result = await withTimeout(
        this.getClient().profile(
          {
            containerTag,
            q: query,
            filters: scope ? getScopeFilters(scope) : undefined,
          } as Parameters<Supermemory["profile"]>[0],
        ),
        TIMEOUT_MS,
      );
      const searchResults = result.searchResults
        ? {
            results: (
              result.searchResults.results as SearchResultItem[]
            ).map((item) => ({
              ...item,
              memory:
                item.memory ??
                item.content ??
                String(item.context ?? ""),
              containerTag,
            })),
            total: result.searchResults.total,
            timing: result.searchResults.timing,
          }
        : undefined;
      log("getProfile: success", { hasProfile: !!result.profile });
      return {
        success: true,
        profile: {
          static: result.profile?.static ?? [],
          dynamic: result.profile?.dynamic ?? [],
        },
        searchResults,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log("getProfile: error", { error: errorMessage });
      return {
        success: false,
        error: errorMessage,
        profile: null,
      };
    }
  }

  async getProfileMany(
    containerTags: string[],
    query?: string,
  ): Promise<ProfileResponse> {
    const uniqueTags = [...new Set(containerTags.filter(Boolean))];
    const responses = await Promise.all(
      uniqueTags.map((containerTag) =>
        this.getProfile(containerTag, query),
      ),
    );
    return mergeProfileResponses(responses, CONFIG.maxMemories);
  }

  async getProfileScoped(
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
    query?: string,
  ): Promise<ProfileResponse> {
    const legacyTags = [
      ...new Set(
        containerTags.filter((tag) => tag && tag !== canonicalTag),
      ),
    ];
    const responses = await Promise.all([
      this.getProfile(
        canonicalTag,
        query,
        supportsScopedCanonicalTag(canonicalTag) ? scope : undefined,
      ),
      ...legacyTags.map((containerTag) =>
        this.getProfile(containerTag, query),
      ),
    ]);
    return mergeProfileResponses(responses, CONFIG.maxMemories);
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: MemoryType;
      tool?: string;
      [key: string]: unknown;
    },
    options?: { customId?: string; entityContext?: string },
  ) {
    log("addMemory: start", {
      containerTag,
      contentLength: content.length,
      customId: options?.customId,
      hasEntityContext: !!options?.entityContext,
    });
    try {
      const mergedMetadata = Object.fromEntries(
        Object.entries({
          sm_source: OPENCODE_SOURCE,
          sm_client: OPENCODE_SOURCE,
          sm_plugin_version: PLUGIN_VERSION,
          sm_capture_mode: metadata?.sm_capture_mode ?? "tool",
          ...(metadata ?? {}),
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, string | number | boolean | string[]>;

      const payload: {
        content: string;
        containerTag: string;
        metadata: Record<string, string | number | boolean | string[]>;
        customId?: string;
        entityContext?: string;
      } = {
        content,
        containerTag,
        metadata: mergedMetadata,
      };
      if (options?.customId) {
        payload.customId = options.customId;
      }
      if (options?.entityContext) {
        payload.entityContext = options.entityContext;
      }

      const result = await withTimeout(
        this.getClient().memories.add(payload),
        TIMEOUT_MS,
      );
      log("addMemory: success", { id: result.id });
      return { success: true as const, ...result };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    log("deleteMemory: start", { memoryId });
    try {
      await withTimeout(
        this.getClient().memories.delete(memoryId),
        TIMEOUT_MS,
      );
      log("deleteMemory: success", { memoryId });
      return { success: true as const };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async listMemories(
    containerTag: string,
    limit = 20,
    scope?: MemoryScope,
  ): Promise<ListResponse> {
    log("listMemories: start", { containerTag, limit, scope });
    try {
      const result = await withTimeout(
        this.getClient().memories.list({
          containerTags: [containerTag],
          filters: scope ? getScopeFilters(scope) : undefined,
          limit,
          order: "desc",
          sort: "createdAt",
          includeContent: true,
        }),
        TIMEOUT_MS,
      );
      const memories = result.memories as unknown as ListMemoryItem[];
      log("listMemories: success", { count: memories.length });
      return {
        success: true,
        memories,
        pagination: result.pagination,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return {
        success: false,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async listMemoriesMany(
    containerTags: string[],
    limit = 20,
  ): Promise<ListResponse> {
    const uniqueTags = [...new Set(containerTags.filter(Boolean))];
    const responses = await Promise.all(
      uniqueTags.map((containerTag) =>
        this.listMemories(containerTag, limit),
      ),
    );
    return mergeListResponses(responses, limit);
  }

  async listMemoriesScoped(
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
    limit = 20,
  ): Promise<ListResponse> {
    const legacyTags = [
      ...new Set(
        containerTags.filter((tag) => tag && tag !== canonicalTag),
      ),
    ];
    const responses = await Promise.all([
      this.listMemories(
        canonicalTag,
        limit,
        supportsScopedCanonicalTag(canonicalTag) ? scope : undefined,
      ),
      ...legacyTags.map((containerTag) =>
        this.listMemories(containerTag, limit),
      ),
    ]);
    return mergeListResponses(responses, limit);
  }

  async ingestConversation(
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>,
    options?: {
      defaultEntityContext?: string;
      entityContextByContainerTag?: Record<string, string>;
    },
  ) {
    log("ingestConversation: start", {
      conversationId,
      messageCount: messages.length,
      containerTags,
    });

    if (messages.length === 0) {
      return { success: false as const, error: "No messages to ingest" };
    }

    const uniqueTags = [
      ...new Set(containerTags),
    ].filter((tag) => tag.length > 0);
    if (uniqueTags.length === 0) {
      return {
        success: false as const,
        error: "At least one containerTag is required",
      };
    }

    const transcript = this.formatConversationTranscript(messages);
    const rawContent = `[Conversation ${conversationId}]\n${transcript}`;
    const content =
      rawContent.length > MAX_CONVERSATION_CHARS
        ? `${rawContent.slice(0, MAX_CONVERSATION_CHARS)}\n...[truncated]`
        : rawContent;

    const ingestMetadata = {
      type: "conversation" as const,
      conversationId,
      messageCount: messages.length,
      originalContainerTags: uniqueTags,
      ...metadata,
    };

    const savedIds: string[] = [];
    let firstError: string | null = null;

    for (const tag of uniqueTags) {
      const entityContext =
        options?.entityContextByContainerTag?.[tag] ??
        options?.defaultEntityContext;
      const result = await this.addMemory(content, tag, ingestMetadata, {
        ...(entityContext ? { entityContext } : {}),
      });
      if (result.success) {
        savedIds.push(result.id);
      } else if (!firstError) {
        firstError = result.error || "Failed to store conversation";
      }
    }

    if (savedIds.length === 0) {
      log("ingestConversation: error", {
        conversationId,
        error: firstError,
      });
      return {
        success: false as const,
        error: firstError || "Failed to ingest conversation",
      };
    }

    const status =
      savedIds.length === uniqueTags.length ? "stored" : "partial";
    const response: ConversationIngestResponse = {
      id: savedIds[0]!,
      conversationId,
      status,
    };

    log("ingestConversation: success", {
      conversationId,
      status,
      storedCount: savedIds.length,
      requestedCount: uniqueTags.length,
    });

    return {
      success: true as const,
      ...response,
      storedMemoryIds: savedIds,
    };
  }
}

export const supermemoryClient = new SupermemoryClient();
