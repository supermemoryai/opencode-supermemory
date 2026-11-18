import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGeneratedProjectTag,
  getProjectIdentity,
  normalizeGitRemote,
  sanitizeRepoName,
} from "./tags.js";

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

describe("local Git origin identity", () => {
  function repository(path: string, origin: string): void {
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "--quiet", path]);
    execFileSync("git", ["-C", path, "remote", "add", "origin", origin]);
    // Git itself must resolve the configured origin successfully.
    execFileSync("git", ["-C", path, "ls-remote", "origin"]);
  }

  test("relative and absolute origins for the same repository share identity", () => {
    const root = mkdtempSync(join(tmpdir(), "supermemory-local-origin-"));
    try {
      const upstream = join(root, "upstream.git");
      execFileSync("git", ["init", "--bare", "--quiet", upstream]);
      const relative = join(root, "relative");
      const absolute = join(root, "absolute");
      repository(relative, "../upstream.git");
      repository(absolute, upstream);
      expect(getProjectIdentity(relative)).toBe(getProjectIdentity(absolute));
      expect(getGeneratedProjectTag(relative)).toBe(
        getGeneratedProjectTag(absolute),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("identical relative origin strings in different roots stay isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "supermemory-local-origin-"));
    try {
      const projects = ["first", "second"].map((name) => {
        const parent = join(root, name);
        mkdirSync(parent);
        execFileSync("git", ["init", "--bare", "--quiet", join(parent, "upstream.git")]);
        const project = join(parent, "project");
        repository(project, "../upstream.git");
        return project;
      });
      expect(getProjectIdentity(projects[0]!)).not.toBe(
        getProjectIdentity(projects[1]!),
      );
      expect(getGeneratedProjectTag(projects[0]!)).not.toBe(
        getGeneratedProjectTag(projects[1]!),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
