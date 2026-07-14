import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { stripJsoncComments } from "./services/jsonc.js";
import { loadCredentials } from "./services/auth.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
export const PLUGIN_VERSION = "2.0.8";

function resolveConfigFile(configDir = CONFIG_DIR): string {
  const jsoncFile = join(configDir, "supermemory.jsonc");
  const jsonFile = join(configDir, "supermemory.json");
  return [jsoncFile, jsonFile].find((path) => existsSync(path)) ?? jsonFile;
}

export const CONFIG_FILE = resolveConfigFile();

export const DEFAULT_BASE_URL = "https://api.supermemory.ai";

interface SupermemoryConfig {
  apiKey?: string;
  baseUrl?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProjectMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  userContainerTag?: string;
  projectContainerTag?: string;
  filterPrompt?: string;
  keywordPatterns?: string[];
  compactionThreshold?: number;
  autoRecallEveryPrompt?: boolean;
  captureEveryNTurns?: number;
}

const DEFAULT_KEYWORD_PATTERNS = [
  "remember",
  "memorize",
  "save\\s+this",
  "note\\s+this",
  "keep\\s+in\\s+mind",
  "don'?t\\s+forget",
  "learn\\s+this",
  "store\\s+this",
  "record\\s+this",
  "make\\s+a\\s+note",
  "take\\s+note",
  "jot\\s+down",
  "commit\\s+to\\s+memory",
  "remember\\s+that",
  "never\\s+forget",
  "always\\s+remember",
];

const DEFAULTS: Required<Omit<SupermemoryConfig, "apiKey" | "baseUrl" | "userContainerTag" | "projectContainerTag">> = {
  similarityThreshold: 0.6,
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  filterPrompt: "You are a stateful coding agent. Remember all the information, including but not limited to user's coding preferences, tech stack, behaviours, workflows, and any other relevant details.",
  keywordPatterns: [],
  compactionThreshold: 0.80,
  autoRecallEveryPrompt: false,
  captureEveryNTurns: 0,
};

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function validateCompactionThreshold(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || isNaN(value)) {
    return DEFAULTS.compactionThreshold;
  }
  if (value <= 0 || value > 1) return DEFAULTS.compactionThreshold;
  return value;
}

interface RawConfigResult {
  config: SupermemoryConfig;
  existed: boolean;
  content?: string;
  parseError?: string;
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function findJsoncObjectStart(content: string): number {
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i] ?? "";
    const next = content[i + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (isJsonWhitespace(char)) continue;
    if (char === "{") return i;
    throw new Error("Cannot update Supermemory JSONC config: expected a top-level object");
  }

  throw new Error("Cannot update Supermemory JSONC config: expected a top-level object");
}

function inferJsoncPropertyIndent(content: string, start: number): string {
  let lineStart = start;

  while (lineStart < content.length) {
    let contentStart = lineStart;
    while (content[contentStart] === " " || content[contentStart] === "\t") contentStart++;

    if (content.startsWith("\r\n", contentStart)) {
      lineStart = contentStart + 2;
      continue;
    }
    if (content[contentStart] === "\r" || content[contentStart] === "\n") {
      lineStart = contentStart + 1;
      continue;
    }

    const indent = content.slice(lineStart, contentStart);
    return content[contentStart] === "}" ? `${indent}  ` : indent;
  }

  return "  ";
}

function insertJsoncProperties(
  content: string,
  entries: Array<readonly [key: string, value: boolean | number]>,
  hasExistingProperties: boolean,
): string {
  if (entries.length === 0) return content;

  const objectStart = findJsoncObjectStart(content);
  const renderedEntries = entries.map(([key, value], index) => {
    const needsComma = hasExistingProperties || index < entries.length - 1;
    return `${JSON.stringify(key)}: ${JSON.stringify(value)}${needsComma ? "," : ""}`;
  });

  let lineBreakStart = objectStart + 1;
  while (content[lineBreakStart] === " " || content[lineBreakStart] === "\t") {
    lineBreakStart++;
  }

  const lineBreakLength = content.startsWith("\r\n", lineBreakStart)
    ? 2
    : content[lineBreakStart] === "\r" || content[lineBreakStart] === "\n"
      ? 1
      : 0;

  if (lineBreakLength === 0) {
    const insertion = ` ${renderedEntries.join(" ")} `;
    return `${content.slice(0, objectStart + 1)}${insertion}${content.slice(objectStart + 1)}`;
  }

  const insertionIndex = lineBreakStart + lineBreakLength;
  const newline = content.slice(lineBreakStart, insertionIndex);
  const propertyIndent = inferJsoncPropertyIndent(content, insertionIndex);
  const insertion = `${renderedEntries.map((entry) => `${propertyIndent}${entry}`).join(newline)}${newline}`;

  return `${content.slice(0, insertionIndex)}${insertion}${content.slice(insertionIndex)}`;
}

function isConfigObject(value: unknown): value is SupermemoryConfig & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadRawConfig(): RawConfigResult {
  if (!existsSync(CONFIG_FILE)) return { config: {}, existed: false };

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const json = stripJsoncComments(content);
    const parsed: unknown = JSON.parse(json);
    if (!isConfigObject(parsed)) {
      throw new Error("expected a top-level object");
    }
    return { config: parsed as SupermemoryConfig, existed: true, content };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return { config: {}, existed: true, parseError };
  }
}

const { config: fileConfig, existed: configExisted } = loadRawConfig();

function getApiKey(): string | undefined {
  if (process.env.SUPERMEMORY_API_KEY) return process.env.SUPERMEMORY_API_KEY;
  if (fileConfig.apiKey) return fileConfig.apiKey;
  return loadCredentials()?.apiKey;
}

export const SUPERMEMORY_API_KEY = getApiKey();

function normalizeBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;

  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getApiBaseUrl(): string {
  const configured =
    process.env.SUPERMEMORY_API_URL ||
    process.env.SUPERMEMORY_BASE_URL ||
    fileConfig.baseUrl ||
    loadCredentials()?.apiBaseUrl ||
    DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) {
    throw new Error("Invalid baseUrl: expected an absolute http(s) URL");
  }
  return normalized;
}

export const CONFIG = {
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProjectMemories: fileConfig.maxProjectMemories ?? DEFAULTS.maxProjectMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
  userContainerTag: fileConfig.userContainerTag,
  projectContainerTag: fileConfig.projectContainerTag,
  filterPrompt: fileConfig.filterPrompt ?? DEFAULTS.filterPrompt,
  keywordPatterns: [
    ...DEFAULT_KEYWORD_PATTERNS,
    ...(fileConfig.keywordPatterns ?? []).filter(isValidRegex),
  ],
  compactionThreshold: validateCompactionThreshold(fileConfig.compactionThreshold),
  autoRecallEveryPrompt:
    fileConfig.autoRecallEveryPrompt ??
    (configExisted ? true : DEFAULTS.autoRecallEveryPrompt),
  captureEveryNTurns:
    fileConfig.captureEveryNTurns ??
    (configExisted ? 3 : DEFAULTS.captureEveryNTurns),
};

export function isConfigured(): boolean {
  return !!SUPERMEMORY_API_KEY;
}

export function writeInstallDefaults(isExistingInstall: boolean): void {
  const loaded = loadRawConfig();
  if (loaded.parseError) {
    throw new Error(`Cannot update invalid Supermemory config at ${CONFIG_FILE}: ${loaded.parseError}`);
  }

  const current = loaded.config;
  const installDefaults = isExistingInstall
    ? { autoRecallEveryPrompt: true, captureEveryNTurns: 3 }
    : { autoRecallEveryPrompt: false, captureEveryNTurns: 0 };

  if (CONFIG_FILE.endsWith(".jsonc") && loaded.content !== undefined) {
    const missingEntries: Array<readonly [key: string, value: boolean | number]> = [];
    if (current.autoRecallEveryPrompt === undefined) {
      missingEntries.push(["autoRecallEveryPrompt", installDefaults.autoRecallEveryPrompt]);
    }
    if (current.captureEveryNTurns === undefined) {
      missingEntries.push(["captureEveryNTurns", installDefaults.captureEveryNTurns]);
    }
    if (missingEntries.length === 0) return;

    const updated = insertJsoncProperties(
      loaded.content,
      missingEntries,
      Object.keys(current).length > 0,
    );
    const reparsed: unknown = JSON.parse(stripJsoncComments(updated));
    if (
      !isConfigObject(reparsed) ||
      Object.keys(reparsed).length !== Object.keys(current).length + missingEntries.length ||
      missingEntries.some(([key, value]) => reparsed[key] !== value) ||
      Object.entries(current).some(([key, value]) => !isDeepStrictEqual(reparsed[key], value))
    ) {
      throw new Error(`Cannot safely update Supermemory JSONC config at ${CONFIG_FILE}`);
    }

    writeFileSync(CONFIG_FILE, updated);
    return;
  }

  const next: SupermemoryConfig = { ...current };
  if (isExistingInstall) {
    if (next.autoRecallEveryPrompt === undefined) next.autoRecallEveryPrompt = true;
    if (next.captureEveryNTurns === undefined) next.captureEveryNTurns = 3;
  } else {
    next.autoRecallEveryPrompt = false;
    next.captureEveryNTurns = 0;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}
