import { describe, expect, test } from "bun:test";

import { startAuthFlow } from "./auth.js";

describe("startAuthFlow", () => {
  test("keeps waiting for the callback when the browser cannot be opened", async () => {
    let authUrl = "";
    const flow = startAuthFlow(5_000, async (url) => {
      authUrl = url.toString();
      throw new Error("spawn xdg-open ENOENT");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const callback = new URL(new URL(authUrl).searchParams.get("callback")!);
    callback.searchParams.set("state", "wrong");
    const response = await fetch(callback);

    expect(response.status).toBe(403);
    expect(await flow).toEqual({ success: false, error: "Invalid auth state" });
  });
});
