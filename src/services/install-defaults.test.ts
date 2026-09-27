import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyInstallDefaults,
  resolveConfigFilePath,
  writeInstallDefaults,
} from "./install-defaults.js";

describe("installer config defaults", () => {
  test("prefers supermemory.jsonc and falls back to supermemory.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-config-"));
    try {
      expect(resolveConfigFilePath(dir)).toBe(join(dir, "supermemory.json"));
      writeFileSync(join(dir, "supermemory.jsonc"), "{}\n");
      expect(resolveConfigFilePath(dir)).toBe(join(dir, "supermemory.jsonc"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edits an existing JSONC file in place without copying or dropping anything", () => {
    const original = '{\n  // per README\n  "apiKey": "sm_test_key_1234"\n}\n';
    const result = applyInstallDefaults(original, true);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("// per README");
    expect(result.content).toContain('"apiKey": "sm_test_key_1234"');
    expect(result.content).toContain('"captureEveryNTurns": 3');
    expect(result.content).not.toContain("recallMode");
    expect(applyInstallDefaults(result.content, true).changed).toBe(false);
  });

  test("fresh installs get direct recall and session-end capture, existing values win", () => {
    const fresh = JSON.parse(applyInstallDefaults("", false).content);
    expect(fresh).toEqual({ recallMode: "direct", captureEveryNTurns: 0 });

    const custom = applyInstallDefaults('{"recallMode": "advisory"}', false);
    expect(JSON.parse(custom.content)).toEqual({ recallMode: "advisory", captureEveryNTurns: 0 });
  });

  test("creates the config directory and writes only the file the plugin reads", () => {
    const home = mkdtempSync(join(tmpdir(), "sm-home-"));
    const dir = join(home, ".config", "opencode");
    try {
      const first = writeInstallDefaults(dir);
      expect(first.path).toBe(join(dir, "supermemory.json"));
      expect(existsSync(first.path)).toBe(true);

      rmSync(first.path);
      writeFileSync(join(dir, "supermemory.jsonc"), '{\n  // keep me\n  "apiKey": "sm_x"\n}\n');
      const second = writeInstallDefaults(dir);
      expect(second.path).toBe(join(dir, "supermemory.jsonc"));
      expect(existsSync(join(dir, "supermemory.json"))).toBe(false);
      expect(readFileSync(second.path, "utf-8")).toContain("// keep me");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
