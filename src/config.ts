import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";
import { loadCredentials } from "./services/auth.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
export { PLUGIN_VERSION } from "./version.js";
const CONFIG_FILES = [
  join(CONFIG_DIR, "supermemory.jsonc"),
  join(CONFIG_DIR, "supermemory.json"),
];

export const DEFAULT_BASE_URL = "https://api.supermemory.ai";
const DEFAULT_COMPACTION_THRESHOLD = 0.8;

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
  compactionEnabled?: boolean;
  /** @deprecated OpenCode now owns the compaction trigger. Use compactionEnabled. */
  compactionThreshold?: number | false;
  autoRecallEveryPrompt?: boolean;
  captureEveryNTurns?: number;
  recallDirective?: string | null;
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

const DEFAULTS: Required<Omit<SupermemoryConfig, "apiKey" | "baseUrl" | "userContainerTag" | "projectContainerTag" | "recallDirective">> = {
  similarityThreshold: 0.55,
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  filterPrompt: "You are a stateful coding agent. Remember all the information, including but not limited to user's coding preferences, tech stack, behaviours, workflows, and any other relevant details.",
  keywordPatterns: [],
  compactionEnabled: true,
  compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
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

export function validateCompactionThreshold(
  value: number | false | undefined,
): number {
  if (value === false || value === 0) return 0;
  if (value === undefined || typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_COMPACTION_THRESHOLD;
  }
  if (value < 0 || value > 1) return DEFAULT_COMPACTION_THRESHOLD;
  return value;
}

export function resolveCompactionEnabled(
  enabled: boolean | undefined,
  legacyThreshold: number | false | undefined,
): boolean {
  if (enabled !== undefined) return enabled;
  return validateCompactionThreshold(legacyThreshold) !== 0;
}

function validateCaptureEveryNTurns(
  value: number | undefined,
  fallback: number,
): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return fallback;
  }
  return value;
}

function loadRawConfig(): { config: SupermemoryConfig; existed: boolean } {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return { config: JSON.parse(json) as SupermemoryConfig, existed: true };
      } catch {
        return { config: {}, existed: true };
      }
    }
  }
  return { config: {}, existed: false };
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

export const CONFIG_FILE = CONFIG_FILES[1];
const DEFAULT_CONFIG_FILE = CONFIG_FILE ?? join(CONFIG_DIR, "supermemory.json");

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
  compactionEnabled: resolveCompactionEnabled(
    fileConfig.compactionEnabled,
    fileConfig.compactionThreshold,
  ),
  compactionThreshold: validateCompactionThreshold(fileConfig.compactionThreshold),
  autoRecallEveryPrompt:
    fileConfig.autoRecallEveryPrompt ??
    (configExisted ? true : DEFAULTS.autoRecallEveryPrompt),
  captureEveryNTurns: validateCaptureEveryNTurns(
    fileConfig.captureEveryNTurns,
    configExisted ? 3 : DEFAULTS.captureEveryNTurns,
  ),
  recallDirective: fileConfig.recallDirective ?? null,
};

export function isConfigured(): boolean {
  return !!SUPERMEMORY_API_KEY;
}

export function getRecallConfig(): { directive: string | null } {
  return { directive: CONFIG.recallDirective ?? null };
}

export function writeInstallDefaults(isExistingInstall: boolean): void {
  const current = loadRawConfig().config;
  const next: SupermemoryConfig = { ...current };
  if (isExistingInstall) {
    if (next.autoRecallEveryPrompt === undefined) next.autoRecallEveryPrompt = true;
    if (next.captureEveryNTurns === undefined) next.captureEveryNTurns = 3;
  } else {
    next.autoRecallEveryPrompt = false;
    next.captureEveryNTurns = 0;
  }
  writeFileSync(DEFAULT_CONFIG_FILE, JSON.stringify(next, null, 2));
}
