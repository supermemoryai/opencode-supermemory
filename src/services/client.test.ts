import { expect, test } from "bun:test";
import { SupermemoryClient } from "./client.js";

test("recall stops searching legacy tags whose profile is empty", async () => {
  let searched: string[] = [];
  const probed: string[] = [];
  const memoryClient = new SupermemoryClient();
  (memoryClient as unknown as { client: unknown }).client = {
    search: {
      memories: async ({ containerTag }: { containerTag: string }) => {
        searched.push(containerTag);
        return { results: [], total: 0, timing: 0 };
      },
    },
    profile: async ({ containerTag }: { containerTag: string }) => {
      probed.push(containerTag);
      if (containerTag === "failed") throw new Error("unavailable");
      return {
        profile: { static: containerTag === "full" ? ["fact"] : [], dynamic: [] },
      };
    },
  };
  const recall = async () => {
    searched = [];
    await memoryClient.searchMemoriesForRecall(
      "query",
      "repo_app__1",
      ["repo_app__1", "empty", "full"],
      ["repo_app__1", "empty", "failed"],
    );
    await Bun.sleep(1);
    return searched.sort();
  };

  expect(await recall()).toEqual([
    "empty",
    "empty",
    "failed",
    "full",
    "repo_app__1",
    "repo_app__1",
  ]);
  expect(probed.sort()).toEqual(["empty", "failed", "full"]);
  expect(await recall()).toEqual([
    "failed",
    "full",
    "repo_app__1",
    "repo_app__1",
  ]);
  expect(probed.sort()).toEqual(["empty", "failed", "failed", "full"]);
});
