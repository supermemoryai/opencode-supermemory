import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SearchResponse } from "./client.js";
import { OPENING_PROMPT_TTL_MS, OpeningPromptIndex, RecallQueryCache } from "./local-dedupe.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "supermemory-dedupe-")), name);
}

const TASK =
  "Run the nightly migration task against the staging database, verify every table row count matches the snapshot taken before the run, then write a short report with any mismatches and the exact SQL you used.";

describe("local dedupe indexes", () => {
  test("sends a long opening prompt once per credential and container tag and keeps the owner session intact", () => {
    let scope: string | null = "backend-a:key-1";
    const file = tempFile("opening.json");
    const index = new OpeningPromptIndex(() => scope, file);
    const batch = [
      { role: "user" as const, content: TASK },
      { role: "assistant" as const, content: "Done." },
    ];

    const first = index.prepare("repo_a", "worker-1", batch);
    expect(first.messages).toEqual(batch);
    first.commit();

    expect(index.prepare("repo_a", "worker-1", batch).messages).toEqual(batch);
    const repeat = index.prepare("repo_a", "worker-2", [
      { role: "user", content: TASK.replace(" ", "   ") },
      { role: "assistant", content: "Done again." },
    ]);
    expect(repeat.messages[0]?.content).toMatch(/^\[Opening prompt omitted: .*sha256:[0-9a-f]{12}\)\]$/);
    expect(repeat.messages[1]).toEqual({ role: "assistant", content: "Done again." });
    expect(index.prepare("repo_b", "worker-3", batch).messages).toEqual(batch);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    scope = "backend-b:key-1";
    expect(index.prepare("repo_a", "worker-4", batch).messages).toEqual(batch);
    scope = null;
    const anonymous = index.prepare("repo_a", "worker-5", batch);
    expect(anonymous.messages).toEqual(batch);
    anonymous.commit();
    scope = "backend-a:key-1";
    expect(index.prepare("repo_a", "worker-6", batch).messages).not.toEqual(batch);
  });

  test("leaves short opening prompts and prompts captured over 24 hours ago untouched", () => {
    let now = 0;
    const index = new OpeningPromptIndex(() => "backend-a:key-1", tempFile("opening.json"), () => now);
    const short = [{ role: "user" as const, content: "fix the failing tests" }];
    index.prepare("repo_a", "worker-1", short).commit();
    expect(index.prepare("repo_a", "worker-2", short).messages).toEqual(short);

    const long = [{ role: "user" as const, content: TASK }];
    index.prepare("repo_a", "worker-1", long).commit();
    now = OPENING_PROMPT_TTL_MS - 1;
    expect(index.prepare("repo_a", "worker-2", long).messages).not.toEqual(long);
    now = OPENING_PROMPT_TTL_MS;
    const stale = index.prepare("repo_a", "worker-2", long);
    expect(stale.messages).toEqual(long);
    stale.commit();
    expect(index.prepare("repo_a", "worker-3", long).messages).not.toEqual(long);
  });

  test("an uncommitted capture does not mark the prompt as sent", () => {
    const index = new OpeningPromptIndex(() => "backend-a:key-1", tempFile("opening.json"));
    const batch = [{ role: "user" as const, content: TASK }];
    index.prepare("repo_a", "worker-1", batch);
    expect(index.prepare("repo_a", "worker-2", batch).messages).toEqual(batch);
  });

  test("re-serves a successful recall search per credential and tags within the window and retries failures", async () => {
    let now = 0;
    let scope: string | null = "backend-a:key-1";
    const file = tempFile("recall.json");
    const cache = new RecallQueryCache(() => scope, file, 1_000, () => now);
    const calls: string[] = [];
    let fail = false;
    const search = async (query: string): Promise<SearchResponse> => {
      calls.push(query);
      return fail
        ? { success: false, error: "unavailable" }
        : { success: true, results: [{ id: `m${calls.length}`, memory: "deploy with wrangler" }] };
    };
    const repoA = cache.wrap(["repo_a", "user_a"], search);

    const first = await repoA("How do we deploy?");
    now = 500;
    expect(await repoA("how do  we deploy?")).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await cache.wrap(["repo_b", "user_a"], search)("How do we deploy?");
    await repoA("How do we deploy to prod?");
    expect(calls).toHaveLength(3);
    now = 1_500;
    await repoA("How do we deploy?");
    expect(calls).toHaveLength(4);

    fail = true;
    expect((await repoA("What is pending?")).success).toBe(false);
    fail = false;
    expect((await repoA("What is pending?")).success).toBe(true);
    expect(calls).toHaveLength(6);

    scope = "backend-a:key-2";
    await repoA("What is pending?");
    expect(calls).toHaveLength(7);
    scope = "backend-a:key-1";
    await repoA("What is pending?");
    expect(calls).toHaveLength(7);
    scope = null;
    await repoA("What is pending?");
    await repoA("What is pending?");
    expect(calls).toHaveLength(9);
  });
});
