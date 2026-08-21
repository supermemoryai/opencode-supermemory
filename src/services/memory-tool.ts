import { isConfigured } from "../config.js";
import type { MemoryScope, MemoryType } from "../types/index.js";
import { supermemoryClient, type SupermemoryClient } from "./client.js";
import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";
import type { ResolvedTags } from "./tags.js";

export interface SupermemoryToolArgs {
  mode?: string;
  content?: string;
  query?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  memoryId?: string;
  limit?: number;
}

export type MemoryToolClient = Pick<
  SupermemoryClient,
  | "addMemory"
  | "searchMemoriesScoped"
  | "searchMemoriesMany"
  | "getProfileScoped"
  | "listMemoriesScoped"
  | "deleteMemory"
>;

export interface MemoryToolOptions {
  memoryClient?: MemoryToolClient;
  configured?: boolean;
}

export async function executeSupermemoryTool(
  args: SupermemoryToolArgs,
  tags: ResolvedTags,
  options: MemoryToolOptions = {},
): Promise<string> {
  const memoryClient = options.memoryClient ?? supermemoryClient;
  const configured = options.configured ?? isConfigured();

  if (!configured) {
    return JSON.stringify({
      success: false,
      error:
        "SUPERMEMORY_API_KEY not set. Set it in your environment to use Supermemory.",
    });
  }

  const mode = args.mode || "help";

  try {
    switch (mode) {
      case "help": {
        return JSON.stringify({
          success: true,
          message: "Supermemory Usage Guide",
          commands: [
            {
              command: "add",
              description: "Store a new memory",
              args: ["content", "type?", "scope?"],
            },
            {
              command: "search",
              description: "Search memories",
              args: ["query", "scope?"],
            },
            {
              command: "profile",
              description: "View user profile",
              args: ["query?"],
            },
            {
              command: "list",
              description: "List recent memories",
              args: ["scope?", "limit?"],
            },
            {
              command: "forget",
              description: "Remove a memory",
              args: ["memoryId", "scope?"],
            },
          ],
          scopes: {
            user: "Personal preferences and knowledge for this project",
            project: "Project-specific knowledge (default)",
          },
          types: [
            "project-config",
            "architecture",
            "error-solution",
            "preference",
            "learned-pattern",
            "conversation",
          ],
        });
      }

      case "add": {
        if (!args.content) {
          return JSON.stringify({
            success: false,
            error: "content parameter is required for add mode",
          });
        }

        const sanitizedContent = stripPrivateContent(args.content);
        if (isFullyPrivate(args.content)) {
          return JSON.stringify({
            success: false,
            error: "Cannot store fully private content",
          });
        }

        const scope = args.scope || "project";
        const internalScope = scope === "user" ? "personal" : "project";

        const result = await memoryClient.addMemory(
          sanitizedContent,
          tags.canonical,
          {
            type: args.type,
            project: tags.projectName,
            sm_project_id: tags.projectId,
            sm_scope: internalScope,
            sm_capture_mode: "tool",
          },
          { entityContext: AGENT_ENTITY_CONTEXT },
        );

        if (!result.success) {
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to add memory",
          });
        }

        return JSON.stringify({
          success: true,
          message: `Memory added to ${scope} scope`,
          id: result.id,
          scope,
          type: args.type,
        });
      }

      case "search": {
        if (!args.query) {
          return JSON.stringify({
            success: false,
            error: "query parameter is required for search mode",
          });
        }

        const scope = args.scope;

        if (scope === "user") {
          const result = await memoryClient.searchMemoriesScoped(
            args.query,
            tags.canonical,
            tags.personalReads,
            "personal",
          );
          if (!result.success) {
            return JSON.stringify({
              success: false,
              error: result.error || "Failed to search memories",
            });
          }
          return formatSearchResults(args.query, scope, result, args.limit);
        }

        if (scope === "project") {
          const result = await memoryClient.searchMemoriesScoped(
            args.query,
            tags.canonical,
            tags.projectReads,
            "project",
          );
          if (!result.success) {
            return JSON.stringify({
              success: false,
              error: result.error || "Failed to search memories",
            });
          }
          return formatSearchResults(args.query, scope, result, args.limit);
        }

        const result = await memoryClient.searchMemoriesMany(
          args.query,
          tags.allReads,
        );
        if (!result.success) {
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to search memories",
          });
        }
        return formatSearchResults(args.query, undefined, result, args.limit);
      }

      case "profile": {
        const result = await memoryClient.getProfileScoped(
          tags.canonical,
          tags.personalReads,
          "personal",
          args.query,
        );

        if (!result.success) {
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to fetch profile",
          });
        }

        return JSON.stringify({
          success: true,
          profile: {
            static: result.profile?.static || [],
            dynamic: result.profile?.dynamic || [],
          },
        });
      }

      case "list": {
        const scope = args.scope || "project";
        const limit = args.limit || 20;
        const internalScope = scope === "user" ? "personal" : "project";
        const readTags =
          scope === "user" ? tags.personalReads : tags.projectReads;

        const result = await memoryClient.listMemoriesScoped(
          tags.canonical,
          readTags,
          internalScope,
          limit,
        );

        if (!result.success) {
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to list memories",
          });
        }

        const memories = result.memories || [];
        return JSON.stringify({
          success: true,
          scope,
          count: memories.length,
          memories: memories.map((memory) => ({
            id: memory.id,
            content: memory.summary,
            createdAt: memory.createdAt,
            metadata: memory.metadata,
          })),
        });
      }

      case "forget": {
        if (!args.memoryId) {
          return JSON.stringify({
            success: false,
            error: "memoryId parameter is required for forget mode",
          });
        }

        const scope = args.scope || "project";
        const readTags =
          scope === "user"
            ? tags.personalReads
            : scope === "project"
              ? tags.projectReads
              : tags.allReads;

        const result = await memoryClient.deleteMemory(args.memoryId, [
          tags.canonical,
          ...readTags,
        ]);

        if (!result.success) {
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to delete memory",
          });
        }

        return JSON.stringify({
          success: true,
          message: `Memory ${args.memoryId} removed from ${scope} scope`,
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown mode: ${mode}`,
        });
    }
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatSearchResults(
  query: string,
  scope: string | undefined,
  results: {
    results?: Array<{
      id?: string;
      memory?: string;
      chunk?: string;
      similarity?: number;
    }>;
  },
  limit?: number,
): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    scope,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((result) => {
      const formattedResult = {
        content: result.memory ?? result.chunk,
        similarity: Math.round((result.similarity ?? 0) * 100),
      };

      return result.memory === undefined
        ? { ...formattedResult, forgettable: false }
        : {
            id: result.id,
            ...formattedResult,
            forgettable: true,
          };
    }),
  });
}
