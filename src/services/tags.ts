import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG } from "../config.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", { encoding: "utf-8" }).trim();
    return email || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote URL to a canonical form so that SSH, HTTPS,
 * and with/without `.git` suffix all produce the same identifier.
 *
 * Examples:
 *   git@github.com:user/repo.git   → github.com/user/repo
 *   https://github.com/user/repo   → github.com/user/repo
 *   git@gitlab.com:org/sub/repo.git → gitlab.com/org/sub/repo
 */
export function normalizeGitUrl(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//, "")   // strip protocol (https://, git://, ssh://)
    .replace(/^[^@]+@/, "")          // strip user@ prefix (git@, user@)
    .replace(/:(\d+)\//, "/$1/")     // preserve port numbers (e.g. :8080/)
    .replace(":", "/")               // SSH colon to slash (github.com:user → github.com/user)
    .replace(/\.git$/, "")           // strip trailing .git
    .replace(/\/+$/, "");            // strip trailing slashes
}

/**
 * Get the git remote URL for the given directory.
 * This provides a stable, cross-machine identifier for projects.
 * Returns null if not in a git repo or no remote configured.
 */
export function getGitRemoteUrl(directory: string): string | null {
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return remoteUrl || null;
  } catch {
    return null;
  }
}

export function getUserTag(): string {
  // If userContainerTag is explicitly set, use it
  if (CONFIG.userContainerTag) {
    return CONFIG.userContainerTag;
  }

  // Otherwise, auto-generate based on containerTagPrefix
  const email = getGitEmail();
  if (email) {
    return `${CONFIG.containerTagPrefix}_user_${sha256(email)}`;
  }
  const fallback = process.env.USER || process.env.USERNAME || "anonymous";
  return `${CONFIG.containerTagPrefix}_user_${sha256(fallback)}`;
}

export function getProjectTag(directory: string): string {
  // If projectContainerTag is explicitly set, use it
  if (CONFIG.projectContainerTag) {
    return CONFIG.projectContainerTag;
  }

  // Try to use git remote URL as a stable cross-machine project identifier
  // This allows the same project on different machines to share memories
  const remoteUrl = getGitRemoteUrl(directory);
  if (remoteUrl) {
    return `${CONFIG.containerTagPrefix}_project_${sha256(normalizeGitUrl(remoteUrl))}`;
  }

  // Fall back to directory path hash (machine-specific)
  return `${CONFIG.containerTagPrefix}_project_${sha256(directory)}`;
}

export function getTags(directory: string): { user: string; project: string } {
  return {
    user: getUserTag(),
    project: getProjectTag(directory),
  };
}
