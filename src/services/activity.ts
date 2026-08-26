import type { PluginInput } from "@opencode-ai/plugin";

import { log } from "./logger.js";
import { getUserFriendlyError } from "./error-helpers.js";
import type { UpdateInfo } from "./version-check.js";

type ToastVariant = "info" | "success" | "warning" | "error";

interface ToastClient {
  tui: {
    showToast: PluginInput["client"]["tui"]["showToast"];
  };
}

export interface MemoryActivityReporter {
  recalling(query?: string): void;
  recalled(count: number, tokens: number): void;
  recallUnavailable(error?: string): void;
  saved(): void;
  updateAvailable(info: UpdateInfo): void;
}

export function createMemoryActivityReporter(
  client: ToastClient,
): MemoryActivityReporter {
  const show = (
    message: string,
    variant: ToastVariant,
    duration: number,
  ) => {
    void client.tui
      .showToast({
        body: {
          title: "Supermemory",
          message: `◪ supermemory · ${message}`,
          variant,
          duration,
        },
      })
      .catch((error) => {
        log("[activity] unable to show TUI notification", {
          error: String(error),
        });
      });
  };

  return {
    recalling(query) {
      const suffix = query?.trim() ? `: ${query.trim().slice(0, 100)}` : "";
      show(`recalling${suffix}`, "info", 2_000);
    },
    recalled(count, tokens) {
      show(
        `recalled ${count} ${count === 1 ? "memory" : "memories"} (${tokens} tok)`,
        "success",
        3_000,
      );
    },
    recallUnavailable(error) {
      show(
        `recall failed: ${getUserFriendlyError(error).slice(0, 100)}`,
        "warning",
        3_000,
      );
    },
    saved() {
      show("saved this turn", "success", 2_000);
    },
    updateAvailable(info) {
      show(
        `update available: v${info.currentVersion} → v${info.latestVersion} · ${info.updateCommand}`,
        "info",
        8_000,
      );
    },
  };
}
