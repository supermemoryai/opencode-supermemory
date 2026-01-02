import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseJsonc } from "./services/jsonc.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "supermemory.jsonc"),
  join(CONFIG_DIR, "supermemory.json"),
];

interface SupermemoryConfig {
  apiKey?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProjectMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  filterPrompt?: string;
}

const DEFAULTS: Required<Omit<SupermemoryConfig, "apiKey">> = {
  similarityThreshold: 0.6,
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  filterPrompt: "You are a stateful coding agent. Remember all the information, including but not limited to user's coding preferences, tech stack, behaviours, workflows, and any other relevant details.",
};

function loadConfig(): SupermemoryConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const cleaned = parseJsonc(content);
        return JSON.parse(cleaned) as SupermemoryConfig;
      } catch {
        // Invalid config, use defaults
      }
    }
  }
  return {};
}

const fileConfig = loadConfig();

export const SUPERMEMORY_API_KEY = fileConfig.apiKey ?? process.env.SUPERMEMORY_API_KEY;

export const CONFIG = {
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProjectMemories: fileConfig.maxProjectMemories ?? DEFAULTS.maxProjectMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
  filterPrompt: fileConfig.filterPrompt ?? DEFAULTS.filterPrompt,
};

export function isConfigured(): boolean {
  return !!SUPERMEMORY_API_KEY;
}
