import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

/** Candidate config files, in the order the plugin reads them. */
export const CONFIG_FILE_NAMES = ["supermemory.jsonc", "supermemory.json"] as const;

/**
 * The config file the plugin will actually read: the first existing candidate,
 * or `supermemory.json` when none exists yet.
 */
export function resolveConfigFilePath(configDir: string): string {
  for (const name of CONFIG_FILE_NAMES) {
    const path = join(configDir, name);
    if (existsSync(path)) return path;
  }
  return join(configDir, CONFIG_FILE_NAMES[1]);
}

export interface InstallDefaultsResult {
  content: string;
  changed: boolean;
}

function parseJsonc(content: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid Supermemory config at offset ${errors[0]!.offset}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Supermemory config must contain a JSON object");
  }
  return value as Record<string, unknown>;
}

function formattingOptions(content: string) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const indent = content.match(/\r?\n([ \t]+)"/)?.[1];
  const usesTabs = indent?.includes("\t") ?? false;
  return { eol, insertSpaces: !usesTabs, tabSize: usesTabs ? 1 : Math.max(2, indent?.length ?? 2) };
}

/**
 * Applies the installer defaults to existing config content without touching
 * anything else, so comments and the user's other keys survive. A fresh
 * install gets `recallMode: "direct"` and session-end-only capture; an
 * existing install keeps its recall mode and only fills in the capture
 * cadence older versions assumed.
 */
export function applyInstallDefaults(
  rawContent: string,
  isExistingInstall: boolean,
): InstallDefaultsResult {
  let content = rawContent.trim() === "" ? "{}\n" : rawContent;
  const current = parseJsonc(content);
  const updates: Array<[string, unknown]> = [];

  if (isExistingInstall) {
    if (current.captureEveryNTurns === undefined) updates.push(["captureEveryNTurns", 3]);
  } else {
    if (current.recallMode === undefined) updates.push(["recallMode", "direct"]);
    if (current.captureEveryNTurns === undefined) updates.push(["captureEveryNTurns", 0]);
  }

  for (const [key, value] of updates) {
    content = applyEdits(
      content,
      modify(content, [key], value, { formattingOptions: formattingOptions(content) }),
    );
  }
  return { content, changed: content !== rawContent };
}

/**
 * Writes installer defaults into the config file the plugin reads, creating
 * the config directory when needed. Returns the path that was used.
 */
export function writeInstallDefaults(configDir: string): { path: string; changed: boolean } {
  mkdirSync(configDir, { recursive: true });
  const path = resolveConfigFilePath(configDir);
  const exists = existsSync(path);
  const result = applyInstallDefaults(exists ? readFileSync(path, "utf-8") : "", exists);
  if (result.changed) writeFileSync(path, result.content);
  return { path, changed: result.changed };
}
