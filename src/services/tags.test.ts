import { describe, expect, test } from "bun:test";
import { normalizeGitRemote, sanitizeRepoName } from "./tags.js";

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
