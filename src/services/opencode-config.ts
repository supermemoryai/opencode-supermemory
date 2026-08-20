import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

export const V1_PLUGIN_ENTRY = "opencode-supermemory@latest";
export const V2_PLUGIN_ENTRY = "opencode-supermemory/v2";

export const RECALL_PERMISSION = {
  action: "supermemory_recall",
  resource: "*",
  effect: "allow",
} as const;

export interface OpenCodeConfigEditResult {
  content: string;
  changed: boolean;
  warnings: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(content: string): JsonObject {
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
  return undefined;
}

function isV1Plugin(value: unknown): boolean {
  const packageName = getPluginPackage(value);
  return (
    packageName !== undefined &&
    /^(?:npm:)?opencode-supermemory(?:@[^/]+)?$/.test(packageName)
  );
}

function isV2Plugin(value: unknown): boolean {
  const packageName = getPluginPackage(value);
  return (
    packageName !== undefined &&
    /^(?:npm:)?opencode-supermemory(?:@[^/]+)?\/v2$/.test(packageName)
  );
}

function addArrayEntry(
  content: string,
  property: string,
  value: unknown,
  alreadyPresent: (entry: unknown) => boolean,
): string {
  const config = parseConfig(content);
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

/**
 * Adds the OpenCode V1 and V2 plugin entries without rewriting unrelated JSONC.
 * Existing package versions are kept, and an explicit recall deny is respected.
 */
export function editOpenCodeConfig(rawContent: string): OpenCodeConfigEditResult {
  const original = rawContent;
  let content = rawContent.trim() === "" ? "{}\n" : rawContent;
  const warnings: string[] = [];

  parseConfig(content);
  content = addArrayEntry(content, "plugin", V1_PLUGIN_ENTRY, isV1Plugin);
  content = addArrayEntry(content, "plugins", V2_PLUGIN_ENTRY, isV2Plugin);

  const config = parseConfig(content);
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
