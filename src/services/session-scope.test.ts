import { describe, expect, test } from "bun:test";

import {
  getProcessSkipReason,
  isHeadlessCommand,
  SessionScope,
  type SessionScopeConfig,
} from "./session-scope.js";

const defaults: SessionScopeConfig = {
  captureSubagents: false,
  captureHeadless: false,
  captureOrchestrated: true,
};

describe("session scope", () => {
  test("detects OpenCode V1 headless commands from the host argv", () => {
    const argv = (...args: string[]) => ["bun", "/$bunfs/root/opencode", ...args];
    expect(isHeadlessCommand(argv("run", "fix the bug"))).toBe(true);
    expect(isHeadlessCommand(argv("--log-level", "INFO", "run", "hi"))).toBe(true);
    expect(isHeadlessCommand(argv("--print-logs", "run"))).toBe(true);
    expect(isHeadlessCommand(argv("github", "run"))).toBe(true);
    expect(isHeadlessCommand(argv())).toBe(false);
    expect(isHeadlessCommand(argv("./project"))).toBe(false);
    expect(isHeadlessCommand(argv("serve"))).toBe(false);
    expect(isHeadlessCommand(argv("github", "install"))).toBe(false);
  });

  test("orchestrated sessions count as interactive unless opted out", () => {
    const conductor = { CONDUCTOR_WORKSPACE_PATH: "/w/tokyo" };
    expect(getProcessSkipReason({ config: defaults, headless: true, env: {} })).toBe("headless");
    expect(getProcessSkipReason({ config: defaults, headless: true, env: conductor })).toBeNull();
    expect(
      getProcessSkipReason({ config: { ...defaults, captureHeadless: true }, headless: true, env: {} }),
    ).toBeNull();
    expect(
      getProcessSkipReason({
        config: { ...defaults, captureOrchestrated: false },
        headless: false,
        env: { VK_WORKSPACE_ID: "ws" },
      }),
    ).toBe("orchestrated");
  });

  test("skips child sessions unless captureSubagents is set", async () => {
    const lookups: string[] = [];
    const parents: Record<string, string | undefined> = { child: "root" };
    const lookupParent = async (id: string) => {
      lookups.push(id);
      if (id === "broken") throw new Error("unavailable");
      return parents[id];
    };
    const scope = new SessionScope({ lookupParent, headless: false, config: defaults, env: {} });

    expect(await scope.skipReason("root")).toBeNull();
    expect(await scope.skipReason("child")).toBe("subagent");
    expect(await scope.skipReason("child")).toBe("subagent");
    scope.note("noted", "root");
    expect(await scope.skipReason("noted")).toBe("subagent");
    expect(await scope.skipReason("broken")).toBeNull();
    expect(lookups).toEqual(["root", "child", "broken"]);

    const optedIn = new SessionScope({
      lookupParent,
      headless: true,
      config: { ...defaults, captureSubagents: true, captureHeadless: true },
      env: {},
    });
    expect(await optedIn.skipReason("child")).toBeNull();
  });
});
