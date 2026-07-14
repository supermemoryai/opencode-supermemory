import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stripJsoncComments } from "../src/services/jsonc.js";

const REPO_ROOT = join(import.meta.dir, "..");
const temporaryHomes: string[] = [];

interface ProbeResult {
  selectedFile: string;
  autoRecallEveryPrompt: boolean;
  captureEveryNTurns: number;
  apiKey?: string;
  writeError?: string;
  jsonc?: Record<string, unknown>;
  json?: Record<string, unknown>;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "opencode-supermemory-test-"));
  temporaryHomes.push(home);
  return home;
}

function configPath(home: string, extension: "json" | "jsonc"): string {
  return join(home, ".config", "opencode", `supermemory.${extension}`);
}

function writeConfig(home: string, extension: "json" | "jsonc", content: string): void {
  const path = configPath(home, extension);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function childEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    SUPERMEMORY_API_KEY: "",
    SUPERMEMORY_API_URL: "",
    SUPERMEMORY_BASE_URL: "",
  } as Record<string, string>;
}

function runConfigProbe(home: string): ProbeResult {
  const script = `
    const { existsSync, readFileSync } = await import("node:fs");
    const config = await import("./src/config.ts");
    const { stripJsoncComments } = await import("./src/services/jsonc.ts");
    let writeError;
    try {
      config.writeInstallDefaults(existsSync(config.CONFIG_FILE));
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }
    const read = (path) => {
      if (!existsSync(path)) return undefined;
      const raw = readFileSync(path, "utf-8");
      try {
        return JSON.parse(stripJsoncComments(raw));
      } catch {
        return { invalidRawContent: raw };
      }
    };
    const dir = ${JSON.stringify(join(home, ".config", "opencode"))};
    console.log(JSON.stringify({
      selectedFile: config.CONFIG_FILE,
      autoRecallEveryPrompt: config.CONFIG.autoRecallEveryPrompt,
      captureEveryNTurns: config.CONFIG.captureEveryNTurns,
      apiKey: config.SUPERMEMORY_API_KEY,
      writeError,
      jsonc: read(dir + "/supermemory.jsonc"),
      json: read(dir + "/supermemory.json"),
    }));
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: REPO_ROOT,
    env: childEnv(home),
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()) as ProbeResult;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("selected Supermemory config path", () => {
  test("uses and updates an existing JSONC file without creating JSON", () => {
    const home = makeHome();
    const original = `{
      // JSONC is the active config.
      "apiKey": "sm_jsonc_1234567890",
      "autoRecallEveryPrompt": false,
      "captureEveryNTurns": 7,
    }\n`;
    writeConfig(home, "jsonc", original);

    const result = runConfigProbe(home);

    expect(basename(result.selectedFile)).toBe("supermemory.jsonc");
    expect(result.autoRecallEveryPrompt).toBe(false);
    expect(result.captureEveryNTurns).toBe(7);
    expect(result.jsonc).toMatchObject({
      apiKey: "sm_jsonc_1234567890",
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 7,
    });
    expect(readFileSync(configPath(home, "jsonc"), "utf-8")).toBe(original);
    expect(result.json).toBeUndefined();
  });

  const jsoncInsertionCases = [
    {
      name: "leading comments before the root and nested values with LF",
      prefix: "/* leading comment with { */\n// second leading comment\n",
      tail: '\n  "apiKey": "sm_leading",\n  "nested": { "list": [1, { "value": "unchanged" }] },\n}\n',
      insertion: '  "autoRecallEveryPrompt": true,\n  "captureEveryNTurns": 3,\n',
      expected: {
        apiKey: "sm_leading",
        nested: { list: [1, { value: "unchanged" }] },
        autoRecallEveryPrompt: true,
        captureEveryNTurns: 3,
      },
    },
    {
      name: "empty one-line object without an existing-property separator",
      prefix: "",
      tail: "}\n",
      insertion: ' "autoRecallEveryPrompt": true, "captureEveryNTurns": 3 ',
      expected: { autoRecallEveryPrompt: true, captureEveryNTurns: 3 },
    },
    {
      name: "comment-only object without a trailing comma",
      prefix: "",
      tail: "\n  // keep line comment\n  /* keep block comment */\n}\n",
      insertion: '  "autoRecallEveryPrompt": true,\n  "captureEveryNTurns": 3\n',
      expected: { autoRecallEveryPrompt: true, captureEveryNTurns: 3 },
    },
    {
      name: "one-line object with an existing-property separator",
      prefix: "",
      tail: '"apiKey":"sm_one","metadata":{"enabled":true}}\n',
      insertion: ' "autoRecallEveryPrompt": true, "captureEveryNTurns": 3, ',
      expected: {
        apiKey: "sm_one",
        metadata: { enabled: true },
        autoRecallEveryPrompt: true,
        captureEveryNTurns: 3,
      },
    },
    {
      name: "only captureEveryNTurns missing",
      prefix: "",
      tail: '\n  "autoRecallEveryPrompt": false,\n  "apiKey": "sm_one_missing"\n}\n',
      insertion: '  "captureEveryNTurns": 3,\n',
      expected: {
        apiKey: "sm_one_missing",
        autoRecallEveryPrompt: false,
        captureEveryNTurns: 3,
      },
    },
    {
      name: "CRLF content and trailing-comma style",
      prefix: "",
      tail: '\r\n\t"apiKey": "sm_crlf",\r\n}\r\n',
      insertion: '\t"autoRecallEveryPrompt": true,\r\n\t"captureEveryNTurns": 3,\r\n',
      expected: {
        apiKey: "sm_crlf",
        autoRecallEveryPrompt: true,
        captureEveryNTurns: 3,
      },
    },
    {
      name: "blank first line uses the next content indentation",
      prefix: "",
      tail: '\n\n    "apiKey": "sm_blank_line"\n  }\n',
      insertion: '    "autoRecallEveryPrompt": true,\n    "captureEveryNTurns": 3,\n',
      expected: {
        apiKey: "sm_blank_line",
        autoRecallEveryPrompt: true,
        captureEveryNTurns: 3,
      },
    },
  ];

  for (const fixture of jsoncInsertionCases) {
    test(`adds only missing JSONC defaults: ${fixture.name}`, () => {
      const home = makeHome();
      const original = `${fixture.prefix}{${fixture.tail}`;
      writeConfig(home, "jsonc", original);

      const result = runConfigProbe(home);
      const raw = readFileSync(configPath(home, "jsonc"), "utf-8");
      const parsed = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
      let insertionOffset = 0;
      while (fixture.tail[insertionOffset] === " " || fixture.tail[insertionOffset] === "\t") {
        insertionOffset++;
      }
      if (fixture.tail.startsWith("\r\n", insertionOffset)) {
        insertionOffset += 2;
      } else if (fixture.tail[insertionOffset] === "\r" || fixture.tail[insertionOffset] === "\n") {
        insertionOffset++;
      } else {
        insertionOffset = 0;
      }
      const preservedPrefix = `${fixture.prefix}{${fixture.tail.slice(0, insertionOffset)}`;
      const preservedSuffix = fixture.tail.slice(insertionOffset);
      const insertionEnd = raw.length - preservedSuffix.length;

      expect(basename(result.selectedFile)).toBe("supermemory.jsonc");
      expect(result.writeError).toBeUndefined();
      expect(raw.slice(0, preservedPrefix.length)).toBe(preservedPrefix);
      expect(raw.slice(insertionEnd)).toBe(preservedSuffix);
      expect(raw.slice(preservedPrefix.length, insertionEnd)).toBe(fixture.insertion);
      expect(raw.split('"autoRecallEveryPrompt"').length - 1).toBe(1);
      expect(raw.split('"captureEveryNTurns"').length - 1).toBe(1);
      expect(parsed).toEqual(fixture.expected);
      expect(result.json).toBeUndefined();
    });
  }

  test("uses and updates an existing JSON file", () => {
    const home = makeHome();
    writeConfig(home, "json", JSON.stringify({
      apiKey: "sm_json_1234567890",
      autoRecallEveryPrompt: true,
      captureEveryNTurns: 5,
    }));

    const result = runConfigProbe(home);

    expect(basename(result.selectedFile)).toBe("supermemory.json");
    expect(result.autoRecallEveryPrompt).toBe(true);
    expect(result.captureEveryNTurns).toBe(5);
    expect(result.json).toMatchObject({
      apiKey: "sm_json_1234567890",
      autoRecallEveryPrompt: true,
      captureEveryNTurns: 5,
    });
    expect(result.jsonc).toBeUndefined();
  });

  test("creates JSON with fresh-install defaults when neither file exists", () => {
    const home = makeHome();

    const result = runConfigProbe(home);

    expect(basename(result.selectedFile)).toBe("supermemory.json");
    expect(result.autoRecallEveryPrompt).toBe(false);
    expect(result.captureEveryNTurns).toBe(0);
    expect(result.json).toEqual({
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 0,
    });
    expect(result.jsonc).toBeUndefined();
  });

  test("keeps JSONC authoritative when both files exist", () => {
    const home = makeHome();
    writeConfig(home, "jsonc", JSON.stringify({
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 8,
    }));
    writeConfig(home, "json", JSON.stringify({
      autoRecallEveryPrompt: true,
      captureEveryNTurns: 2,
      untouched: "json fallback",
    }));

    const result = runConfigProbe(home);

    expect(basename(result.selectedFile)).toBe("supermemory.jsonc");
    expect(result.autoRecallEveryPrompt).toBe(false);
    expect(result.captureEveryNTurns).toBe(8);
    expect(result.jsonc).toMatchObject({
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 8,
    });
    expect(result.json).toEqual({
      autoRecallEveryPrompt: true,
      captureEveryNTurns: 2,
      untouched: "json fallback",
    });
  });

  test("does not fall through or overwrite an invalid preferred JSONC file", () => {
    const home = makeHome();
    writeConfig(home, "jsonc", "{ invalid jsonc");
    writeConfig(home, "json", JSON.stringify({
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 11,
      untouched: "json fallback",
    }));

    const result = runConfigProbe(home);

    expect(basename(result.selectedFile)).toBe("supermemory.jsonc");
    expect(result.autoRecallEveryPrompt).toBe(true);
    expect(result.captureEveryNTurns).toBe(3);
    expect(result.writeError).toContain(`Cannot update invalid Supermemory config at ${configPath(home, "jsonc")}`);
    expect(result.jsonc).toEqual({ invalidRawContent: "{ invalid jsonc" });
    expect(result.json).toEqual({
      autoRecallEveryPrompt: false,
      captureEveryNTurns: 11,
      untouched: "json fallback",
    });
  });

  const nonObjectConfigCases = [
    { name: "array", content: '["not", "a", "config"]\n' },
    { name: "string", content: '"not a config"\n' },
    { name: "number", content: "42\n" },
    { name: "null", content: "null\n" },
  ];

  for (const extension of ["json", "jsonc"] as const) {
    for (const fixture of nonObjectConfigCases) {
      test(`rejects ${fixture.name} root in selected ${extension.toUpperCase()} without rewriting it`, () => {
        const home = makeHome();
        writeConfig(home, extension, fixture.content);

        const result = runConfigProbe(home);

        expect(basename(result.selectedFile)).toBe(`supermemory.${extension}`);
        expect(result.writeError).toContain("expected a top-level object");
        expect(readFileSync(configPath(home, extension), "utf-8")).toBe(fixture.content);
        expect(existsSync(configPath(home, extension === "json" ? "jsonc" : "json"))).toBe(false);
      });
    }
  }
});

test("install stops without changing an invalid selected config", () => {
  const home = makeHome();
  const path = configPath(home, "jsonc");
  const invalidContent = "{ invalid jsonc";
  writeConfig(home, "jsonc", invalidContent);

  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", "install", "--no-tui"],
    cwd: REPO_ROOT,
    env: childEnv(home),
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`Cannot update invalid Supermemory config at ${path}`);
  expect(readFileSync(path, "utf-8")).toBe(invalidContent);
  expect(existsSync(configPath(home, "json"))).toBe(false);
});

test("status reports the selected JSONC source without revealing its API key", () => {
  const home = makeHome();
  const apiKey = "sm_status_1234567890";
  const fallbackApiKey = "sm_fallback_1234567890";
  const path = configPath(home, "jsonc");
  writeConfig(home, "jsonc", `{
    // The status command must parse JSONC through the same selected path.
    "apiKey": "${apiKey}",
    "baseUrl": "http://127.0.0.1:1"
  }`);
  writeConfig(home, "json", JSON.stringify({
    apiKey: fallbackApiKey,
    baseUrl: "http://127.0.0.1:2",
  }));

  const script = `
    globalThis.fetch = async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    process.argv = [process.execPath, "src/cli.ts", "status"];
    await import("./src/cli.ts");
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: REPO_ROOT,
    env: childEnv(home),
  });
  const output = result.stdout.toString();

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(output).toContain(`API key: sm_sta...7890 (${path})`);
  expect(output).not.toContain(apiKey);
  expect(output).not.toContain(fallbackApiKey);
});
