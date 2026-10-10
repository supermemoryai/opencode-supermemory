import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { CONFIG } from "../config.js";
import { getTags, normalizeGitRemote, sanitizeRepoName } from "./tags.js";

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function unique(tags: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      tags.filter(
        (tag): tag is string =>
          typeof tag === "string" && tag.trim().length > 0,
      ),
    ),
  ];
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function gitToplevel(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  }).trim();
}

interface TempRoot {
  root: string;
  cleanup: () => void;
}

function tempRoot(): TempRoot {
  const root = mkdtempSync(join(tmpdir(), "sm-tags-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRepo(root: string, name: string, remote: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev Example"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

interface FakeGit {
  restore: () => void;
  logPath: string;
  markerPath: string;
}

function installFakeGit(root: string, script: string): FakeGit {
  const bin = join(root, "fake-git-bin");
  mkdirSync(bin, { recursive: true });
  const logPath = join(root, "git-calls.log");
  const markerPath = join(root, "git-started.marker");
  const wrapper = script
    .replaceAll("__GIT__", REAL_GIT)
    .replaceAll("__LOG__", logPath)
    .replaceAll("__MARKER__", markerPath);
  const executable = join(bin, "git");
  writeFileSync(executable, wrapper);
  chmodSync(executable, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return {
    restore: () => {
      process.env.PATH = originalPath;
    },
    logPath,
    markerPath,
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const CONFIG_KEYS = ["userContainerTag", "projectContainerTag", "containerTagPrefix"] as const;
const ENV_KEYS = [
  "USER",
  "USERNAME",
  "HOME",
  "SUPERMEMORY_REPO_TAG",
  "SUPERMEMORY_USER_TAG",
  "SUPERMEMORY_PROJECT_TAG",
  "CURSOR_USER_EMAIL",
  "SUPERMEMORY_ISOLATE_WORKTREES",
] as const;

let savedConfig: Record<string, unknown>;
let savedEnv: Record<string, string | undefined>;
let isolatedHome: string;

function neutralizeEnvironment(): void {
  savedConfig = {};
  for (const key of CONFIG_KEYS) savedConfig[key] = CONFIG[key];
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  isolatedHome = mkdtempSync(join(tmpdir(), "sm-tags-home-"));
  CONFIG.userContainerTag = undefined;
  CONFIG.projectContainerTag = undefined;
  CONFIG.containerTagPrefix = "opencode";
  process.env.USER = "testuser";
  process.env.USERNAME = "testuser";
  process.env.HOME = isolatedHome;
  for (const key of ENV_KEYS) {
    if (key !== "USER" && key !== "USERNAME" && key !== "HOME") delete process.env[key];
  }
}

function restoreEnvironment(): void {
  for (const key of CONFIG_KEYS) {
    (CONFIG as unknown as Record<string, unknown>)[key] = savedConfig[key];
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(isolatedHome, { recursive: true, force: true });
}

beforeEach(neutralizeEnvironment);
afterEach(restoreEnvironment);

describe("repository identity", () => {
  test("normalizes equivalent HTTPS and SSH remotes", () => {
    expect(
      normalizeGitRemote("https://github.com/SupermemoryAI/mono.git"),
    ).toBe("github.com/supermemoryai/mono");
    expect(normalizeGitRemote("git@github.com:SupermemoryAI/mono.git")).toBe(
      "github.com/supermemoryai/mono",
    );
  });

  test("sanitizes repository display names", () => {
    expect(sanitizeRepoName("Cursor Supermemory.js")).toBe(
      "cursor_supermemory_js",
    );
  });
});

describe("async tag resolution", () => {
  test("resolves exact canonical, identity and ordered read tags for a repo with a remote", async () => {
    const temp = tempRoot();
    try {
      const dir = makeRepo(temp.root, "plain-repo", "https://github.com/Example/Repo.git");
      const basePath = gitToplevel(dir);
      const projectId = hash("github.com/example/repo");
      const canonical = `repo_repo__${projectId}`;
      const baseHash = hash(basePath);
      const emailHash = hash("dev@example.com");
      const directoryHashes = unique([hash(dir), hash(dir), hash(basePath)]);

      const tags = await getTags(dir);

      const personalReads = unique([
        canonical,
        `user_project_${baseHash}`,
        `claudecode_project_${baseHash}`,
        `codex_user_${emailHash}`,
        `opencode_user_${emailHash}`,
        `cursor_user_${emailHash}`,
      ]);
      const projectReads = unique([
        canonical,
        "repo_repo",
        `codex_project_${baseHash}`,
        ...directoryHashes.flatMap((value) => [
          `opencode_project_${value}`,
          `opencode_project_${value}`,
        ]),
        `cursor_project_${baseHash}`,
      ]);

      expect(tags).toEqual({
        canonical,
        user: canonical,
        project: canonical,
        projectId,
        projectName: "Repo",
        personalReads,
        projectReads,
        allReads: unique([...personalReads, ...projectReads]),
      });
      expect(tags.allReads.slice(0, 1)).toEqual([canonical]);
    } finally {
      temp.cleanup();
    }
  });

  test("falls back to the path identity without a remote and preserves config precedence", async () => {
    const temp = tempRoot();
    try {
      const dir = makeRepo(temp.root, "no-remote", null);
      const basePath = gitToplevel(dir);
      const identity = hash(`path:${basePath}`);
      const canonical = `repo_no_remote__${identity}`;

      const tags = await getTags(dir);
      expect(tags.canonical).toBe(canonical);
      expect(tags.projectId).toBe(identity);
      expect(tags.projectName).toBe("no-remote");
      expect(tags.personalReads[0]).toBe(canonical);
      expect(tags.projectReads.slice(0, 2)).toEqual([canonical, "repo_no_remote"]);
      expect(tags.allReads).toEqual(
        unique([...tags.personalReads, ...tags.projectReads]),
      );

      process.env.SUPERMEMORY_REPO_TAG = "explicit_repo_tag";
      const overridden = await getTags(dir);
      expect(overridden.canonical).toBe("explicit_repo_tag");
      expect(overridden.user).toBe("explicit_repo_tag");
      expect(overridden.project).toBe("explicit_repo_tag");
      expect(overridden.projectId).toBe(identity);
      expect(overridden.personalReads).toContain(canonical);
    } finally {
      temp.cleanup();
    }
  });

  test("uses realpath identity for non-Git directories and symlinks", async () => {
    const temp = tempRoot();
    try {
      const nonGit = join(temp.root, "non-git");
      mkdirSync(nonGit, { recursive: true });
      const link = join(temp.root, "link-to-non-git");
      symlinkSync(nonGit, link);

      const identity = hash(`path:${realpathSync.native(nonGit)}`);
      const expectedName = "testuser";
      const userHash = hash(expectedName);
      const cursorHash = hash(`${hostname()}_${userInfo().username}`);

      const nonGitTags = await getTags(nonGit);
      expect(nonGitTags.canonical).toBe(`repo_non_git__${identity}`);
      expect(nonGitTags.projectId).toBe(identity);
      expect(nonGitTags.projectName).toBe("non-git");
      expect(nonGitTags.personalReads[1]).toBe(`user_project_${hash(nonGit)}`);
      expect(nonGitTags.personalReads).toContain(`codex_user_${userHash}`);
      expect(nonGitTags.personalReads).toContain(`opencode_user_${userHash}`);
      expect(nonGitTags.personalReads).toContain(`cursor_user_${cursorHash}`);
      expect(nonGitTags.projectReads[1]).toBe("repo_non_git");
      expect(nonGitTags.allReads).toEqual(
        unique([...nonGitTags.personalReads, ...nonGitTags.projectReads]),
      );

      const linkTags = await getTags(link);
      expect(linkTags.canonical).toBe(`repo_link_to_non_git__${identity}`);
      expect(linkTags.projectId).toBe(identity);
      expect(linkTags.projectName).toBe("link-to-non-git");
      expect(linkTags.personalReads[1]).toBe(`user_project_${hash(link)}`);
    } finally {
      temp.cleanup();
    }
  });

  test("isolates worktrees only when explicitly requested", async () => {
    const temp = tempRoot();
    try {
      const repo = makeRepo(temp.root, "worktree-repo", "https://github.com/Example/Repo.git");
      const worktree = join(temp.root, "worktree");
      git(repo, ["worktree", "add", "-q", worktree, "-b", "wt-branch"]);

      const shared = await getTags(worktree);
      expect(shared.canonical).toBe(`repo_repo__${hash("github.com/example/repo")}`);
      expect(shared.projectId).toBe(hash("github.com/example/repo"));

      process.env.SUPERMEMORY_ISOLATE_WORKTREES = "true";
      const isolated = await getTags(worktree);
      const json = realpathSync.native(worktree);
      expect(isolated.projectId).toBe(hash(`path:${json}`));
      expect(isolated.canonical).toBe(`repo_repo__${hash(`path:${json}`)}`);
      expect(isolated.canonical).not.toBe(shared.canonical);
      expect(isolated.projectName).toBe("Repo");
    } finally {
      temp.cleanup();
    }
  });

  test("honours Claude config and cursor overrides in read tag order", async () => {
    const temp = tempRoot();
    try {
      const claudeRepo = makeRepo(temp.root, "claude-repo", "git@github.com:Example/ClaudeRepo.git");
      mkdirSync(join(claudeRepo, ".claude", ".supermemory-claude"), { recursive: true });
      writeFileSync(
        join(claudeRepo, ".claude", ".supermemory-claude", "config.json"),
        JSON.stringify({
          repoContainerTag: "claude_repo_tag",
          personalContainerTag: "claude_personal_tag",
        }),
      );

      const claudeTags = await getTags(claudeRepo);
      expect(claudeTags.canonical).toBe("claude_repo_tag");
      expect(claudeTags.personalReads.slice(0, 3)).toEqual([
        "claude_repo_tag",
        `repo_clauderepo__${hash("github.com/example/clauderepo")}`,
        "claude_personal_tag",
      ]);

      const nonGit = join(temp.root, "cursor-dir");
      mkdirSync(nonGit, { recursive: true });
      process.env.SUPERMEMORY_USER_TAG = "explicit_user";
      process.env.SUPERMEMORY_PROJECT_TAG = "explicit_project";
      const cursorTags = await getTags(nonGit);
      expect(cursorTags.personalReads).toContain(`cursor_user_${hash("explicit_user")}`);
      expect(cursorTags.projectReads).toContain(`cursor_project_${hash("explicit_project")}`);
    } finally {
      temp.cleanup();
    }
  });

  test("probes git metadata at most once per resolution", async () => {
    const temp = tempRoot();
    try {
      const dir = makeRepo(temp.root, "count-repo", "https://github.com/Example/CountRepo.git");
      const fake = installFakeGit(
        temp.root,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"__LOG__\"\nexec \"__GIT__\" \"$@\"\n",
      );
      try {
        const tags = await getTags(dir);
        expect(tags.canonical).toBe(`repo_countrepo__${hash("github.com/example/countrepo")}`);
      } finally {
        fake.restore();
      }

      const calls = execFileSync("cat", [fake.logPath], { encoding: "utf-8" })
        .trim()
        .split("\n")
        .sort();
      expect(calls).toEqual(
        [
          "config user.email",
          "remote get-url origin",
          "rev-parse --git-common-dir",
          "rev-parse --show-toplevel",
        ].sort(),
      );
    } finally {
      temp.cleanup();
    }
  });

  test("keeps the event loop responsive while a real child Git process is awaited", async () => {
    const temp = tempRoot();
    try {
      const dir = makeRepo(temp.root, "slow-repo", "https://github.com/Example/SlowRepo.git");
      const fake = installFakeGit(
        temp.root,
        "#!/bin/sh\ntouch \"__MARKER__\"\nsleep 0.6\nexec \"__GIT__\" \"$@\"\n",
      );
      try {
        let resolved = false;
        const pending = getTags(dir).then((tags) => {
          resolved = true;
          return tags;
        });

        expect(await waitForFile(fake.markerPath, 2000)).toBe(true);
        expect(resolved).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(resolved).toBe(false);

        const tags = await pending;
        expect(tags.canonical).toBe(`repo_slowrepo__${hash("github.com/example/slowrepo")}`);
      } finally {
        fake.restore();
      }
    } finally {
      temp.cleanup();
    }
  });

  test("rejects on git timeout and does not poison the remote cache", async () => {
    const temp = tempRoot();
    try {
      const dir = makeRepo(temp.root, "timeout-repo", "https://github.com/Example/TimeoutRepo.git");
      const expected = `repo_timeoutrepo__${hash("github.com/example/timeoutrepo")}`;
      const fake = installFakeGit(
        temp.root,
        "#!/bin/sh\nif [ \"$1 $2\" = \"remote get-url\" ]; then exec sleep 5; fi\nexec \"__GIT__\" \"$@\"\n",
      );
      try {
        const started = Date.now();
        await expect(getTags(dir)).rejects.toBeInstanceOf(Error);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      } finally {
        fake.restore();
      }

      const recovered = await getTags(dir);
      expect(recovered.canonical).toBe(expected);
      expect(recovered.projectId).toBe(hash("github.com/example/timeoutrepo"));
    } finally {
      temp.cleanup();
    }
  });
});
