import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";
import {
  RECALL_PERMISSION,
  V1_PLUGIN_ENTRY,
  V2_PLUGIN_ENTRY,
  editOpenCodeConfig,
} from "./opencode-config.js";

function parseJsonc(content: string): Record<string, unknown> {
  return parse(content, undefined, { allowTrailingComma: true }) as Record<
    string,
    unknown
  >;
}

describe("OpenCode V1/V2 config installation", () => {
  test("creates both plugin entries and the narrow recall permission", () => {
    const result = editOpenCodeConfig("{}\n");
    const config = parseJsonc(result.content);

    expect(config.plugin).toEqual([V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([RECALL_PERMISSION]);
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("preserves unrelated JSON values while extending existing arrays", () => {
    const input = JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        theme: "system",
        plugin: ["other-v1-plugin"],
        plugins: ["other-v2-plugin"],
        permissions: [
          { action: "shell", resource: "*", effect: "ask" },
        ],
      },
      null,
      2,
    );

    const result = editOpenCodeConfig(input);
    const config = JSON.parse(result.content) as Record<string, unknown>;

    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.theme).toBe("system");
    expect(config.plugin).toEqual(["other-v1-plugin", V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual(["other-v2-plugin", V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      RECALL_PERMISSION,
    ]);
  });

  test("preserves JSONC comments and trailing commas", () => {
    const input = `{
  // Keep the user's selected theme.
  "theme": "catppuccin", // inline comment
  "plugin": [
    "other-v1-plugin", // keep this plugin
  ],
  "permissions": [
    // Keep the shell policy.
    { "action": "shell", "resource": "*", "effect": "ask" },
  ],
}
`;

    const result = editOpenCodeConfig(input);
    const config = parseJsonc(result.content);

    expect(result.content).toContain("// Keep the user's selected theme.");
    expect(result.content).toContain("// inline comment");
    expect(result.content).toContain("// keep this plugin");
    expect(result.content).toContain("// Keep the shell policy.");
    expect(config.theme).toBe("catppuccin");
    expect(config.plugin).toEqual(["other-v1-plugin", V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      RECALL_PERMISSION,
    ]);
  });

  test("keeps an existing V1 version and fills only missing V2 fields", () => {
    const input = `{
  "plugin": ["opencode-supermemory@2.0.12"],
  "plugins": ["other-v2-plugin"]
}
`;

    const result = editOpenCodeConfig(input);
    const config = parseJsonc(result.content);

    expect(config.plugin).toEqual(["opencode-supermemory@2.0.12"]);
    expect(config.plugins).toEqual(["other-v2-plugin", V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([RECALL_PERMISSION]);
  });

  test("adds the V1 entry when only the V2 entry is already present", () => {
    const input = JSON.stringify(
      {
        plugins: [V2_PLUGIN_ENTRY],
        permissions: [RECALL_PERMISSION],
      },
      null,
      2,
    );

    const result = editOpenCodeConfig(input);
    const config = JSON.parse(result.content) as Record<string, unknown>;

    expect(config.plugin).toEqual([V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([RECALL_PERMISSION]);
  });

  test("preserves an object-form V2 entry without adding a duplicate", () => {
    const configuredV2 = {
      package: "opencode-supermemory/v2",
      options: { captureEveryNTurns: 5 },
    };
    const input = JSON.stringify({ plugins: [configuredV2] }, null, 2);

    const result = editOpenCodeConfig(input);
    const config = JSON.parse(result.content) as Record<string, unknown>;

    expect(config.plugin).toEqual([V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([configuredV2]);
    expect(config.permissions).toEqual([RECALL_PERMISSION]);
  });

  test("preserves an explicit recall deny and returns a warning", () => {
    const deny = {
      action: "supermemory_recall",
      resource: "*",
      effect: "deny",
    };
    const input = JSON.stringify({ permissions: [deny] }, null, 2);

    const result = editOpenCodeConfig(input);
    const config = JSON.parse(result.content) as Record<string, unknown>;

    expect(config.plugin).toEqual([V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permissions).toEqual([deny]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("explicitly denied");
  });

  test("is byte-for-byte idempotent after the first install", () => {
    const first = editOpenCodeConfig(`{
  "plugin": ["other-v1-plugin"],
  "plugins": ["other-v2-plugin"]
}
`);
    const second = editOpenCodeConfig(first.content);

    expect(second.content).toBe(first.content);
    expect(second.changed).toBe(false);
    expect(second.warnings).toEqual([]);
  });
});
