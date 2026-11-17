import { describe, expect, test } from "bun:test";

import {
  editOpenCodeConfig,
  editOpenCodeTuiConfig,
  readOpenCodeRegistration,
  readOpenCodeTuiRegistration,
  RECALL_PERMISSION,
  V1_PLUGIN_ENTRY,
  V2_PLUGIN_ENTRY,
} from "./opencode-config.js";

describe("OpenCode config editor", () => {
  test("registers both plugin generations in an empty config", () => {
    const result = editOpenCodeConfig("");
    const config = JSON.parse(result.content);

    expect(result.changed).toBe(true);
    expect(config.plugin).toEqual([V1_PLUGIN_ENTRY]);
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permission).toEqual({ supermemory_recall: "allow" });
    expect(config.permissions).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("preserves comments and existing local checkouts, and is idempotent", () => {
    const original = `{
  // OpenCode V1 loads a local checkout while developing
  "plugin": ["file:///Users/me/opencode-supermemory"],
  "$schema": "https://opencode.ai/config.json",
}
`;
    const first = editOpenCodeConfig(original);
    expect(first.changed).toBe(true);
    expect(first.content).toContain("// OpenCode V1 loads a local checkout");
    expect(first.content).toContain('"file:///Users/me/opencode-supermemory"');
    expect(first.content).not.toContain(V1_PLUGIN_ENTRY);
    const config = JSON.parse(first.content.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    expect(config.plugins).toEqual([V2_PLUGIN_ENTRY]);
    expect(config.permission).toEqual({ supermemory_recall: "allow" });

    const second = editOpenCodeConfig(first.content);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);

    const registration = readOpenCodeRegistration(first.content);
    expect(registration).toEqual({
      v1: true,
      v2: true,
      recallAllowed: true,
      recallDenied: false,
    });
  });

  test("recognises object entries and pinned versions as registered", () => {
    const content = JSON.stringify({
      plugin: ["opencode-supermemory@2.0.13"],
      plugins: [{ package: "opencode-supermemory@latest", options: {} }],
      permission: { supermemory_recall: "allow" },
    });
    expect(editOpenCodeConfig(content).changed).toBe(false);
  });

  test("moves the V2 recall rule that OpenCode V1 rejects into V1 permission rules", () => {
    const other = { action: "bash", resource: "*", effect: "ask" };
    const onlyRecall = JSON.parse(
      editOpenCodeConfig(JSON.stringify({ permissions: [RECALL_PERMISSION] })).content,
    );
    expect(onlyRecall.permissions).toBeUndefined();
    expect(onlyRecall.permission).toEqual({ supermemory_recall: "allow" });

    const withOther = JSON.parse(
      editOpenCodeConfig(JSON.stringify({ permissions: [RECALL_PERMISSION, other] })).content,
    );
    expect(withOther.permissions).toEqual([other]);
    expect(withOther.permission).toEqual({ supermemory_recall: "allow" });
  });

  test("keeps an explicit recall deny and warns instead of overriding it", () => {
    const deny = { ...RECALL_PERMISSION, effect: "deny" };
    const result = editOpenCodeConfig(JSON.stringify({ permissions: [deny] }));
    const config = JSON.parse(result.content);

    expect(config.permissions).toEqual([deny]);
    expect(config.permission).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(readOpenCodeRegistration(result.content).recallDenied).toBe(true);

    const v1Deny = editOpenCodeConfig(JSON.stringify({ permission: { supermemory_recall: "deny" } }));
    expect(JSON.parse(v1Deny.content).permission).toEqual({ supermemory_recall: "deny" });
    expect(v1Deny.warnings).toHaveLength(1);
  });

  test("rejects configs whose arrays are not arrays", () => {
    expect(() => editOpenCodeConfig('{"plugins": "nope"}')).toThrow(
      /must be an array/,
    );
  });
});

describe("OpenCode V1 TUI config editor", () => {
  test("adds the package to tui.jsonc once and recognises local builds", () => {
    const first = editOpenCodeTuiConfig("");
    expect(JSON.parse(first.content)).toEqual({ plugin: [V1_PLUGIN_ENTRY] });
    expect(editOpenCodeTuiConfig(first.content).changed).toBe(false);

    const local = '{\n  "plugin": ["file:///Users/me/opencode-supermemory/dist/tui.js"]\n}\n';
    expect(editOpenCodeTuiConfig(local).changed).toBe(false);
    expect(readOpenCodeTuiRegistration(local)).toBe(true);
    expect(readOpenCodeTuiRegistration('{"plugin": ["other"]}')).toBe(false);
  });
});
