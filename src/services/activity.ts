import type { PluginInput } from "@opencode-ai/plugin";

import { log } from "./logger.js";
import type { UpdateInfo } from "./version-check.js";

export type ActivityVariant = "info" | "success" | "warning" | "error";

export type ActivityKind =
  | "recalling"
  | "recalled"
  | "recall-unavailable"
  | "saved"
  | "update-available";

/** A user-facing notice about Supermemory activity, independent of the UI. */
export interface MemoryActivityNotice {
  kind: ActivityKind;
  title: string;
  message: string;
  variant: ActivityVariant;
  duration: number;
}

export interface MemoryActivityReporter {
  recalling(query?: string): void;
  recalled(count: number, tokens: number): void;
  recallUnavailable(): void;
  saved(): void;
  updateAvailable(info: UpdateInfo): void;
}

export const ACTIVITY_TITLE = "Supermemory";
const ACTIVITY_PREFIX = "◪ supermemory · ";

function notice(
  kind: ActivityKind,
  message: string,
  variant: ActivityVariant,
  duration: number,
): MemoryActivityNotice {
  return {
    kind,
    title: ACTIVITY_TITLE,
    message: `${ACTIVITY_PREFIX}${message}`,
    variant,
    duration,
  };
}

/**
 * Builds reporters on top of any notice sink, so OpenCode V1 (TUI toasts) and
 * OpenCode 2 (plugin RPC events rendered by the TUI plugin) show the same text.
 */
export function createMemoryActivityReporterFromSink(
  show: (notice: MemoryActivityNotice) => void,
): MemoryActivityReporter {
  const emit = (item: MemoryActivityNotice) => {
    try {
      show(item);
    } catch (error) {
      log("[activity] unable to show notification", { error: String(error) });
    }
  };

  return {
    recalling(query) {
      const suffix = query?.trim() ? `: ${query.trim().slice(0, 100)}` : "";
      emit(notice("recalling", `recalling${suffix}`, "info", 2_000));
    },
    recalled(count, tokens) {
      emit(
        notice(
          "recalled",
          `recalled ${count} ${count === 1 ? "memory" : "memories"} (${tokens} tok)`,
          "success",
          3_000,
        ),
      );
    },
    recallUnavailable() {
      emit(
        notice(
          "recall-unavailable",
          "recall unavailable; continuing without recalled context",
          "warning",
          3_000,
        ),
      );
    },
    saved() {
      emit(notice("saved", "saved this turn", "success", 2_000));
    },
    updateAvailable(info) {
      emit(
        notice(
          "update-available",
          `update available: v${info.currentVersion} → v${info.latestVersion} · ${info.updateCommand}`,
          "info",
          8_000,
        ),
      );
    },
  };
}

interface ToastClient {
  tui: {
    showToast: PluginInput["client"]["tui"]["showToast"];
  };
}

/** OpenCode V1 reporter: native TUI toasts via the SDK client. */
export function createMemoryActivityReporter(
  client: ToastClient,
): MemoryActivityReporter {
  return createMemoryActivityReporterFromSink((item) => {
    void client.tui
      .showToast({
        body: {
          title: item.title,
          message: item.message,
          variant: item.variant,
          duration: item.duration,
        },
      })
      .catch((error) => {
        log("[activity] unable to show TUI notification", {
          error: String(error),
        });
      });
  });
}
