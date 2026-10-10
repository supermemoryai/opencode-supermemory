import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname, homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG } from "../config.js";

const GIT_TIMEOUT_MS = 2000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const repoInfoCache = new Map<
  string,
  { name: string | null; normalizedRemote: string | null }
>();

interface GitMetadata {
  basePath: string;
  repoName: string | null;
  normalizedRemote: string | null;
  email: string | null;
  isolateWorktrees: boolean;
}

function isGitCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const gitError = error as Error & {
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    code?: string | null;
  };
  return (
    gitError.killed === true ||
    gitError.signal != null ||
    gitError.name === "AbortError" ||
    gitError.code === "ETIMEDOUT"
  );
}

function isIsolateWorktrees(): boolean {
  return process.env.SUPERMEMORY_ISOLATE_WORKTREES === "true";
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(String(stdout).trim());
      },
    );
  });
}

async function resolveGitRoot(
  directory: string,
  isolateWorktrees: boolean,
): Promise<string | null> {
  try {
    if (isolateWorktrees) {
      const gitRoot = await runGit(["rev-parse", "--show-toplevel"], directory);
      return gitRoot || null;
    }

    const gitCommonDir = await runGit(
      ["rev-parse", "--git-common-dir"],
      directory,
    );

    if (gitCommonDir === ".git") {
      const gitRoot = await runGit(["rev-parse", "--show-toplevel"], directory);
      return gitRoot || null;
    }

    const resolved = resolve(directory, gitCommonDir);
    if (basename(resolved) === ".git" && !resolved.includes(`${sep}.git${sep}`)) {
      return dirname(resolved);
    }

    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], directory);
    return gitRoot || null;
  } catch (error) {
    if (isGitCancellation(error)) throw error;
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

async function resolveRepoInfo(directory: string): Promise<{
  name: string | null;
  normalizedRemote: string | null;
}> {
  const cached = repoInfoCache.get(directory);
  if (cached) return cached;

  try {
    const remoteUrl = await runGit(
      ["remote", "get-url", "origin"],
      directory,
    );
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
  } catch (error) {
    if (isGitCancellation(error)) throw error;
    const result = { name: null, normalizedRemote: null };
    repoInfoCache.set(directory, result);
    return result;
  }
}

async function resolveGitEmail(directory: string): Promise<string | null> {
  try {
    const email = await runGit(["config", "user.email"], directory);
    return email || null;
  } catch (error) {
    if (isGitCancellation(error)) throw error;
    return null;
  }
}

async function resolveGitMetadata(directory: string): Promise<GitMetadata> {
  const isolateWorktrees = isIsolateWorktrees();
  const basePath =
    (await resolveGitRoot(directory, isolateWorktrees)) || resolve(directory);
  const repoInfo = await resolveRepoInfo(basePath);
  const email = await resolveGitEmail(basePath);
  return {
    basePath,
    repoName: repoInfo.name,
    normalizedRemote: repoInfo.normalizedRemote,
    email,
    isolateWorktrees,
  };
}

function loadClaudeProjectConfig(basePath: string): {
  personalContainerTag?: string;
  repoContainerTag?: string;
} | null {
  try {
    const configPath = join(
      basePath,
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

function loadLegacyCursorConfig(directory: string): {
  repoContainerTag?: string;
  userContainerTag?: string;
  projectContainerTag?: string;
} {
  let globalConfig: {
    repoContainerTag?: string;
    userContainerTag?: string;
    projectContainerTag?: string;
  } | null = null;
  try {
    const configPath = join(
      homedir(),
      ".config",
      "cursor",
      "supermemory.json",
    );
    if (existsSync(configPath)) {
      globalConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
        repoContainerTag?: string;
        userContainerTag?: string;
        projectContainerTag?: string;
      };
    }
  } catch {}

  let projectConfig: {
    repoContainerTag?: string;
    userContainerTag?: string;
    projectContainerTag?: string;
  } | null = null;
  let current = resolve(directory);
  while (true) {
    try {
      const configPath = join(
        current,
        ".cursor",
        ".supermemory",
        "config.json",
      );
      if (existsSync(configPath)) {
        projectConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
          repoContainerTag?: string;
          userContainerTag?: string;
          projectContainerTag?: string;
        };
        break;
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { ...(globalConfig ?? {}), ...(projectConfig ?? {}) };
}

export function sanitizeRepoName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return sanitized.slice(0, 95).replace(/_+$/g, "") || "unknown";
}

function repoName(meta: GitMetadata): string {
  return meta.repoName || basename(meta.basePath) || "unknown";
}

function projectIdentity(meta: GitMetadata): string {
  let localIdentity = meta.basePath;
  try {
    localIdentity = realpathSync.native(meta.basePath);
  } catch {}
  return sha256(
    !meta.isolateWorktrees && meta.normalizedRemote
      ? meta.normalizedRemote
      : `path:${localIdentity}`,
  );
}

function generatedProjectTag(meta: GitMetadata): string {
  const shortName = sanitizeRepoName(repoName(meta))
    .slice(0, 72)
    .replace(/_+$/g, "");
  return `repo_${shortName || "unknown"}__${projectIdentity(meta)}`;
}

function legacyGeneratedProjectTag(meta: GitMetadata): string {
  return `repo_${sanitizeRepoName(repoName(meta))}`;
}

function projectTag(directory: string, meta: GitMetadata): string {
  return (
    loadClaudeProjectConfig(meta.basePath)?.repoContainerTag ||
    process.env.SUPERMEMORY_REPO_TAG ||
    loadLegacyCursorConfig(directory).repoContainerTag ||
    CONFIG.projectContainerTag ||
    loadCodexConfig()?.projectContainerTag ||
    generatedProjectTag(meta)
  );
}

function legacyClaudePersonalTags(
  directory: string,
  meta: GitMetadata,
): string[] {
  const projectHash = sha256(meta.basePath);
  const claudeConfig = loadClaudeProjectConfig(meta.basePath);
  return uniqueTags([
    claudeConfig?.personalContainerTag,
    `user_project_${projectHash}`,
    `claudecode_project_${projectHash}`,
  ]);
}

function legacyCodexUserTags(meta: GitMetadata): string[] {
  const config = loadCodexConfig();
  const identity =
    meta.email || process.env.USER || process.env.USERNAME || hostname();
  const hash = sha256(identity);
  return uniqueTags([
    config?.userContainerTag,
    `${config?.containerTagPrefix || "codex"}_user_${hash}`,
    `codex_user_${hash}`,
  ]);
}

function legacyCodexProjectTags(meta: GitMetadata): string[] {
  const config = loadCodexConfig();
  const projectHash = sha256(meta.basePath);
  return uniqueTags([
    config?.projectContainerTag,
    `${config?.containerTagPrefix || "codex"}_project_${projectHash}`,
    `codex_project_${projectHash}`,
  ]);
}

function legacyOpenCodeUserTags(meta: GitMetadata): string[] {
  const identity =
    meta.email ||
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

function legacyOpenCodeProjectTags(
  directory: string,
  meta: GitMetadata,
): string[] {
  const directoryHashes = uniqueTags([
    sha256(directory),
    sha256(resolve(directory)),
    sha256(meta.basePath),
  ]);
  return uniqueTags([
    CONFIG.projectContainerTag,
    ...directoryHashes.flatMap((hash) => [
      `${CONFIG.containerTagPrefix}_project_${hash}`,
      `opencode_project_${hash}`,
    ]),
  ]);
}

function legacyCursorUserTags(
  directory: string,
  meta: GitMetadata,
): string[] {
  const config = loadLegacyCursorConfig(directory);
  const identity =
    config.userContainerTag ||
    process.env.SUPERMEMORY_USER_TAG ||
    process.env.CURSOR_USER_EMAIL ||
    meta.email ||
    `${hostname()}_${userInfo().username}`;
  return [`cursor_user_${sha256(identity)}`];
}

function legacyCursorProjectTags(
  directory: string,
  meta: GitMetadata,
): string[] {
  const config = loadLegacyCursorConfig(directory);
  const identity =
    config.projectContainerTag ||
    process.env.SUPERMEMORY_PROJECT_TAG ||
    meta.basePath;
  return [`cursor_project_${sha256(identity)}`];
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

function personalReadTags(
  directory: string,
  meta: GitMetadata,
  canonical: string,
  generated: string,
): string[] {
  return uniqueTags([
    canonical,
    generated,
    ...legacyClaudePersonalTags(directory, meta),
    ...legacyCodexUserTags(meta),
    ...legacyOpenCodeUserTags(meta),
    ...legacyCursorUserTags(directory, meta),
  ]);
}

function projectReadTags(
  directory: string,
  meta: GitMetadata,
  canonical: string,
  generated: string,
): string[] {
  return uniqueTags([
    canonical,
    generated,
    legacyGeneratedProjectTag(meta),
    ...legacyCodexProjectTags(meta),
    ...legacyOpenCodeProjectTags(directory, meta),
    ...legacyCursorProjectTags(directory, meta),
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

export async function getTags(directory: string): Promise<ResolvedTags> {
  const meta = await resolveGitMetadata(directory);
  const canonical = projectTag(directory, meta);
  const generated = generatedProjectTag(meta);
  const personalReads = personalReadTags(directory, meta, canonical, generated);
  const projectReads = projectReadTags(directory, meta, canonical, generated);
  return {
    canonical,
    user: canonical,
    project: canonical,
    projectId: projectIdentity(meta),
    projectName: repoName(meta),
    personalReads,
    projectReads,
    allReads: uniqueTags([...personalReads, ...projectReads]),
  };
}
