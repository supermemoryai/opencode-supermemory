import {
  Supermemory,
  type FilterExpression,
  type RequestOptions,
} from "supermemory";
import type {
  ListMemoryItem,
  ListResponse,
  ProfileResponse,
  SearchResultItem,
} from "./client.js";
import { log } from "./logger.js";

type LegacyOptions = { timeout?: number; maxRetries?: number };
type ScopedRequest = {
  filters?: { AND: { key: string; value: string; filterType: "metadata" }[] };
};

function requestOptions(options?: LegacyOptions): RequestOptions {
  return {
    timeoutInSeconds: (options?.timeout ?? 60_000) / 1000,
    maxRetries: options?.maxRetries ?? 2,
  };
}

function scopeFilter(request: ScopedRequest): FilterExpression | undefined {
  if (!request.filters) return undefined;
  return {
    operator: "and",
    operands: request.filters.AND.map(({ key, value }) => ({
      field: key,
      operator: "eq",
      value,
    })),
  };
}

function notFound(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function deletionError(
  count: number,
  errors: { id: string; error: string }[],
  id: string,
): never {
  const error =
    count === 0 && errors.length === 1 && errors[0]?.id === id
      ? errors[0].error
      : undefined;
  if (
    error &&
    /^(?:memory|document)?\s*(?:not found|does not exist)[.!]?$/i.test(
      error.trim(),
    )
  ) {
    throw notFound(error);
  }
  throw new Error("Deletion was not confirmed for the requested ID");
}

export class V5Client {
  private sdk: Supermemory;

  constructor(
    apiKey: string,
    baseUrl: string,
    readonly settings: {
      update(
        body: { shouldLLMFilter: boolean; filterPrompt: string },
        options?: LegacyOptions,
      ): Promise<unknown>;
    },
    private readonly listBudgetMs: number,
  ) {
    this.sdk = new Supermemory({
      apiKey,
      baseUrl,
      headers: { "x-sm-source": "opencode" },
      timeoutInSeconds: 60,
      maxRetries: 2,
    });
  }

  readonly search = {
    memories: async (
      request: ScopedRequest & {
        q: string;
        containerTag: string;
        threshold: number;
        limit: number;
        searchMode: "hybrid" | "memories";
      },
      options?: LegacyOptions,
    ) => {
      const result = await this.sdk.search(
        request.containerTag,
        {
          query: request.q,
          filter: scopeFilter(request),
          threshold: request.threshold,
          limit: request.limit,
          searchMode: request.searchMode,
          rerank: "none",
          rewriteQuery: false,
        },
        requestOptions(options),
      );
      const results: SearchResultItem[] = result.results.map((item) => ({
        ...item,
        updatedAt: item.system?.updatedAt,
      }));
      return { results, total: results.length, timing: result.searchTime };
    },
  };

  async profile(
    request: ScopedRequest & { containerTag: string; q?: string },
    options?: LegacyOptions,
  ): Promise<Pick<ProfileResponse, "profile" | "searchResults">> {
    const [result, searchResults] = await Promise.all([
      this.sdk.profile(
        request.containerTag,
        { filter: scopeFilter(request) },
        requestOptions(options),
      ),
      request.q
        ? this.search.memories(
            {
              ...request,
              q: request.q,
              searchMode: "memories",
              threshold: 0.6,
              limit: 10,
            },
            options,
          )
        : undefined,
    ]);
    return {
      profile: {
        static: result.profile.static.map((fact) => fact.memory),
        dynamic: result.profile.dynamic.map((fact) => fact.memory),
      },
      searchResults,
    };
  }

  readonly memories = {
    add: async (
      request: {
        content: string;
        containerTag: string;
        customId?: string;
        entityContext?: string;
        metadata: Record<string, string | number | boolean | string[]>;
      },
      options?: LegacyOptions,
    ): Promise<{ id: string; status: string }> => {
      const result = await this.sdk.add(
        request.containerTag,
        {
          content: request.content,
          id: request.customId,
          supportingContext: request.entityContext,
          metadata: request.metadata,
          taskType: "memory",
          dreaming: "dynamic",
        },
        requestOptions(options),
      );
      if (
        !result.id?.trim() ||
        ![
          "queued",
          "extracting",
          "chunking",
          "embedding",
          "indexing",
          "done",
        ].includes(result.status)
      ) {
        throw new Error("Document acceptance was invalid or processing failed");
      }
      return result;
    },
    forget: async (request: { id: string; containerTag: string }) => {
      const result = await this.sdk.memories.forget(
        request.containerTag,
        {
          ids: [request.id],
        },
        requestOptions(),
      );
      if (
        result.count !== 1 ||
        result.matches?.length !== 1 ||
        result.matches[0]?.id !== request.id ||
        result.errors?.length !== 0
      ) {
        deletionError(
          result.matches?.length === 0 ? result.count : -1,
          result.errors ?? [],
          request.id,
        );
      }
      return { id: request.id, forgotten: true };
    },
    list: async (
      request: ScopedRequest & {
        containerTags: string[];
        limit: number;
        order: "desc";
        sort: "createdAt";
        includeContent: boolean;
      },
    ): Promise<{
      memories: ListMemoryItem[];
      pagination: ListResponse["pagination"];
    }> => {
      const namespace = request.containerTags[0];
      if (!namespace || request.containerTags.length !== 1) {
        throw new Error("Document list requires one namespace");
      }
      const deadline = Date.now() + this.listBudgetMs;
      const result = await this.sdk.list(
        namespace,
        "documents",
        {
          limit: request.limit,
          sort: request.sort,
          order: request.order,
          filter: scopeFilter(request),
        },
        requestOptions(),
      );
      const memories: ListMemoryItem[] = await Promise.all(
        result.documents
          .filter(
            (item) => typeof item?.id === "string" && item.id.trim().length > 0,
          )
          .map(async (item) => {
            let content: string | null | undefined;
            if (request.includeContent) {
              const controller = new AbortController();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0)
                  throw new Error("Document hydration budget exhausted");
                const document = await Promise.race([
                  this.sdk.documents.get(namespace, item.id, undefined, {
                    ...requestOptions(),
                    timeoutInSeconds: remainingMs / 1000,
                    abortSignal: controller.signal,
                  }),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      reject(new Error("Document hydration timed out"));
                    }, remainingMs);
                  }),
                ]);
                if (
                  document.id === item.id &&
                  (typeof document.content === "string" ||
                    document.content === null) &&
                  (request.filters?.AND.every(
                    ({ key, value }) => document.metadata?.[key] === value,
                  ) ??
                    true)
                ) {
                  content = document.content;
                } else {
                  log("listMemories: content hydration skipped", {
                    id: item.id,
                    reason: "Invalid document response",
                  });
                }
              } catch {
                log("listMemories: content hydration skipped", {
                  id: item.id,
                  reason: "Document read failed",
                });
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            return {
              ...item,
              ...(content !== undefined ? { content } : {}),
              status: item.system?.status,
              createdAt: item.system?.createdAt,
              updatedAt: item.system?.updatedAt,
              containerTags: [namespace],
            };
          }),
      );
      return { memories, pagination: result.pagination };
    },
  };

  async deleteDocument(id: string, namespaces: string[]): Promise<void> {
    if (namespaces.length === 0)
      throw new Error("Document deletion requires an explicit namespace");
    let retainedAuthorizationError: unknown;
    for (const [index, namespace] of namespaces.entries()) {
      try {
        const result = await this.sdk.documents.delete(
          namespace,
          { ids: [id] },
          requestOptions(),
        );
        if (result.count !== 1 || result.errors?.length !== 0)
          deletionError(result.count, result.errors ?? [], id);
        return;
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode;
        if (status === 404) continue;
        if (index > 0 && (status === 401 || status === 403)) {
          retainedAuthorizationError ??= error;
          continue;
        }
        throw error;
      }
    }
    throw retainedAuthorizationError ?? notFound("Document not found");
  }
}
