import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";

/** OpenCode V1 reads the singular `plugin` array. */
export const V1_PLUGIN_ENTRY = "opencode-supermemory@latest";
/**
 * OpenCode 2 reads the plural `plugins` array and resolves the package's
 * `./server` export (falling back to the root), so the bare package name is
 * enough. Leaving the version unpinned lets `opencode plugin update` work.
 */
export const V2_PLUGIN_ENTRY = "opencode-supermemory";

export const PACKAGE_NAME = "opencode-supermemory";

export { RECALL_PERMISSION } from "./opencode-permissions.js";
import { RECALL_PERMISSION } from "./opencode-permissions.js";

export interface OpenCodeConfigEditResult {
  content: string;
  changed: boolean;
  warnings: string[];
}

export interface OpenCodeRegistration {
  v1: boolean;
  v2: boolean;
  recallAllowed: boolean;
  recallDenied: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenCodeConfig(content: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`Invalid OpenCode JSONC config at offset ${first.offset}`);
  }

  if (!isObject(value)) {
    throw new Error("OpenCode config must contain a JSON object");
  }

  return value;
}

function getFormattingOptions(content: string): FormattingOptions {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const indent = content.match(/\r?\n([ \t]+)["}]/)?.[1];
  const usesTabs = indent?.includes("\t") ?? false;

  return {
    eol,
    insertSpaces: !usesTabs,
    tabSize: usesTabs ? 1 : Math.max(2, indent?.length ?? 2),
  };
}

function applyModification(
  content: string,
  path: Array<string | number>,
  value: unknown,
): string {
  return applyEdits(
    content,
    modify(content, path, value, {
      formattingOptions: getFormattingOptions(content),
    }),
  );
}

function getPluginPackage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.package === "string") {
    return value.package;
  }
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Any entry that refers to this package counts as registered, including local
 * `file:` checkouts and pinned versions, so the installer never adds a second
 * copy next to a development install.
 */
export function isSupermemoryPluginEntry(value: unknown): boolean {
  const packageName = getPluginPackage(value);
  return packageName !== undefined && packageName.includes(PACKAGE_NAME);
}

function addArrayEntry(
  content: string,
  property: string,
  value: unknown,
  alreadyPresent: (entry: unknown) => boolean,
): string {
  const config = parseOpenCodeConfig(content);
  const current = config[property];

  if (current === undefined) {
    return applyModification(content, [property], [value]);
  }

  if (!Array.isArray(current)) {
    throw new Error(`OpenCode config property "${property}" must be an array`);
  }

  if (current.some(alreadyPresent)) return content;
  return applyModification(content, [property, -1], value);
}

function isRecallPermission(value: unknown, effect: "allow" | "deny"): boolean {
  return (
    isObject(value) &&
    value.action === RECALL_PERMISSION.action &&
    value.resource === RECALL_PERMISSION.resource &&
    value.effect === effect
  );
}

export function readOpenCodeRegistration(content: string): OpenCodeRegistration {
  const config = parseOpenCodeConfig(content);
  const plugin = Array.isArray(config.plugin) ? config.plugin : [];
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const permissions = Array.isArray(config.permissions) ? config.permissions : [];
  return {
    v1: plugin.some(isSupermemoryPluginEntry),
    v2: plugins.some(isSupermemoryPluginEntry),
    recallAllowed: permissions.some((entry) => isRecallPermission(entry, "allow")),
    recallDenied: permissions.some((entry) => isRecallPermission(entry, "deny")),
  };
}

/**
 * Adds the OpenCode V1 and OpenCode 2 plugin entries without rewriting
 * unrelated JSONC. Existing entries (including local checkouts) are kept, and
 * an explicit recall deny is respected.
 */
export function editOpenCodeConfig(rawContent: string): OpenCodeConfigEditResult {
  const original = rawContent;
  let content = rawContent.trim() === "" ? "{}\n" : rawContent;
  const warnings: string[] = [];

  parseOpenCodeConfig(content);
  content = addArrayEntry(content, "plugin", V1_PLUGIN_ENTRY, isSupermemoryPluginEntry);
  content = addArrayEntry(content, "plugins", V2_PLUGIN_ENTRY, isSupermemoryPluginEntry);

  const config = parseOpenCodeConfig(content);
  const permissions = config.permissions;
  if (permissions !== undefined && !Array.isArray(permissions)) {
    throw new Error('OpenCode config property "permissions" must be an array');
  }

  const permissionEntries = permissions ?? [];
  if (permissionEntries.some((entry) => isRecallPermission(entry, "deny"))) {
    warnings.push(
      'OpenCode 2 permission "supermemory_recall" is explicitly denied; preserving the deny instead of adding an allow.',
    );
  } else if (
    !permissionEntries.some((entry) => isRecallPermission(entry, "allow"))
  ) {
    content = addArrayEntry(
      content,
      "permissions",
      RECALL_PERMISSION,
      (entry) => isRecallPermission(entry, "allow"),
    );
  }

  return {
    content,
    changed: content !== original,
    warnings,
  };
}
