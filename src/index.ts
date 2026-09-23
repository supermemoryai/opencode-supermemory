import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part, Permission } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { supermemoryClient } from "./services/client.js";
import {
  formatContextForPrompt,
  getInjectedProfileFactTexts,
} from "./services/context.js";
import { createCaptureHook } from "./services/capture.js";
import {
  buildDirectRecallResult,
  buildRecallDirective,
  DIRECT_RECALL_TIMEOUT_MS,
  RecallSessionCache,
} from "./services/recall.js";
import { createMemoryActivityReporter } from "./services/activity.js";
import {
  executeSupermemoryTool,
  MEMORY_TOOL_MODES,
  MEMORY_TOOL_SCOPES,
  MEMORY_TOOL_TYPES,
  SUPERMEMORY_TOOL_DESCRIPTION,
  type SupermemoryToolArgs,
} from "./services/memory-tool.js";
import { getTags } from "./services/tags.js";
import { createCompactionHook, type CompactionContext } from "./services/compaction.js";

import { isConfigured, CONFIG, PLUGIN_VERSION } from "./config.js";
import { log } from "./services/logger.js";
import { checkNpmUpdate } from "./services/version-check.js";

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

const MEMORY_KEYWORD_PATTERN = new RegExp(`\\b(${CONFIG.keywordPatterns.join("|")})\\b`, "i");

export const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for personal preferences in this project (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;
export const UPDATE_COMMAND = "bunx opencode-supermemory@latest install";

function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
}

function detectMemoryKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return MEMORY_KEYWORD_PATTERN.test(textWithoutCode);
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

/**
 * OpenCode V1 plugin. OpenCode 2 loads the `opencode-supermemory/server`
 * entry instead; both share the services under `src/services`.
 */
export const SupermemoryPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const tags = getTags(directory);
  const injectedSessions = new Set<string>();
  const recallSessions = new RecallSessionCache();
  const activity = createMemoryActivityReporter(ctx.client);
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
    ? createCaptureHook(ctx, tags, { onSaved: () => activity.saved() })
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

        const isFirstMessage = !injectedSessions.has(input.sessionID);
        if (isFirstMessage) injectedSessions.add(input.sessionID);

        if (CONFIG.recallMode === "advisory") {
          output.parts.push({
            id: `prt_supermemory-recall-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: buildRecallDirective(),
            synthetic: true,
          });
        }

        const profileRequest =
          isFirstMessage && CONFIG.recallMode !== "off" && CONFIG.injectProfile
            ? supermemoryClient.getProfileScoped(
                tags.canonical,
                tags.personalReads,
                "personal",
                undefined,
                { timeoutMs: DIRECT_RECALL_TIMEOUT_MS },
              )
            : Promise.resolve(null);

        const directRecallPromise =
          CONFIG.recallMode === "direct"
            ? buildDirectRecallResult({
                prompt: userMessage,
                sessionID: input.sessionID,
                cache: recallSessions,
                search: (query) =>
                  supermemoryClient.searchMemoriesForRecall(
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
            : Promise.resolve({
                context: "",
                status: "skipped" as const,
                count: 0,
                tokens: 0,
              });

        const firstMessage = isFirstMessage
          ? profileRequest.then((profileResult) => {
              const profile = profileResult?.success ? profileResult : null;
              return profile
                ? formatContextForPrompt(
                    profile,
                    { results: [] },
                    { results: [] },
                  )
                : "";
            })
          : Promise.resolve("");

        const updateCheck = isFirstMessage
          ? checkNpmUpdate(
              "opencode-supermemory",
              PLUGIN_VERSION,
              UPDATE_COMMAND,
            )
          : Promise.resolve(null);

        const [directRecall, firstMessageContext, updateInfo] = await Promise.all([
          directRecallPromise,
          firstMessage,
          updateCheck,
        ]);

        if (directRecall.status === "recalled") {
          activity.recalled(directRecall.count, directRecall.tokens);
        } else if (directRecall.status === "unavailable") {
          activity.recallUnavailable();
        }
        if (updateInfo) activity.updateAvailable(updateInfo);

        if (firstMessageContext) {
          output.parts.unshift({
            id: `prt_supermemory-context-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: firstMessageContext,
            synthetic: true,
          });
        }

        if (directRecall.context) {
          output.parts.push({
            id: `prt_supermemory-direct-recall-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: directRecall.context,
            synthetic: true,
          });
        }

        log("chat.message: context processed", {
          duration: Date.now() - start,
          firstMessageContextLength: firstMessageContext.length,
          directRecallContextLength: directRecall.context.length,
        });

      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
      }
    },

    tool: {
      supermemory: tool({
        description: SUPERMEMORY_TOOL_DESCRIPTION,
        args: {
          mode: tool.schema.enum(MEMORY_TOOL_MODES).optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          type: tool.schema.enum(MEMORY_TOOL_TYPES).optional(),
          scope: tool.schema.enum(MEMORY_TOOL_SCOPES).optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args: SupermemoryToolArgs) {
          return executeSupermemoryTool(args, tags, {
            onSaved: () => activity.saved(),
          });
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

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "supermemory") return;
      const args = output.args as { mode?: unknown; query?: unknown };
      if (args.mode === "search") {
        activity.recalling(
          typeof args.query === "string" ? args.query : undefined,
        );
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "supermemory") return;
      try {
        const result = JSON.parse(output.output) as {
          success?: boolean;
          count?: number;
          results?: unknown[];
        };
        if (!result.success) return;
        const count = result.count ?? result.results?.length;
        if (typeof count === "number" && count > 0) {
          activity.recalled(count, Math.round(output.output.length / 4));
        }
      } catch {
        // Tool output remains authoritative when it is not structured JSON.
      }
    },

    event: async (input: { event: { type: string; properties?: unknown } }) => {
      const props = input.event.properties as Record<string, unknown> | undefined;
      if (input.event.type === "session.deleted") {
        const sessionID = (props?.info as { id?: string } | undefined)?.id;
        if (sessionID) {
          injectedSessions.delete(sessionID);
          recallSessions.delete(sessionID);
        }
      } else if (input.event.type === "server.instance.disposed") {
        injectedSessions.clear();
        recallSessions.clear();
      }

      if (compactionHook) {
        await compactionHook.event(input);
      }
      if (captureHook) {
        if (input.event.type === "session.idle") {
          void captureHook.event(input).catch((error) => {
            log("[capture] background idle capture failed", {
              error: String(error),
            });
          });
        } else {
          await captureHook.event(input);
        }
      }
    },
  };
};
