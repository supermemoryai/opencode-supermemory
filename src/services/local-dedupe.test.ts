import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpeningPromptIndex, RecallQueryIndex } from "./local-dedupe.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "supermemory-dedupe-")), name);
}

describe("local dedupe indexes", () => {
  test("sends an opening prompt once per container tag and keeps the owner session intact", () => {
    const index = new OpeningPromptIndex(tempFile("opening.json"));
    const batch = [
      { role: "user" as const, content: "Run the nightly migration task" },
      { role: "assistant" as const, content: "Done." },
    ];

    const first = index.prepare("repo_a", "worker-1", batch);
    expect(first.messages).toEqual(batch);
    first.commit();

    expect(index.prepare("repo_a", "worker-1", batch).messages).toEqual(batch);
    const repeat = index.prepare("repo_a", "worker-2", [
      { role: "user", content: "Run the nightly   migration task" },
      { role: "assistant", content: "Done again." },
    ]);
    expect(repeat.messages[0]?.content).toMatch(/^\[Opening prompt omitted: .*sha256:[0-9a-f]{12}\)\]$/);
    expect(repeat.messages[1]).toEqual({ role: "assistant", content: "Done again." });
    expect(index.prepare("repo_b", "worker-3", batch).messages).toEqual(batch);
  });

  test("an uncommitted capture does not mark the prompt as sent", () => {
    const index = new OpeningPromptIndex(tempFile("opening.json"));
    const batch = [{ role: "user" as const, content: "same task" }];
    index.prepare("repo_a", "worker-1", batch);
    expect(index.prepare("repo_a", "worker-2", batch).messages).toEqual(batch);
  });

  test("skips exact recall query repeats per tag within the window", () => {
    const index = new RecallQueryIndex(tempFile("recall.json"), 1_000);
    expect(index.isRepeat("repo_a", "How do we deploy?", 0)).toBe(false);
    expect(index.isRepeat("repo_a", "how do  we deploy?", 500)).toBe(true);
    expect(index.isRepeat("repo_b", "How do we deploy?", 500)).toBe(false);
    expect(index.isRepeat("repo_a", "How do we deploy to prod?", 500)).toBe(false);
    expect(index.isRepeat("repo_a", "How do we deploy?", 1_500)).toBe(false);
  });
});
