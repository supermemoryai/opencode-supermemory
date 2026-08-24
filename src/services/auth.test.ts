import { describe, expect, test } from "bun:test";
import { buildAuthUrl } from "./auth.js";

const CALLBACK_URL =
  "http://127.0.0.1:43210/callback?state=expected-state";

describe("authentication URL modes", () => {
  test("normal login does not request explicit organization switching", () => {
    const authUrl = new URL(buildAuthUrl(CALLBACK_URL));

    expect(authUrl.searchParams.get("callback")).toBe(CALLBACK_URL);
    expect(authUrl.searchParams.get("client")).toBe("opencode");
    expect(authUrl.searchParams.has("mode")).toBe(false);
  });

  test("organization switching requests the explicit switch mode", () => {
    const authUrl = new URL(
      buildAuthUrl(CALLBACK_URL, { mode: "switch_organization" }),
    );

    expect(authUrl.searchParams.get("callback")).toBe(CALLBACK_URL);
    expect(authUrl.searchParams.get("mode")).toBe("switch_organization");
  });
});
