import type { Plugin, PluginInput } from "@opencode-ai/plugin/v1";
import type { Part, Permission } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/v1";

import { supermemoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { createCaptureHook } from "./services/capture.js";
import { buildRecallDirective } from "./services/recall.js";
import { getTags } from "./services/tags.js";
import { createCompactionHook, type CompactionContext } from "./services/compaction.js";
import {
  executeSupermemoryTool,
  type SupermemoryToolArgs,
} from "./services/memory-tool.js";

import { isConfigured, CONFIG, PLUGIN_VERSION } from "./config.js";
import { log } from "./services/logger.js";
import { checkNpmUpdate, formatUpdateNotice } from "./services/version-check.js";

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

  const compactionHook = isConfigured() && ctx.client && CONFIG.compactionEnabled
    ? createCompactionHook(ctx as CompactionContext, tags)
    : null;
  const captureHook = isConfigured() && ctx.client
    ? createCaptureHook(ctx, tags)
    : null;

  return {
    "experimental.session.compacting": compactionHook
      ? async (input, output) => {
          await compactionHook.compacting(input, output);
        }
      : undefined,

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
        async execute(args: SupermemoryToolArgs) {
          return executeSupermemoryTool(args, tags);
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
