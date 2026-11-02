import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";
import {
  authRequired,
  getAccessToken,
  getOAuthConfig as buildOAuthConfig,
  hasOAuthCredentials,
  loadCredentialData,
  loadCredentials,
  type OAuthConfig,
} from "./services/auth.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
export { PLUGIN_VERSION } from "./version.js";
const CONFIG_FILES = [
  join(CONFIG_DIR, "supermemory.jsonc"),
  join(CONFIG_DIR, "supermemory.json"),
];

export const DEFAULT_BASE_URL = "https://api.supermemory.ai";
export const MAX_SUPPORTING_CONTEXT_CHARS = 1500;

export type RecallMode = "direct" | "advisory" | "off";

interface SupermemoryConfig {
  apiKey?: string;
  baseUrl?: string;
  apiVersion?: "legacy" | "v5";
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
  /** OpenCode 2 only: enrich native compaction with project memories and save summaries. */
  compactionEnabled?: boolean;
  autoRecallEveryPrompt?: boolean;
  captureEveryNTurns?: number;
  recallDirective?: string | null;
  recallMode?: RecallMode;
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

const DEFAULTS: Required<Omit<SupermemoryConfig, "apiKey" | "baseUrl" | "apiVersion" | "userContainerTag" | "projectContainerTag" | "filterPrompt" | "recallDirective">> = {
  similarityThreshold: 0.55,
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  keywordPatterns: [],
  compactionThreshold: 0.80,
  compactionEnabled: true,
  autoRecallEveryPrompt: false,
  captureEveryNTurns: 0,
  recallMode: "direct",
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

function resolveFilterPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const prompt = value.trim();
  return prompt && prompt.length <= MAX_SUPPORTING_CONTEXT_CHARS ? prompt : undefined;
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

function resolveRecallMode(): RecallMode {
  if (
    fileConfig.recallMode === "direct" ||
    fileConfig.recallMode === "advisory" ||
    fileConfig.recallMode === "off"
  ) {
    return fileConfig.recallMode;
  }
  if (fileConfig.recallDirective?.trim()) return "advisory";
  if (fileConfig.autoRecallEveryPrompt === true) return "direct";
  if (fileConfig.autoRecallEveryPrompt === false) return "advisory";
  return DEFAULTS.recallMode;
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

// API keys take precedence over OAuth. Never returns an OAuth token.
export function getApiKey(): string | undefined {
  if (process.env.SUPERMEMORY_API_KEY) return process.env.SUPERMEMORY_API_KEY;
  if (fileConfig.apiKey) return fileConfig.apiKey;
  return loadCredentials();
}

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
    loadCredentialData()?.apiBaseUrl ||
    DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) {
    throw new Error("Invalid baseUrl: expected an absolute http(s) URL");
  }
  return normalized;
}

function savedOAuthFor(apiBaseUrl: string) {
  const saved = loadCredentialData();
  return saved?.type === "oauth" && saved.apiBaseUrl === apiBaseUrl ? saved : undefined;
}

// The OAuth resource (MCP URL). Prefer the one saved at login so the OpenCode
// process does not need the CLI's environment.
export function getMcpUrl(apiBaseUrl = getApiBaseUrl()): string {
  if (process.env.SUPERMEMORY_MCP_URL) {
    const configured = normalizeBaseUrl(process.env.SUPERMEMORY_MCP_URL);
    if (!configured) throw new Error("Invalid SUPERMEMORY_MCP_URL");
    return configured;
  }
  const saved = savedOAuthFor(apiBaseUrl);
  if (saved?.resource) return saved.resource;
  const api = new URL(apiBaseUrl);
  if (api.hostname.startsWith("api.")) {
    api.hostname = api.hostname.replace(/^api\./, "mcp.");
    api.pathname = "/mcp";
    api.search = "";
    api.hash = "";
    return api.toString();
  }
  throw new Error("Set SUPERMEMORY_MCP_URL for OAuth on a custom Supermemory backend.");
}

/** OAuth issuer/resource for an API URL (HTTPS required except loopback). */
export function getOAuthConfig(apiBaseUrl = getApiBaseUrl()): OAuthConfig {
  const issuer =
    process.env.SUPERMEMORY_OAUTH_ISSUER ||
    savedOAuthFor(apiBaseUrl)?.issuer ||
    `${apiBaseUrl}/api/auth`;
  return buildOAuthConfig(apiBaseUrl, issuer, getMcpUrl(apiBaseUrl));
}

export async function getAuthToken(timeoutMs?: number, apiBaseUrl?: string): Promise<string> {
  const apiKey = getApiKey();
  if (apiKey) return apiKey;
  if (loadCredentialData()?.type !== "oauth") throw authRequired();
  return getAccessToken(getOAuthConfig(apiBaseUrl ?? getApiBaseUrl()), timeoutMs);
}

// The legacy SDK only accepts a static API key. Resolve the bearer at send time
// so cached SDK clients and retries observe login, rotated tokens and logout.
export function createAuthenticatedFetch(apiBaseUrl: string): typeof fetch {
  const base = new URL(apiBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const authenticatedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (target.origin !== base.origin || !target.pathname.startsWith(`${basePath}/`)) {
      throw authRequired();
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const token = await getAuthToken(undefined, apiBaseUrl);
    signal?.throwIfAborted();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return authenticatedFetch as typeof fetch;
}

export function getApiVersion(): "legacy" | "v5" {
  const version = process.env.SUPERMEMORY_API_VERSION ?? fileConfig.apiVersion;
  if (version !== undefined) {
    if (version === "legacy" || version === "v5") return version;
    throw new Error('Invalid apiVersion: expected "legacy" or "v5"');
  }
  return getApiBaseUrl() === DEFAULT_BASE_URL ? "v5" : "legacy";
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
  filterPrompt: resolveFilterPrompt(fileConfig.filterPrompt),
  keywordPatterns: [
    ...DEFAULT_KEYWORD_PATTERNS,
    ...(fileConfig.keywordPatterns ?? []).filter(isValidRegex),
  ],
  compactionThreshold: validateCompactionThreshold(fileConfig.compactionThreshold),
  compactionEnabled:
    typeof fileConfig.compactionEnabled === "boolean"
      ? fileConfig.compactionEnabled
      : DEFAULTS.compactionEnabled,
  autoRecallEveryPrompt:
    fileConfig.autoRecallEveryPrompt ??
    (configExisted ? true : DEFAULTS.autoRecallEveryPrompt),
  recallMode: resolveRecallMode(),
  captureEveryNTurns: validateCaptureEveryNTurns(
    fileConfig.captureEveryNTurns,
    configExisted ? 3 : DEFAULTS.captureEveryNTurns,
  ),
  recallDirective: fileConfig.recallDirective ?? null,
};

/** Resolved on every call so login and logout apply without restarting OpenCode. */
export function isConfigured(): boolean {
  if (getApiKey()) return true;
  try {
    return hasOAuthCredentials(getOAuthConfig());
  } catch {
    return false;
  }
}

export function getRecallConfig(): {
  directive: string | null;
  mode: RecallMode;
} {
  return {
    directive: CONFIG.recallDirective ?? null,
    mode: CONFIG.recallMode,
  };
}

export function writeInstallDefaults(isExistingInstall: boolean): void {
  const current = loadRawConfig().config;
  const next: SupermemoryConfig = { ...current };
  if (isExistingInstall) {
    if (next.captureEveryNTurns === undefined) next.captureEveryNTurns = 3;
  } else {
    next.recallMode = "direct";
    next.captureEveryNTurns = 0;
  }
  writeFileSync(DEFAULT_CONFIG_FILE, JSON.stringify(next, null, 2));
}
