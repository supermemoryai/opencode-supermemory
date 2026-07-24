import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG } from "../config.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const repoInfoCache = new Map<
  string,
  { name: string | null; normalizedRemote: string | null }
>();

function getGitRoot(directory: string): string | null {
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === "true";

  try {
    if (isolateWorktrees) {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return gitRoot || null;
    }

    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (gitCommonDir === ".git") {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return gitRoot || null;
    }

    const resolved = resolve(directory, gitCommonDir);
    if (basename(resolved) === ".git" && !resolved.includes(`${sep}.git${sep}`)) {
      return dirname(resolved);
    }

    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return gitRoot || null;
  } catch {
    return null;
  }
}

function getProjectBasePath(directory: string): string {
  return getGitRoot(directory) || resolve(directory);
}

function getGitEmail(directory: string): string | null {
  try {
    const email = execSync("git config user.email", {
      cwd: getProjectBasePath(directory),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return email || null;
  } catch {
    return null;
  }
}

export function normalizeGitRemote(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  let normalized: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      normalized =
        parsed.protocol === "file:"
          ? `file:${decodeURIComponent(parsed.pathname)}`
          : `${parsed.hostname.toLowerCase()}${
              parsed.port ? `:${parsed.port}` : ""
            }/${parsed.pathname.replace(/^\/+/, "")}`;
    } catch {
      normalized = raw;
    }
  } else {
    const scpStyle = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    normalized =
      scpStyle?.[1] && scpStyle[2]
        ? `${scpStyle[1].toLowerCase()}/${scpStyle[2]}`
        : `file:${resolve(raw)}`;
  }

  return normalized
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

function getGitRepoInfo(directory: string): {
  name: string | null;
  normalizedRemote: string | null;
} {
  const cached = repoInfoCache.get(directory);
  if (cached) return cached;

  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const normalizedRemote = normalizeGitRemote(remoteUrl);
    const displayRemote = remoteUrl.replace(/\/+$/, "").replace(/\.git$/i, "");
    const separator = Math.max(
      displayRemote.lastIndexOf("/"),
      displayRemote.lastIndexOf(":"),
    );
    const result = {
      name: displayRemote.slice(separator + 1) || null,
      normalizedRemote,
    };
    repoInfoCache.set(directory, result);
    return result;
  } catch {
    const result = { name: null, normalizedRemote: null };
    repoInfoCache.set(directory, result);
    return result;
  }
}

function getGitRepoName(directory: string): string | null {
  return getGitRepoInfo(directory).name;
}

function loadClaudeProjectConfig(directory: string): {
  personalContainerTag?: string;
  repoContainerTag?: string;
} | null {
  try {
    const configPath = join(
      getProjectBasePath(directory),
      ".claude",
      ".supermemory-claude",
      "config.json",
    );
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8")) as {
      personalContainerTag?: string;
      repoContainerTag?: string;
    };
  } catch {
    return null;
  }
}

function loadCodexConfig(): {
  containerTagPrefix?: string;
  userContainerTag?: string;
  projectContainerTag?: string;
} | null {
  try {
    const configPath = join(homedir(), ".codex", "supermemory.json");
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8")) as {
      containerTagPrefix?: string;
      userContainerTag?: string;
      projectContainerTag?: string;
    };
  } catch {
    return null;
  }
}

export function sanitizeRepoName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return sanitized.slice(0, 95).replace(/_+$/g, "") || "unknown";
}

export function getProjectIdentity(directory: string): string {
  const basePath = getProjectBasePath(directory);
  const { normalizedRemote } = getGitRepoInfo(basePath);
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === "true";
  let localIdentity = basePath;
  try {
    localIdentity = realpathSync.native(basePath);
  } catch {}
  return sha256(
    !isolateWorktrees && normalizedRemote
      ? normalizedRemote
      : `path:${localIdentity}`,
  );
}

export function getGeneratedProjectTag(directory: string): string {
  const basePath = getProjectBasePath(directory);
  const repoName = getGitRepoName(basePath) || basename(basePath) || "unknown";
  const shortName = sanitizeRepoName(repoName).slice(0, 72).replace(/_+$/g, "");
  return `repo_${shortName || "unknown"}__${getProjectIdentity(directory)}`;
}

export function getLegacyGeneratedProjectTag(directory: string): string {
  const basePath = getProjectBasePath(directory);
  const repoName = getGitRepoName(basePath) || basename(basePath) || "unknown";
  return `repo_${sanitizeRepoName(repoName)}`;
}

export function getProjectTag(directory: string): string {
  return (
    loadClaudeProjectConfig(directory)?.repoContainerTag ||
    CONFIG.projectContainerTag ||
    loadCodexConfig()?.projectContainerTag ||
    getGeneratedProjectTag(directory)
  );
}

export function getUserTag(directory = process.cwd()): string {
  return getProjectTag(directory);
}

export function getProjectName(directory: string): string {
  const basePath = getProjectBasePath(directory);
  return getGitRepoName(basePath) || basename(basePath) || "unknown";
}

function getLegacyClaudePersonalTags(directory: string): string[] {
  const projectHash = sha256(getProjectBasePath(directory));
  const claudeConfig = loadClaudeProjectConfig(directory);
  return uniqueTags([
    claudeConfig?.personalContainerTag,
    `user_project_${projectHash}`,
    `claudecode_project_${projectHash}`,
  ]);
}

function getLegacyCodexUserTags(directory: string): string[] {
  const config = loadCodexConfig();
  const identity =
    getGitEmail(directory) ||
    process.env.USER ||
    process.env.USERNAME ||
    hostname();
  const hash = sha256(identity);
  return uniqueTags([
    config?.userContainerTag,
    `${config?.containerTagPrefix || "codex"}_user_${hash}`,
    `codex_user_${hash}`,
  ]);
}

function getLegacyCodexProjectTags(directory: string): string[] {
  const config = loadCodexConfig();
  const projectHash = sha256(getProjectBasePath(directory));
  return uniqueTags([
    config?.projectContainerTag,
    `${config?.containerTagPrefix || "codex"}_project_${projectHash}`,
    `codex_project_${projectHash}`,
  ]);
}

export function getLegacyOpenCodeUserTags(directory: string): string[] {
  const identity =
    getGitEmail(directory) ||
    process.env.USER ||
    process.env.USERNAME ||
    "anonymous";
  const hash = sha256(identity);
  return uniqueTags([
    CONFIG.userContainerTag,
    `${CONFIG.containerTagPrefix}_user_${hash}`,
    `opencode_user_${hash}`,
  ]);
}

export function getLegacyOpenCodeProjectTags(directory: string): string[] {
  const directoryHashes = uniqueTags([
    sha256(directory),
    sha256(resolve(directory)),
    sha256(getProjectBasePath(directory)),
  ]);
  return uniqueTags([
    CONFIG.projectContainerTag,
    ...directoryHashes.flatMap((hash) => [
      `${CONFIG.containerTagPrefix}_project_${hash}`,
      `opencode_project_${hash}`,
    ]),
  ]);
}

function uniqueTags(tags: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      tags.filter(
        (tag): tag is string =>
          typeof tag === "string" && tag.trim().length > 0,
      ),
    ),
  ];
}

export function getPersonalReadTags(directory: string): string[] {
  return uniqueTags([
    getProjectTag(directory),
    getGeneratedProjectTag(directory),
    ...getLegacyClaudePersonalTags(directory),
    ...getLegacyCodexUserTags(directory),
    ...getLegacyOpenCodeUserTags(directory),
  ]);
}

export function getProjectReadTags(directory: string): string[] {
  return uniqueTags([
    getProjectTag(directory),
    getGeneratedProjectTag(directory),
    getLegacyGeneratedProjectTag(directory),
    ...getLegacyCodexProjectTags(directory),
    ...getLegacyOpenCodeProjectTags(directory),
  ]);
}

export function getAllReadTags(directory: string): string[] {
  return uniqueTags([
    ...getPersonalReadTags(directory),
    ...getProjectReadTags(directory),
  ]);
}

export interface ResolvedTags {
  canonical: string;
  user: string;
  project: string;
  projectId: string;
  projectName: string;
  personalReads: string[];
  projectReads: string[];
  allReads: string[];
}

export function getTags(directory: string): ResolvedTags {
  const canonical = getProjectTag(directory);
  return {
    canonical,
    user: canonical,
    project: canonical,
    projectId: getProjectIdentity(directory),
    projectName: getProjectName(directory),
    personalReads: getPersonalReadTags(directory),
    projectReads: getProjectReadTags(directory),
    allReads: getAllReadTags(directory),
  };
}
