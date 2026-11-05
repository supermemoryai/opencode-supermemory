import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripJsoncComments } from "./jsonc.js";

describe("JSONC configuration strings", () => {
  test("preserves comma-delimiter sequences inside strings while removing trailing commas", () => {
    const value = 'Keep ,} and , ] literally, including escaped "quotes", \\ paths and https://example.com';
    const input = `{
      // A comma before a comment is still a trailing comma.
      "values": [${JSON.stringify(value)}, /* comment */ ],
      "nested": {"value": ${JSON.stringify(value)},},
    }`;
    expect(JSON.parse(stripJsoncComments(input))).toEqual({
      values: [value],
      nested: { value },
    });
  });

  test("leaves unterminated escaped-quote strings invalid", () => {
    const input = '{"filterPrompt":"' + '\\"'.repeat(50_000) + ',}';
    expect(stripJsoncComments(input)).toBe(input);
    expect(() => JSON.parse(stripJsoncComments(input))).toThrow();
  });

  for (const filename of ["supermemory.jsonc", "supermemory.json"]) {
    test(`loads memory prompts unchanged from ${filename}`, () => {
      const home = mkdtempSync(join(tmpdir(), "supermemory-jsonc-"));
      try {
        const directory = join(home, ".config", "opencode");
        mkdirSync(directory, { recursive: true });
        const filterPrompt = 'Preserve JSON examples containing ",}" or ",]" in memories.';
        const recallDirective = 'Search for the literal syntax , } and , ] without changing punctuation.';
        const values = { filterPrompt, recallDirective };
        const json = JSON.stringify(values, null, 2);
        const content = filename.endsWith(".jsonc")
          ? `// memory extraction instructions\n${json.slice(0, -1).trimEnd()},\n}\n`
          : json;
        writeFileSync(join(directory, filename), content);
        // Import the production configuration in a fresh process: CONFIG is
        // initialized at module load, and must read this isolated home only.
        const configUrl = new URL("../config.ts", import.meta.url).href;
        const output = execFileSync(process.execPath, [
          "--eval",
          `import { CONFIG } from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({ filterPrompt: CONFIG.filterPrompt, recallDirective: CONFIG.recallDirective }));`,
        ], {
          encoding: "utf8",
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
        expect(JSON.parse(output)).toEqual(values);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
