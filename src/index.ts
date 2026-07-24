import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part, Permission } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { AGENT_ENTITY_CONTEXT } from "./services/entity-context.js";
import { supermemoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { createCaptureHook } from "./services/capture.js";
import { buildRecallDirective } from "./services/recall.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { createCompactionHook, type CompactionContext } from "./services/compaction.js";

import { isConfigured, CONFIG, PLUGIN_VERSION } from "./config.js";
import { log } from "./services/logger.js";
import { checkNpmUpdate, formatUpdateNotice } from "./services/version-check.js";
import type { MemoryScope, MemoryType } from "./types/index.js";

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

const MEMORY_KEYWORD_PATTERN = new RegExp(`\\b(${CONFIG.keywordPatterns.join("|")})\\b`, "i");

const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for personal preferences in this project (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;
const UPDATE_COMMAND = "bunx opencode-supermemory@latest install";

function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
}

function detectMemoryKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return MEMORY_KEYWORD_PATTERN.test(textWithoutCode);
}

function combineContextParts(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join("\n\n");
}

function isSupermemoryRecallSearch(input: Permission): boolean {
  const type = String((input as { type?: unknown }).type ?? "");
  const title = String((input as { title?: unknown }).title ?? "").toLowerCase();
  const metadata =
    ((input as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;

  const toolName = String(metadata.tool ?? metadata.toolName ?? type);
  const isSupermemory =
    type === "supermemory" || toolName === "supermemory" || title.includes("supermemory");
  if (!isSupermemory) return false;

  const args = (metadata.args ?? metadata.input ?? metadata.arguments ?? metadata) as Record<
    string,
    unknown
  >;
  return String(args.mode ?? "") === "search";
}

export const SupermemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const tags = getTags(directory);
  const injectedSessions = new Set<string>();
  log("Plugin init", { directory, tags, configured: isConfigured() });

  if (!isConfigured()) {
    log("Plugin disabled - SUPERMEMORY_API_KEY not set");
  }

  // Fetch model limits once at plugin init
  const modelLimits = new Map<string, number>();

  (async () => {
    try {
      const response = await ctx.client.provider.list();
      if (response.data?.all) {
        for (const provider of response.data.all) {
          if (provider.models) {
            for (const [modelId, model] of Object.entries(provider.models)) {
              if (model.limit?.context) {
                modelLimits.set(`${provider.id}/${modelId}`, model.limit.context);
              }
            }
          }
        }
      }
      log("Model limits loaded", { count: modelLimits.size });
    } catch (error) {
      log("Failed to fetch model limits", { error: String(error) });
    }
  })();

  const getModelLimit = (providerID: string, modelID: string): number | undefined => {
    return modelLimits.get(`${providerID}/${modelID}`);
  };

  const compactionHook = isConfigured() && ctx.client
    ? createCompactionHook(ctx as CompactionContext, tags, {
        threshold: CONFIG.compactionThreshold,
        getModelLimit,
      })
    : null;
  const captureHook = isConfigured() && ctx.client
    ? createCaptureHook(ctx, tags)
    : null;

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured()) return;

      const start = Date.now();

      try {
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) {
          log("chat.message: no text parts found");
          return;
        }

        const userMessage = textParts.map((p) => p.text).join("\n");

        if (!userMessage.trim()) {
          log("chat.message: empty message, skipping");
          return;
        }

        log("chat.message: processing", {
          messagePreview: userMessage.slice(0, 100),
          partsCount: output.parts.length,
          textPartsCount: textParts.length,
        });

        if (detectMemoryKeyword(userMessage)) {
          log("chat.message: memory keyword detected");
          const nudgePart: Part = {
            id: `prt_supermemory-nudge-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: MEMORY_NUDGE_MESSAGE,
            synthetic: true,
          };
          output.parts.push(nudgePart);
        }

        const recallPart: Part = {
          id: `prt_supermemory-recall-${Date.now()}`,
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text: buildRecallDirective(),
          synthetic: true,
        };
        output.parts.push(recallPart);

        const isFirstMessage = !injectedSessions.has(input.sessionID);

        if (isFirstMessage) {
          injectedSessions.add(input.sessionID);

          let memoryContext = "";
          const updateCheck = checkNpmUpdate(
            "opencode-supermemory",
            PLUGIN_VERSION,
            UPDATE_COMMAND
          ).then((info) => (info ? formatUpdateNotice(info) : null));

          if (CONFIG.autoRecallEveryPrompt) {
            const [profileResult, userMemoriesResult, projectMemoriesListResult] = await Promise.all([
              supermemoryClient.getProfileScoped(
                tags.canonical,
                tags.personalReads,
                "personal",
                userMessage,
              ),
              supermemoryClient.searchMemoriesScoped(
                userMessage,
                tags.canonical,
                tags.personalReads,
                "personal",
              ),
              supermemoryClient.listMemoriesScoped(
                tags.canonical,
                tags.projectReads,
                "project",
                CONFIG.maxProjectMemories,
              ),
            ]);

            const profile = profileResult.success ? profileResult : null;
            const userMemories = userMemoriesResult.success ? userMemoriesResult : { results: [] };
            const projectMemoriesList = projectMemoriesListResult.success ? projectMemoriesListResult : { memories: [] };

            const projectMemories = {
              results: (projectMemoriesList.memories || []).map((m: any) => ({
                id: m.id,
                memory: m.summary || m.content || m.title || "",
                similarity: 1,
                title: m.title,
                metadata: m.metadata,
              })),
              total: projectMemoriesList.memories?.length || 0,
              timing: 0,
            };

            memoryContext = formatContextForPrompt(
              profile,
              userMemories,
              projectMemories
            );
          } else {
            const profileResult = await supermemoryClient.getProfileScoped(
              tags.canonical,
              tags.personalReads,
              "personal",
            );
            const profile = profileResult.success ? profileResult : null;
            memoryContext = formatContextForPrompt(profile, { results: [] }, { results: [] });
          }

          const updateNotice = await updateCheck;
          const firstMessageContext = combineContextParts([memoryContext, updateNotice]);

          if (firstMessageContext) {
            const contextPart: Part = {
              id: `prt_supermemory-context-${Date.now()}`,
              sessionID: input.sessionID,
              messageID: output.message.id,
              type: "text",
              text: firstMessageContext,
              synthetic: true,
            };

            output.parts.unshift(contextPart);

            const duration = Date.now() - start;
            log("chat.message: context injected", {
              duration,
              contextLength: firstMessageContext.length,
            });
          }
        }

      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
      }
    },

    tool: {
      supermemory: tool({
        description:
          "Manage and query the Supermemory persistent memory system. Use 'search' to find relevant memories, 'add' to store new knowledge, 'profile' to view user profile, 'list' to see recent memories, 'forget' to remove a memory.",
        args: {
          mode: tool.schema
            .enum(["add", "search", "profile", "list", "forget", "help"])
            .optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          type: tool.schema
            .enum([
              "project-config",
              "architecture",
              "error-solution",
              "preference",
              "learned-pattern",
              "conversation",
            ])
            .optional(),
          scope: tool.schema.enum(["user", "project"]).optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args: {
          mode?: string;
          content?: string;
          query?: string;
          type?: MemoryType;
          scope?: MemoryScope;
          memoryId?: string;
          limit?: number;
        }) {
          if (!isConfigured()) {
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
                const internalScope =
                  scope === "user" ? "personal" : "project";

                const result = await supermemoryClient.addMemory(
                  sanitizedContent,
                  tags.canonical,
                  {
                    type: args.type,
                    project: tags.projectName,
                    sm_project_id: tags.projectId,
                    sm_scope: internalScope,
                    sm_capture_mode: "tool",
                  },
                  { entityContext: AGENT_ENTITY_CONTEXT }
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
                  const result = await supermemoryClient.searchMemoriesScoped(
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
                  const result = await supermemoryClient.searchMemoriesScoped(
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

                const result = await supermemoryClient.searchMemoriesMany(
                  args.query,
                  tags.allReads,
                );
                if (!result.success) {
                  return JSON.stringify({
                    success: false,
                    error: result.error || "Failed to search memories",
                  });
                }
                return formatSearchResults(
                  args.query,
                  undefined,
                  result,
                  args.limit,
                );
              }

              case "profile": {
                const result = await supermemoryClient.getProfileScoped(
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
                const internalScope =
                  scope === "user" ? "personal" : "project";
                const readTags =
                  scope === "user" ? tags.personalReads : tags.projectReads;

                const result = await supermemoryClient.listMemoriesScoped(
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
                  memories: memories.map((m) => ({
                    id: m.id,
                    content: m.summary,
                    createdAt: m.createdAt,
                    metadata: m.metadata,
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

                const result = await supermemoryClient.deleteMemory(
                  args.memoryId
                );

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
        },
      }),
    },

    "permission.ask": async (input, output) => {
      if (!isConfigured()) return;
      try {
        if (isSupermemoryRecallSearch(input)) {
          output.status = "allow";
          log("permission.ask: auto-allowing supermemory recall search");
        }
      } catch (error) {
        log("permission.ask: ERROR", { error: String(error) });
      }
    },

    event: async (input: { event: { type: string; properties?: unknown } }) => {
      if (compactionHook) {
        await compactionHook.event(input);
      }
      if (captureHook) {
        await captureHook.event(input);
      }
    },
  };
};

function formatSearchResults(
  query: string,
  scope: string | undefined,
  results: { results?: Array<{ id?: string; memory?: string; chunk?: string; similarity?: number }> },
  limit?: number
): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    scope,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round((r.similarity ?? 0) * 100),
    })),
  });
}
